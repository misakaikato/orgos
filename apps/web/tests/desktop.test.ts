import type {
	ConversationSummary,
	Event,
	MeResponse,
	Principal,
	WorkItem,
} from "@orgos/protocol";
import { describe, expect, it } from "vitest";
import { desktopNotices, syncDesktop, unreadTotal } from "@/lib/desktop";
import { getState, type State } from "@/lib/store";

const TENANT = "44444444-4444-4444-8444-444444444444";
const ME = "22222222-2222-4222-8222-222222222222";
const ZHOU = "33333333-3333-4333-8333-333333333333";
const DM = "11111111-1111-4111-8111-111111111111";
const GROUP = "55555555-5555-4555-8555-555555555555";

function person(id: string, name: string): Principal {
	return {
		id,
		tenantId: TENANT,
		kind: "human",
		handle: name,
		displayName: name,
		ownerId: null,
		role: null,
		status: "available",
	} as unknown as Principal;
}

function msg(
	conversationId: string,
	seq: number,
	actorId: string,
	text: string,
): Event {
	return {
		id: seq,
		tenantId: TENANT,
		conversationId,
		seq,
		type: "message.posted",
		actorId,
		onBehalfOfId: null,
		payload: { text, mentions: [] },
		createdAt: new Date(Date.UTC(2026, 8, 27, 9, seq)).toISOString(),
	} as Event;
}

function summary(
	id: string,
	kind: "dm" | "group",
	last: Event | undefined,
	unread: number,
): ConversationSummary {
	return {
		conversation: {
			id,
			tenantId: TENANT,
			kind,
			title: kind === "group" ? "Q4 发布" : null,
			createdBy: ME,
			createdAt: new Date(Date.UTC(2026, 8, 27)).toISOString(),
			lastSeq: last?.seq ?? 0,
		},
		members: [person(ME, "林晓"), person(ZHOU, "周野")],
		lastEvent: last,
		unread,
	} as unknown as ConversationSummary;
}

function workItem(id: string, conversationId: string | null): WorkItem {
	return {
		id,
		tenantId: TENANT,
		kind: "decision",
		title: "交付能否提前",
		body: "许诺问：大客户 A 的交付能提前到 10 月 15 日吗？",
		ownerId: ME,
		requesterId: ZHOU,
		status: "open",
		conversationId,
	} as unknown as WorkItem;
}

function state(patch: Partial<State>): State {
	return {
		...getState(),
		session: "ready",
		me: { principal: person(ME, "林晓"), agents: [] } as unknown as MeResponse,
		...patch,
	};
}

describe("桌面端的角标与通知", () => {
	it("未读总数是各会话未读之和", () => {
		expect(
			unreadTotal({
				conversations: [
					summary(DM, "dm", undefined, 2),
					summary(GROUP, "group", undefined, 3),
				],
			}),
		).toBe(5);
	});

	it("别人发来的新消息：私聊以对方为标题，群聊带说话人", () => {
		const before = state({
			conversations: [
				summary(DM, "dm", msg(DM, 1, ZHOU, "早"), 0),
				summary(GROUP, "group", msg(GROUP, 1, ZHOU, "开会"), 0),
			],
		});
		const after = state({
			conversations: [
				summary(DM, "dm", msg(DM, 2, ZHOU, "切流改到周四\n细节见文档"), 1),
				summary(GROUP, "group", msg(GROUP, 2, ZHOU, "评审挪到下午"), 1),
			],
		});
		expect(desktopNotices(before, after)).toEqual([
			{
				key: `message:${DM}:2`,
				title: "周野",
				body: "切流改到周四",
				path: `/c/${DM}`,
			},
			{
				key: `message:${GROUP}:2`,
				title: "Q4 发布",
				body: "周野：评审挪到下午",
				path: `/c/${GROUP}`,
			},
		]);
	});

	it("自己发的、自己的代理代我发的、没有变化的、首次加载时的都不通知", () => {
		const base = state({
			conversations: [summary(DM, "dm", msg(DM, 1, ZHOU, "早"), 1)],
		});
		const mine = state({
			conversations: [summary(DM, "dm", msg(DM, 2, ME, "好的"), 0)],
		});
		expect(desktopNotices(base, mine)).toEqual([]);
		const twin = {
			...msg(DM, 2, "66666666-6666-4666-8666-666666666666", "收到"),
			onBehalfOfId: ME,
		} as Event;
		const byTwin = state({ conversations: [summary(DM, "dm", twin, 2)] });
		expect(desktopNotices(base, byTwin)).toEqual([]);
		expect(desktopNotices(base, base)).toEqual([]);
		expect(desktopNotices(state({ session: "loading" }), base)).toEqual([]);
	});

	it("列表里新出现的会话，有未读才通知", () => {
		const before = state({ conversations: [] });
		const after = state({
			conversations: [summary(DM, "dm", msg(DM, 1, ZHOU, "在吗"), 1)],
		});
		expect(desktopNotices(before, after).map((n) => n.title)).toEqual(["周野"]);
	});

	it("新的待办：有会话的打开会话，没有的打开待办页；首次加载不通知", () => {
		const loaded = state({ workItems: [workItem("w1", DM)] });
		const after = state({
			workItems: [workItem("w2", null), workItem("w3", DM), workItem("w1", DM)],
		});
		expect(desktopNotices(loaded, after)).toEqual([
			{
				key: "work-item:w2",
				title: "待办：交付能否提前",
				body: "许诺问：大客户 A 的交付能提前到 10 月 15 日吗？",
				path: "/todo",
			},
			{
				key: "work-item:w3",
				title: "待办：交付能否提前",
				body: "许诺问：大客户 A 的交付能提前到 10 月 15 日吗？",
				path: `/c/${DM}`,
			},
		]);
		expect(desktopNotices(state({ workItems: null }), after)).toEqual([]);
	});

	it("不在桌面壳里时什么都不做", () => {
		expect(() => syncDesktop(state({}))).not.toThrow();
	});
});
