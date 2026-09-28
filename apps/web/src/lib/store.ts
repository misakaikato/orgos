"use client";

/**
 * 前端唯一的会话状态：本人、通讯录、会话摘要、已加载会话的事件。
 * 组件经 useStore(selector) 订阅；写入只经本文件导出的动作。
 */
import type {
	Agent,
	BrowserFrame,
	ConversationSummary,
	DirectoryResponse,
	Event,
	MeResponse,
	OrgUnit,
	Principal,
	PrincipalStatus,
	ResolveWorkItemRequest,
	Runner,
	Task,
	TenantSettings,
	Topic,
	TopicToGroupRequest,
	UpdateTenantSettingsRequest,
	WorkItem,
} from "@orgos/protocol";
import { useSyncExternalStore } from "react";
import {
	type ActivityMap,
	applyDraftFrame,
	applyStatusFrame,
	clearAgentActivity,
} from "@/lib/activity";
import { ApiError, api, fetchEventsAfter } from "@/lib/api";
import {
	desktopBridge,
	onLocalRunnerEnabled,
	syncDesktop,
	syncLocalRunner,
} from "@/lib/desktop";
import {
	applyEventToSummaries,
	maxSeq,
	mergeEvents,
	reconcileRead,
} from "@/lib/events";
import { maxSeqIn, upsertTopic, withTaskState } from "@/lib/topics";

export type SessionStatus =
	| "loading"
	| "ready"
	| "error"
	| "unauthorized"
	| "not-onboarded";
export type LoadStatus = "loading" | "ready" | "error";
export type ConnectionState = "connecting" | "open" | "reconnecting";
export type Person = DirectoryResponse["people"][number];
/** 一个任务与它的执行者（执行者未必在交办所在的会话里）。 */
export type TaskView = { task: Task; assignee?: Principal };

export type State = {
	session: SessionStatus;
	sessionError: string | null;
	me: MeResponse | null;
	directory: Person[];
	/** 组织结构：全部单元（通讯录的组织树、单元分身的"代谁"）。 */
	org: OrgUnit[];
	conversations: ConversationSummary[];
	/** 已加载的事件，按会话（含该会话已加载的各话题），按 seq 升序。 */
	events: Record<string, Event[]>;
	/** 各话题事件的加载状态，按话题 id。 */
	eventsStatus: Record<string, LoadStatus>;
	/** 会话的话题（主线在前），按会话。 */
	topics: Record<string, Topic[]>;
	topicsStatus: Record<string, LoadStatus>;
	/** 各话题我已看到的最大 seq（话题栏的未读点）。 */
	topicSeen: Record<string, number>;
	/** 已上报给服务端的已读位置。 */
	reportedRead: Record<string, number>;
	/** 正在查看且停在底部的会话：新消息直接算已读。 */
	activeId: string | null;
	connection: ConnectionState;
	/** 我是处理人、仍未处理的待办（null = 还没加载过）。 */
	workItems: WorkItem[] | null;
	workItemsStatus: LoadStatus | null;
	/** 正在工作的代理（状态行与流式草稿），按会话、按代理。 */
	activity: ActivityMap;
	/** 我的设备（null = 还没加载过）。 */
	runners: Runner[] | null;
	runnersStatus: LoadStatus | null;
	/** 页面在桌面客户端里时，本机在当前服务器上的设备 id（设备页标"本机"）。 */
	localRunnerId: string | null;
	/** 已加载的任务（卡片与输入框上方的任务条读取），按任务 id。 */
	tasks: Record<string, TaskView>;
	tasksStatus: Record<string, LoadStatus>;
	/** 租户设置（null = 还没加载过）。 */
	tenantSettings: TenantSettings | null;
};

const initialState: State = {
	session: "loading",
	sessionError: null,
	me: null,
	directory: [],
	org: [],
	conversations: [],
	events: {},
	eventsStatus: {},
	topics: {},
	topicsStatus: {},
	topicSeen: {},
	reportedRead: {},
	activeId: null,
	connection: "connecting",
	workItems: null,
	workItemsStatus: null,
	activity: {},
	runners: null,
	runnersStatus: null,
	localRunnerId: null,
	tasks: {},
	tasksStatus: {},
	tenantSettings: null,
};

let state = initialState;
const listeners = new Set<() => void>([() => syncDesktop(state)]);

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
		const [me, directory, list, org] = await Promise.all([
			api.me(),
			api.directory(),
			api.conversations(),
			api.org(),
		]);
		set({ me, directory: directory.people, org: org.units });
		applyConversationList(list.items);
		set({ session: "ready" });
		void checkLocalRunner();
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

/** 重拉组织结构（单元页改了章程、名称或成员之后）。 */
export async function loadOrg(): Promise<void> {
	set({ org: (await api.org()).units });
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

// ─────────────────────────── 话题 ───────────────────────────

export async function loadTopics(conversationId: string): Promise<void> {
	set((s) => ({
		topicsStatus: {
			...s.topicsStatus,
			[conversationId]: s.topics[conversationId] ? "ready" : "loading",
		},
	}));
	try {
		const { items } = await api.topics(conversationId);
		set((s) => ({
			topics: { ...s.topics, [conversationId]: items },
			topicsStatus: { ...s.topicsStatus, [conversationId]: "ready" },
		}));
	} catch {
		set((s) => ({
			topicsStatus: {
				...s.topicsStatus,
				[conversationId]: s.topics[conversationId] ? "ready" : "error",
			},
		}));
	}
}

/** 首次进入会话时加载话题；已加载或正在加载则跳过。 */
export function ensureTopics(conversationId: string): void {
	const status = state.topicsStatus[conversationId];
	if (status === "ready" || status === "loading") return;
	void loadTopics(conversationId);
}

/** 话题新建或变化（WS 推送或操作的返回）：并入已加载的话题列表。 */
export function applyTopic(topic: Topic): void {
	set((s) => {
		const list = s.topics[topic.conversationId];
		if (!list) return {};
		return {
			topics: { ...s.topics, [topic.conversationId]: upsertTopic(list, topic) },
		};
	});
}

export async function createTopic(
	conversationId: string,
	title: string,
): Promise<Topic> {
	const { topic } = await api.createTopic(conversationId, title);
	applyTopic(topic);
	return topic;
}

export async function renameTopic(id: string, title: string): Promise<void> {
	const { topic } = await api.updateTopic(id, { title });
	applyTopic(topic);
}

export async function archiveTopic(id: string): Promise<void> {
	const { topic } = await api.updateTopic(id, { archived: true });
	applyTopic(topic);
}

/** "转为任务"：给了目标时它作为我的消息发出，代理随即开始。 */
export async function topicToTask(
	conversationId: string,
	topicId: string,
	goal?: string,
): Promise<void> {
	const { task, assignee } = await api.topicToTask(topicId, goal);
	applyTask(task, assignee);
	await Promise.all([
		loadTopics(conversationId),
		catchUp(conversationId, topicId),
	]);
}

/** "转成群聊"：返回新群的 id。 */
export async function topicToGroup(
	conversationId: string,
	topicId: string,
	req: TopicToGroupRequest,
): Promise<string> {
	const { conversation } = await api.topicToGroup(topicId, req);
	await Promise.all([
		refreshConversations(),
		loadTopics(conversationId),
		catchUp(conversationId, topicId),
	]);
	return conversation.id;
}

/** 记下我在某话题已看到的位置（只前进）。 */
export function markTopicSeen(topicId: string, seq: number): void {
	if (seq <= (state.topicSeen[topicId] ?? 0)) return;
	set((s) => ({ topicSeen: { ...s.topicSeen, [topicId]: seq } }));
}

// ─────────────────────────── 事件 ───────────────────────────

/**
 * 加载某话题的事件（并入该会话已加载的事件）。不给话题即主线——协商会话只有主线，
 * 协商卡片按会话 id 读取它的全部事件。加载状态按话题 id（不给时按会话 id）记。
 */
export async function loadEvents(
	conversationId: string,
	topicId?: string,
): Promise<void> {
	const key = topicId ?? conversationId;
	set((s) => ({
		eventsStatus: { ...s.eventsStatus, [key]: "loading" },
	}));
	try {
		const items = await fetchEventsAfter(conversationId, topicId, 0);
		set((s) => ({
			events: {
				...s.events,
				[conversationId]: mergeEvents(s.events[conversationId] ?? [], items),
			},
			eventsStatus: { ...s.eventsStatus, [key]: "ready" },
		}));
	} catch {
		set((s) => ({
			eventsStatus: { ...s.eventsStatus, [key]: "error" },
		}));
	}
}

/** 首次打开话题（或协商卡片）时加载事件；已加载或正在加载则跳过。 */
export function ensureEvents(conversationId: string, topicId?: string): void {
	const status = state.eventsStatus[topicId ?? conversationId];
	if (status === "ready" || status === "loading") return;
	void loadEvents(conversationId, topicId);
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

/** 补读某个已加载话题在已知位置之后的事件。 */
async function catchUp(conversationId: string, topicId: string): Promise<void> {
	if (state.eventsStatus[topicId] !== "ready") return;
	const after = maxSeqIn(state.events[conversationId] ?? [], topicId);
	mergeInto(
		conversationId,
		await fetchEventsAfter(conversationId, topicId, after),
	);
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
	"approval.requested",
	"approval.resolved",
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
	const topicId = event.topicId;
	if (topicId) {
		set((s) => {
			const list = s.topics[cid];
			const topic = list?.find((t) => t.id === topicId);
			if (!list) return {};
			if (!topic) {
				void loadTopics(cid);
				return {};
			}
			return {
				topics: {
					...s.topics,
					[cid]: upsertTopic(list, { ...topic, lastEventAt: event.createdAt }),
				},
			};
		});
	}
	if (event.type === "message.posted" && event.onBehalfOfId) {
		const activity = clearAgentActivity(
			state.activity,
			cid,
			event.actorId,
			event.topicId,
		);
		if (activity !== state.activity) set({ activity });
	}
	if (WORK_ITEM_EVENTS.has(event.type)) void loadWorkItems();
	if (NEGOTIATION_EVENTS.has(event.type)) return;
	const read = state.activeId === cid;
	const next = applyEventToSummaries(state.conversations, event, meId, read);
	if (
		next === null ||
		event.type === "member.joined" ||
		event.type === "member.left"
	) {
		void refreshConversations();
		return;
	}
	if (next !== state.conversations) set({ conversations: next });
}

/** 代理运行的 draft / status 帧。 */
export function applyAgentFrame(
	frame: Extract<BrowserFrame, { t: "draft" | "status" }>,
): void {
	set((s) => ({
		activity:
			frame.t === "draft"
				? applyDraftFrame(s.activity, frame)
				: applyStatusFrame(s.activity, frame),
	}));
}

/** 我的待办新增或变化：open 的并入列表，其余移出。 */
export function applyWorkItem(item: WorkItem): void {
	set((s) => {
		if (!s.workItems) return {};
		const rest = s.workItems.filter((w) => w.id !== item.id);
		return {
			workItems: item.status === "open" ? [item, ...rest] : rest,
		};
	});
}

/**
 * 断线重连后：重拉通讯录（在线状态）与会话列表，并按已知最大 seq 补齐每个已加载的会话。
 * 断线期间的运行状态无从得知，先清空；仍在运行的代理会继续推 status 帧。
 */
export async function resync(): Promise<void> {
	set({ activity: {} });
	const [directory, org] = await Promise.all([
		api.directory(),
		api.org(),
		refreshConversations(),
	]);
	set({ directory: directory.people, org: org.units });
	const mine = directory.people.find(
		(p) => p.principal.id === state.me?.principal.id,
	);
	if (mine?.principal.status)
		applyPresence(mine.principal.id, mine.principal.status);
	void loadWorkItems();
	if (state.runners) void loadRunners();
	for (const id of Object.keys(state.tasks)) void loadTask(id);
	const loadedConversations = Object.keys(state.topics);
	await Promise.all(loadedConversations.map((cid) => loadTopics(cid)));
	// 按会话 id 加载的（协商会话）：补读主线。
	const byConversation = Object.keys(state.events).filter(
		(cid) => !state.topics[cid] && state.eventsStatus[cid] === "ready",
	);
	await Promise.all([
		...loadedConversations.flatMap((cid) =>
			(state.topics[cid] ?? []).map((t) => catchUp(cid, t.id)),
		),
		...byConversation.map(async (cid) =>
			mergeInto(
				cid,
				await fetchEventsAfter(cid, undefined, maxSeq(state.events[cid] ?? [])),
			),
		),
	]);
}

// ─────────────────────────── 任务 ───────────────────────────

export async function loadTask(id: string): Promise<void> {
	set((s) => ({
		tasksStatus: {
			...s.tasksStatus,
			[id]: s.tasks[id] ? "ready" : "loading",
		},
	}));
	try {
		const view = await api.task(id);
		set((s) => ({
			tasks: { ...s.tasks, [id]: view },
			tasksStatus: { ...s.tasksStatus, [id]: "ready" },
		}));
	} catch {
		set((s) => ({
			tasksStatus: { ...s.tasksStatus, [id]: s.tasks[id] ? "ready" : "error" },
		}));
	}
}

/** 卡片首次出现时加载任务；已加载或正在加载则跳过。 */
export function ensureTask(id: string): void {
	const status = state.tasksStatus[id];
	if (status === "ready" || status === "loading") return;
	void loadTask(id);
}

/** 任务有变化（WS 推送或操作的返回）：并入已知的任务（保留执行者），并更新其话题的状态点。 */
export function applyTask(task: Task, assignee?: Principal): void {
	set((s) => {
		const known = s.tasks[task.id];
		if (known && known.task.updatedAt > task.updatedAt) return {};
		const list = s.topics[task.conversationId];
		return {
			tasks: {
				...s.tasks,
				[task.id]: { task, assignee: assignee ?? known?.assignee },
			},
			tasksStatus: { ...s.tasksStatus, [task.id]: "ready" },
			...(list
				? {
						topics: {
							...s.topics,
							[task.conversationId]: withTaskState(list, task),
						},
					}
				: {}),
		};
	});
}

export async function completeTask(id: string): Promise<void> {
	const { task, assignee } = await api.completeTask(id);
	applyTask(task, assignee);
}

export async function cancelTask(id: string): Promise<void> {
	const { task, assignee } = await api.cancelTask(id);
	applyTask(task, assignee);
}

/** "新任务"：新开一个任务话题（目标作为我的第一条消息）；返回话题 id。 */
export async function startNewTask(
	conversationId: string,
	goal: string,
): Promise<string> {
	const { task, assignee } = await api.createTask({ conversationId, goal });
	await loadTopics(conversationId);
	applyTask(task, assignee);
	return task.topicId ?? "";
}

// ─────────────────────────── 租户设置 ───────────────────────────

export async function loadTenantSettings(): Promise<void> {
	const { settings } = await api.tenantSettings();
	set({ tenantSettings: settings });
}

/** 改租户设置（仅 owner）；服务端返回的整份设置写回 store。 */
export async function updateTenantSettings(
	patch: UpdateTenantSettingsRequest,
): Promise<TenantSettings> {
	const { settings } = await api.updateTenantSettings(patch);
	set({ tenantSettings: settings });
	return settings;
}

export async function setAllowUnsupervisedAdapters(
	allow: boolean,
): Promise<void> {
	await updateTenantSettings({ allowUnsupervisedAdapters: allow });
}

// ─────────────────────────── 设备 ───────────────────────────

let runnersLoad: Promise<void> | null = null;

/** 拉取我的设备；并发调用共用同一次请求。 */
export function loadRunners(): Promise<void> {
	runnersLoad ??= doLoadRunners().finally(() => {
		runnersLoad = null;
	});
	return runnersLoad;
}

async function fetchRunners(): Promise<Runner[]> {
	const { items } = await api.runners();
	set({ runners: items, runnersStatus: "ready" });
	return items;
}

async function doLoadRunners(): Promise<void> {
	set((s) => ({ runnersStatus: s.runners ? s.runnersStatus : "loading" }));
	try {
		await fetchRunners();
	} catch {
		set((s) => ({ runnersStatus: s.runners ? "ready" : "error" }));
	}
}

let localRunnerCheck: Promise<void> | null = null;

/**
 * 页面在桌面客户端里时：需要的话把本机配对到当前账号，并记下本机的设备 id。
 * 并发调用共用同一次检查；失败留到下次登录、进入设备页或重新打开开关时再试。
 */
export function checkLocalRunner(): Promise<void> {
	if (!desktopBridge()) return Promise.resolve();
	onLocalRunnerEnabled(() => void checkLocalRunner());
	localRunnerCheck ??= doCheckLocalRunner().finally(() => {
		localRunnerCheck = null;
	});
	return localRunnerCheck;
}

async function doCheckLocalRunner(): Promise<void> {
	if (state.session !== "ready") return;
	try {
		const localRunnerId = await syncLocalRunner({
			bridge: desktopBridge(),
			origin: window.location.origin,
			myRunnerIds: async () => (await fetchRunners()).map((r) => r.id),
			createPairingCode: async () => (await api.createPairingCode()).code,
		});
		set({ localRunnerId });
	} catch (e) {
		console.warn("本机 Runner 自动配对失败：", messageOf(e));
	}
}

/**
 * 我的设备新增、上下线或被吊销：并入列表（吊销的移出）。
 * 吊销会解绑代理，随即刷新本人的代理组。
 */
export function applyRunner(runner: Runner): void {
	set((s) => {
		if (!s.runners) return {};
		const rest = s.runners.filter((r) => r.id !== runner.id);
		if (runner.revoked) return { runners: rest };
		const known = s.runners.some((r) => r.id === runner.id);
		return {
			runners: known
				? s.runners.map((r) => (r.id === runner.id ? runner : r))
				: [...rest, runner],
		};
	});
	if (runner.revoked) void refreshMyAgents().catch(() => {});
}

export async function revokeRunner(id: string): Promise<void> {
	await api.revokeRunner(id);
	set((s) => ({ runners: s.runners?.filter((r) => r.id !== id) ?? null }));
	await refreshMyAgents();
}

// ─────────────────────────── 动作 ───────────────────────────

export async function sendMessage(
	conversationId: string,
	topicId: string,
	text: string,
	mentions: string[],
	askTwin = false,
): Promise<void> {
	const { event } = await api.postMessage(conversationId, {
		text,
		mentions,
		topicId,
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

/** 处理一条待办：处理结果立即并入待办列表（会话里的卡片随 escalation.resolved 事件更新）。 */
export async function resolveWorkItem(
	id: string,
	req: ResolveWorkItemRequest,
): Promise<void> {
	const { workItem } = await api.resolveWorkItem(id, req);
	applyWorkItem(workItem);
}

/** 中止话题里正在运行的代理。 */
export async function stopAgents(
	conversationId: string,
	topicId: string,
): Promise<void> {
	await api.stop(conversationId, topicId);
}

/** 代理组有变化（新建、改资料、删除）后刷新本人的代理列表。 */
export function setMyAgents(agents: Agent[]): void {
	set((s) => (s.me ? { me: { ...s.me, agents } } : {}));
}

export async function refreshMyAgents(): Promise<Agent[]> {
	const { items } = await api.agents();
	setMyAgents(items);
	return items;
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

/** 退群，或移出我的助手 / （创建者）移出别人。 */
export async function removeMember(
	conversationId: string,
	principalId: string,
): Promise<void> {
	await api.removeMember(conversationId, principalId);
	await refreshConversations();
}
