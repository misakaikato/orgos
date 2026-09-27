import type { Event, Principal } from "@orgos/protocol";
import { describe, expect, it } from "vitest";
import { buildThreadRows, extractMentions, splitMentions } from "@/lib/thread";

const TENANT = "44444444-4444-4444-8444-444444444444";
const CONV = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const BOB = "33333333-3333-4333-8333-333333333333";
const TWIN = "55555555-5555-4555-8555-555555555555";

function principal(
	id: string,
	kind: "human" | "agent",
	handle: string,
): Principal {
	return {
		id,
		tenantId: TENANT,
		kind,
		userId: kind === "human" ? id : null,
		ownerId: kind === "agent" ? ME : null,
		handle,
		displayName: handle,
		createdAt: "2026-09-26T00:00:00.000Z",
	};
}

const map = new Map([
	[ME, principal(ME, "human", "me")],
	[BOB, principal(BOB, "human", "bob")],
	[TWIN, principal(TWIN, "agent", "me-twin")],
]);

let seq = 0;
function msg(actorId: string, at: string): Event {
	seq += 1;
	return {
		id: seq,
		tenantId: TENANT,
		conversationId: CONV,
		seq,
		type: "message.posted",
		actorId,
		onBehalfOfId: null,
		payload: { text: `m${seq}`, mentions: [] },
		createdAt: at,
	};
}

let actionId = 1000;
function action(actorId: string, at: string, summary: string): Event {
	seq += 1;
	actionId += 1;
	return {
		id: actionId,
		tenantId: TENANT,
		conversationId: CONV,
		seq,
		type: "agent.action",
		actorId,
		onBehalfOfId: null,
		payload: { tool: "memory_search", summary, ok: true },
		createdAt: at,
	};
}

describe("buildThreadRows", () => {
	it("同一人 3 分钟内合并，超过或换人则重新起头；按我 / 他人 / 代理分边", () => {
		seq = 0;
		const events = [
			msg(ME, "2026-09-26T09:00:00.000Z"),
			msg(ME, "2026-09-26T09:02:00.000Z"),
			msg(ME, "2026-09-26T09:06:00.000Z"),
			msg(BOB, "2026-09-26T09:07:00.000Z"),
			msg(TWIN, "2026-09-26T09:08:00.000Z"),
		];
		const rows = buildThreadRows(events, map, ME, null);
		expect(rows.map((r) => r.kind)).toEqual([
			"stamp",
			"bubble",
			"bubble",
			"bubble",
			"bubble",
			"bubble",
		]);
		const bubbles = rows.flatMap((r) => (r.kind === "bubble" ? [r] : []));
		expect(bubbles.map((r) => r.continued)).toEqual([
			false,
			true,
			false,
			false,
			false,
		]);
		expect(bubbles.map((r) => r.side)).toEqual([
			"me",
			"me",
			"me",
			"human",
			"agent",
		]);
	});

	it("间隔超过 10 分钟或跨天插入时间分隔，分隔打断合并；未读分隔放在已读位置之后第一条他人消息前", () => {
		seq = 0;
		const events = [
			msg(BOB, "2026-09-25T09:00:00.000Z"),
			msg(ME, "2026-09-26T09:00:00.000Z"),
			msg(BOB, "2026-09-26T09:01:00.000Z"),
			msg(BOB, "2026-09-26T09:12:00.000Z"),
		];
		const rows = buildThreadRows(events, map, ME, 1);
		expect(rows.map((r) => r.kind)).toEqual([
			"stamp",
			"bubble",
			"stamp",
			"bubble",
			"unread",
			"bubble",
			"stamp",
			"bubble",
		]);
		const last = rows.at(-1);
		expect(last?.kind === "bubble" && last.continued).toBe(false);
	});

	it("代理动作折叠进该代理的下一条气泡；没有下一条时单列在末尾", () => {
		seq = 0;
		const events = [
			msg(ME, "2026-09-26T09:00:00.000Z"),
			action(TWIN, "2026-09-26T09:00:10.000Z", "查阅了路线图"),
			action(TWIN, "2026-09-26T09:00:20.000Z", "记下了出差"),
			msg(TWIN, "2026-09-26T09:00:30.000Z"),
			action(TWIN, "2026-09-26T09:01:00.000Z", "分派给执行助手"),
		];
		const rows = buildThreadRows(events, map, ME, null);
		expect(rows.map((r) => r.kind)).toEqual([
			"stamp",
			"bubble",
			"bubble",
			"actions",
		]);
		const reply = rows[2];
		expect(
			reply?.kind === "bubble"
				? reply.actions.map((a) => a.payload.summary)
				: [],
		).toEqual(["查阅了路线图", "记下了出差"]);
		const tail = rows[3];
		expect(tail?.kind === "actions" ? tail.actions.length : 0).toBe(1);
	});

	it("上报卡片带上对应的答复；答复本身是系统行", () => {
		seq = 0;
		const WORK = "66666666-6666-4666-8666-666666666666";
		const base = {
			tenantId: TENANT,
			conversationId: CONV,
			onBehalfOfId: null,
		};
		const events: Event[] = [
			{
				...base,
				id: 1,
				seq: 1,
				actorId: TWIN,
				type: "escalation.created",
				payload: { workItemId: WORK, question: "能提前吗" },
				createdAt: "2026-09-26T09:00:00.000Z",
			},
			{
				...base,
				id: 2,
				seq: 2,
				actorId: ME,
				type: "escalation.resolved",
				payload: { workItemId: WORK, action: "answer", text: "可以" },
				createdAt: "2026-09-26T09:01:00.000Z",
			},
		];
		const rows = buildThreadRows(events, map, ME, null);
		expect(rows.map((r) => r.kind)).toEqual(["stamp", "escalation", "system"]);
		const card = rows[1];
		expect(
			card?.kind === "escalation" ? card.resolved?.payload.text : null,
		).toBe("可以");
	});

	it("协商：私聊里的 negotiation.started 成为协商卡片行；协商会话自己的事件不进消息列", () => {
		seq = 0;
		const NEGO = "77777777-7777-4777-8777-777777777777";
		const base = {
			tenantId: TENANT,
			conversationId: CONV,
			onBehalfOfId: ME,
			actorId: TWIN,
		};
		const events: Event[] = [
			msg(BOB, "2026-09-26T09:00:00.000Z"),
			{
				...base,
				id: 10,
				seq: 2,
				type: "negotiation.started",
				payload: { negotiationConversationId: NEGO, goal: "约周四" },
				createdAt: "2026-09-26T09:01:00.000Z",
			},
			{
				...base,
				id: 11,
				seq: 3,
				type: "negotiation.step",
				payload: { step: 1, status: "continue", message: "周四？" },
				createdAt: "2026-09-26T09:01:30.000Z",
			},
		];
		const rows = buildThreadRows(events, map, ME, null);
		expect(rows.map((r) => r.kind)).toEqual(["stamp", "bubble", "negotiation"]);
		const card = rows[2];
		expect(
			card?.kind === "negotiation"
				? card.event.payload.negotiationConversationId
				: null,
		).toBe(NEGO);
	});
});

describe("设备审批", () => {
	it("approval.requested 成为审批卡片行并带上结局；结局本身不单独成行", () => {
		seq = 0;
		const WORK = "88888888-8888-4888-8888-888888888888";
		const RUNNER = "99999999-9999-4999-8999-999999999999";
		const base = { tenantId: TENANT, conversationId: CONV };
		const events: Event[] = [
			{
				...base,
				id: 1,
				seq: 1,
				actorId: TWIN,
				onBehalfOfId: ME,
				type: "approval.requested",
				payload: {
					workItemId: WORK,
					runnerId: RUNNER,
					runnerName: "我的 Mac",
					capability: "shell.exec",
					args: { command: "echo hi" },
				},
				createdAt: "2026-09-26T09:00:00.000Z",
			},
			{
				...base,
				id: 2,
				seq: 2,
				actorId: ME,
				onBehalfOfId: null,
				type: "approval.resolved",
				payload: { workItemId: WORK, outcome: "approve" },
				createdAt: "2026-09-26T09:00:30.000Z",
			},
			msg(TWIN, "2026-09-26T09:00:40.000Z"),
		];
		const rows = buildThreadRows(events, map, ME, null);
		expect(rows.map((r) => r.kind)).toEqual(["stamp", "approval", "bubble"]);
		const card = rows[1];
		expect(
			card?.kind === "approval" ? card.resolved?.payload.outcome : null,
		).toBe("approve");
	});

	it("还没有结局时 resolved 为 null", () => {
		seq = 0;
		const rows = buildThreadRows(
			[
				{
					tenantId: TENANT,
					conversationId: CONV,
					id: 1,
					seq: 1,
					actorId: TWIN,
					onBehalfOfId: ME,
					type: "approval.requested",
					payload: {
						workItemId: "88888888-8888-4888-8888-888888888888",
						runnerId: "99999999-9999-4999-8999-999999999999",
						runnerName: "我的 Mac",
						capability: "fs.write",
						args: { path: "a.txt", content: "x" },
					},
					createdAt: "2026-09-26T09:00:00.000Z",
				},
			],
			map,
			ME,
			null,
		);
		const card = rows[1];
		expect(card?.kind).toBe("approval");
		expect(card?.kind === "approval" ? card.resolved : "x").toBeNull();
	});
});

describe("提及", () => {
	it("只高亮会话成员的 handle", () => {
		const parts = splitMentions("请 @bob 看下，@nobody 不算", new Set(["bob"]));
		expect(parts).toEqual([
			{ text: "请 ", mention: false },
			{ text: "@bob", mention: true },
			{ text: " 看下，@nobody 不算", mention: false },
		]);
	});

	it("提取提及：handle 须完整匹配，排除自己，去重", () => {
		const members = [
			{ id: ME, handle: "me" },
			{ id: BOB, handle: "bob" },
			{ id: TWIN, handle: "me-twin" },
		];
		expect(
			extractMentions("@me-twin 和 @bob、@bob，还有 @me", members, ME),
		).toEqual([TWIN, BOB]);
		expect(extractMentions("@bobby", members, ME)).toEqual([]);
	});
});
