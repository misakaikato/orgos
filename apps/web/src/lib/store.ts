"use client";

/**
 * 前端唯一的会话状态：本人、通讯录、会话摘要、已加载会话的事件。
 * 组件经 useStore(selector) 订阅；写入只经本文件导出的动作。
 */
import type {
	ConversationSummary,
	DirectoryResponse,
	Event,
	MeResponse,
	PrincipalStatus,
	WorkItem,
} from "@orgos/protocol";
import { useSyncExternalStore } from "react";
import { ApiError, api, fetchEventsAfter } from "@/lib/api";
import {
	applyEventToSummaries,
	maxSeq,
	mergeEvents,
	reconcileRead,
} from "@/lib/events";

export type SessionStatus =
	| "loading"
	| "ready"
	| "error"
	| "unauthorized"
	| "not-onboarded";
export type LoadStatus = "loading" | "ready" | "error";
export type ConnectionState = "connecting" | "open" | "reconnecting";
export type Person = DirectoryResponse["people"][number];

export type State = {
	session: SessionStatus;
	sessionError: string | null;
	me: MeResponse | null;
	directory: Person[];
	conversations: ConversationSummary[];
	events: Record<string, Event[]>;
	eventsStatus: Record<string, LoadStatus>;
	/** 已上报给服务端的已读位置。 */
	reportedRead: Record<string, number>;
	/** 正在查看且停在底部的会话：新消息直接算已读。 */
	activeId: string | null;
	connection: ConnectionState;
	/** 我是处理人、仍未处理的待办（null = 还没加载过）。 */
	workItems: WorkItem[] | null;
	workItemsStatus: LoadStatus | null;
};

const initialState: State = {
	session: "loading",
	sessionError: null,
	me: null,
	directory: [],
	conversations: [],
	events: {},
	eventsStatus: {},
	reportedRead: {},
	activeId: null,
	connection: "connecting",
	workItems: null,
	workItemsStatus: null,
};

let state = initialState;
const listeners = new Set<() => void>();

function set(patch: Partial<State> | ((s: State) => Partial<State>)): void {
	const next = typeof patch === "function" ? patch(state) : patch;
	state = { ...state, ...next };
	for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getState(): State {
	return state;
}

export function useStore<T>(selector: (s: State) => T): T {
	return useSyncExternalStore(
		subscribe,
		() => selector(state),
		() => selector(initialState),
	);
}

function messageOf(e: unknown): string {
	return e instanceof Error ? e.message : "未知错误";
}

// ─────────────────────────── 会话级 ───────────────────────────

let sessionLoad: Promise<void> | null = null;

/** 加载本人、通讯录与会话列表；并发调用共用同一次加载。 */
export function loadSession(): Promise<void> {
	sessionLoad ??= doLoadSession().finally(() => {
		sessionLoad = null;
	});
	return sessionLoad;
}

async function doLoadSession(): Promise<void> {
	set({ session: "loading", sessionError: null });
	try {
		const [me, directory, list] = await Promise.all([
			api.me(),
			api.directory(),
			api.conversations(),
		]);
		set({ me, directory: directory.people });
		applyConversationList(list.items);
		set({ session: "ready" });
	} catch (e) {
		if (e instanceof ApiError && e.status === 401) {
			set({ session: "unauthorized" });
		} else if (e instanceof ApiError && e.code === "NOT_ONBOARDED") {
			set({ session: "not-onboarded" });
		} else {
			set({ session: "error", sessionError: messageOf(e) });
		}
	}
}

export function resetSession(): void {
	state = initialState;
	for (const l of listeners) l();
}

export function markUnauthorized(): void {
	set({ session: "unauthorized" });
}

export function markNotOnboarded(): void {
	set({ session: "not-onboarded" });
}

export function setConnection(connection: ConnectionState): void {
	if (state.connection !== connection) set({ connection });
}

/**
 * 采用服务端的会话列表。列表快照可能早于本地的已读上报，已读位置以两者中较新的为准。
 */
function applyConversationList(items: ConversationSummary[]): void {
	set((s) => {
		const meId = s.me?.principal.id ?? "";
		const conversations = reconcileRead(items, s.reportedRead, s.events, meId);
		return {
			conversations,
			reportedRead: Object.fromEntries(
				conversations.map((x) => [x.conversation.id, x.lastReadSeq ?? 0]),
			),
		};
	});
}

export async function refreshConversations(): Promise<void> {
	const list = await api.conversations();
	applyConversationList(list.items);
}

// ─────────────────────────── 事件 ───────────────────────────

export async function loadEvents(conversationId: string): Promise<void> {
	set((s) => ({
		eventsStatus: { ...s.eventsStatus, [conversationId]: "loading" },
	}));
	try {
		const items = await fetchEventsAfter(conversationId, 0);
		set((s) => ({
			events: {
				...s.events,
				[conversationId]: mergeEvents(s.events[conversationId] ?? [], items),
			},
			eventsStatus: { ...s.eventsStatus, [conversationId]: "ready" },
		}));
	} catch {
		set((s) => ({
			eventsStatus: { ...s.eventsStatus, [conversationId]: "error" },
		}));
	}
}

/** 首次进入会话时加载；已加载或正在加载则跳过。 */
export function ensureEvents(conversationId: string): void {
	const status = state.eventsStatus[conversationId];
	if (status === "ready" || status === "loading") return;
	void loadEvents(conversationId);
}

function mergeInto(conversationId: string, incoming: Event[]): void {
	set((s) => {
		const current = s.events[conversationId];
		if (!current) return {};
		const merged = mergeEvents(current, incoming);
		return merged === current
			? {}
			: { events: { ...s.events, [conversationId]: merged } };
	});
}

// ─────────────────────────── 待办 ───────────────────────────

let workItemsLoad: Promise<void> | null = null;

/** 拉取我的未处理待办；并发调用共用同一次请求。 */
export function loadWorkItems(): Promise<void> {
	workItemsLoad ??= doLoadWorkItems().finally(() => {
		workItemsLoad = null;
	});
	return workItemsLoad;
}

async function doLoadWorkItems(): Promise<void> {
	set((s) => ({
		workItemsStatus: s.workItems ? s.workItemsStatus : "loading",
	}));
	try {
		const { items } = await api.workItems("open");
		set({ workItems: items, workItemsStatus: "ready" });
	} catch {
		set((s) => ({ workItemsStatus: s.workItems ? "ready" : "error" }));
	}
}

/** 会产生或了结待办的事件类型：收到时重拉待办。 */
const WORK_ITEM_EVENTS: ReadonlySet<Event["type"]> = new Set([
	"escalation.created",
	"escalation.resolved",
	"negotiation.ended",
	"confirmation.resolved",
]);

/** 只发生在协商会话里的事件：协商会话不在会话列表中，由私聊里的协商卡片读取。 */
const NEGOTIATION_EVENTS: ReadonlySet<Event["type"]> = new Set([
	"negotiation.step",
	"negotiation.ended",
	"confirmation.resolved",
]);

/** WS 推来的事件：并入已加载的事件列表与会话摘要；未知会话或成员变化时重拉列表。 */
export function applyEvent(event: Event): void {
	const cid = event.conversationId;
	const meId = state.me?.principal.id;
	if (!cid || !meId) return;
	mergeInto(cid, [event]);
	if (WORK_ITEM_EVENTS.has(event.type)) void loadWorkItems();
	if (NEGOTIATION_EVENTS.has(event.type)) return;
	const read = state.activeId === cid;
	const next = applyEventToSummaries(state.conversations, event, meId, read);
	if (next === null || event.type === "member.joined") {
		void refreshConversations();
		return;
	}
	if (next !== state.conversations) set({ conversations: next });
}

/** 断线重连后：重拉通讯录（在线状态）与会话列表，并按已知最大 seq 补齐每个已加载的会话。 */
export async function resync(): Promise<void> {
	const [directory] = await Promise.all([
		api.directory(),
		refreshConversations(),
	]);
	set({ directory: directory.people });
	const mine = directory.people.find(
		(p) => p.principal.id === state.me?.principal.id,
	);
	if (mine?.principal.status)
		applyPresence(mine.principal.id, mine.principal.status);
	void loadWorkItems();
	const loaded = Object.entries(state.events);
	await Promise.all(
		loaded.map(async ([cid, list]) => {
			const items = await fetchEventsAfter(cid, maxSeq(list));
			mergeInto(cid, items);
		}),
	);
}

// ─────────────────────────── 动作 ───────────────────────────

export async function sendMessage(
	conversationId: string,
	text: string,
	mentions: string[],
	askTwin = false,
): Promise<void> {
	const { event } = await api.postMessage(conversationId, {
		text,
		mentions,
		...(askTwin ? { askTwin } : {}),
	});
	applyEvent(event);
}

/** 某人的在线状态变了：通讯录与本人是人的状态的来源（主体查找表以它们为准）。 */
export function applyPresence(
	principalId: string,
	status: PrincipalStatus,
): void {
	set((s) => ({
		directory: s.directory.map((p) =>
			p.principal.id === principalId
				? { ...p, principal: { ...p.principal, status } }
				: p,
		),
		me:
			s.me && s.me.principal.id === principalId
				? { ...s.me, principal: { ...s.me.principal, status } }
				: s.me,
	}));
}

export async function setMyStatus(status: PrincipalStatus): Promise<void> {
	const { principal } = await api.updateStatus({ status });
	if (principal.status) applyPresence(principal.id, principal.status);
}

export function setActiveConversation(conversationId: string | null): void {
	if (state.activeId !== conversationId) set({ activeId: conversationId });
}

/** 把会话已读位置推进到已加载的最大 seq（只在有进展时上报）。 */
export async function markRead(conversationId: string): Promise<void> {
	const seq = maxSeq(state.events[conversationId] ?? []);
	if (seq <= (state.reportedRead[conversationId] ?? 0)) return;
	set((s) => ({
		reportedRead: { ...s.reportedRead, [conversationId]: seq },
		conversations: s.conversations.map((x) =>
			x.conversation.id === conversationId
				? { ...x, unread: 0, lastReadSeq: seq }
				: x,
		),
	}));
	await api.markRead(conversationId, seq);
}

export async function openDm(withPrincipalId: string): Promise<string> {
	const { conversation } = await api.createConversation({
		kind: "dm",
		withPrincipalId,
	});
	await refreshConversations();
	return conversation.id;
}

export async function createGroup(
	title: string,
	memberIds: string[],
): Promise<string> {
	const { conversation } = await api.createConversation({
		kind: "group",
		title,
		memberIds,
	});
	await refreshConversations();
	return conversation.id;
}

export async function addMember(
	conversationId: string,
	principalId: string,
): Promise<void> {
	await api.addMember(conversationId, { principalId });
	await refreshConversations();
}
