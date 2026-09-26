import type { Event, Principal } from "@orgos/protocol";
import { describe, expect, it } from "vitest";
import { buildThreadRows, extractMentions, splitMentions } from "@/lib/thread";

const TENANT = "44444444-4444-4444-8444-444444444444";
const CONV = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const BOB = "33333333-3333-4333-8333-333333333333";
const CHIEF = "55555555-5555-4555-8555-555555555555";

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
	[CHIEF, principal(CHIEF, "agent", "me-chief")],
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

describe("buildThreadRows", () => {
	it("同一人 5 分钟内合并，超过或换人则重新起头；代理消息单列", () => {
		seq = 0;
		const events = [
			msg(ME, "2026-09-26T09:00:00.000Z"),
			msg(ME, "2026-09-26T09:04:00.000Z"),
			msg(ME, "2026-09-26T09:10:00.000Z"),
			msg(BOB, "2026-09-26T09:11:00.000Z"),
			msg(CHIEF, "2026-09-26T09:12:00.000Z"),
		];
		const rows = buildThreadRows(events, map, ME, null);
		expect(rows.map((r) => r.kind)).toEqual([
			"day",
			"human",
			"human",
			"human",
			"human",
			"agent",
		]);
		expect(
			rows.flatMap((r) =>
				r.kind === "human" || r.kind === "agent" ? [r.continued] : [],
			),
		).toEqual([false, true, false, false, false]);
	});

	it("跨天插入日期分隔；未读分隔放在已读位置之后第一条他人消息前", () => {
		seq = 0;
		const events = [
			msg(BOB, "2026-09-25T09:00:00.000Z"),
			msg(ME, "2026-09-26T09:00:00.000Z"),
			msg(BOB, "2026-09-26T09:01:00.000Z"),
		];
		const rows = buildThreadRows(events, map, ME, 1);
		expect(rows.map((r) => r.kind)).toEqual([
			"day",
			"human",
			"day",
			"human",
			"unread",
			"human",
		]);
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
			{ id: CHIEF, handle: "me-chief" },
		];
		expect(
			extractMentions("@me-chief 和 @bob、@bob，还有 @me", members, ME),
		).toEqual([CHIEF, BOB]);
		expect(extractMentions("@bobby", members, ME)).toEqual([]);
	});
});
