import type { ConversationSummary, Event } from "@orgos/protocol";
import { describe, expect, it } from "vitest";
import {
	applyEventToSummaries,
	maxSeq,
	mergeEvents,
	reconcileRead,
} from "@/lib/events";

const CONV = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

function msg(seq: number, actorId = OTHER, minute = seq): Event {
	return {
		id: seq,
		tenantId: "44444444-4444-4444-8444-444444444444",
		conversationId: CONV,
		seq,
		type: "message.posted",
		actorId,
		onBehalfOfId: null,
		payload: { text: `m${seq}`, mentions: [] },
		createdAt: new Date(Date.UTC(2026, 8, 26, 9, minute)).toISOString(),
	};
}

function summary(
	id: string,
	lastSeq: number,
	createdMinute: number,
): ConversationSummary {
	return {
		conversation: {
			id,
			tenantId: "44444444-4444-4444-8444-444444444444",
			kind: "dm",
			title: null,
			createdBy: ME,
			createdAt: new Date(
				Date.UTC(2026, 8, 26, 9, createdMinute),
			).toISOString(),
			lastSeq,
		},
		members: [],
		unread: 0,
		lastReadSeq: 0,
	};
}

describe("mergeEvents", () => {
	it("按 seq 去重并升序，乱序与重复到达都收敛", () => {
		const merged = mergeEvents(
			[msg(1), msg(3)],
			[msg(2), msg(3), msg(5), msg(4)],
		);
		expect(merged.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
		expect(maxSeq(merged)).toBe(5);
	});

	it("没有新事件时返回原数组（引用不变，避免无谓重渲染）", () => {
		const list = [msg(1), msg(2)];
		expect(mergeEvents(list, [msg(2)])).toBe(list);
		expect(mergeEvents(list, [])).toBe(list);
	});

	it("空列表 maxSeq 为 0", () => {
		expect(maxSeq([])).toBe(0);
	});
});

describe("applyEventToSummaries", () => {
	it("他人消息累加未读并把会话排到最前", () => {
		const items = [summary("other", 0, 30), summary(CONV, 0, 0)];
		const next = applyEventToSummaries(items, msg(1, OTHER, 45), ME, false);
		expect(next?.[0]?.conversation.id).toBe(CONV);
		expect(next?.[0]?.unread).toBe(1);
		expect(next?.[0]?.conversation.lastSeq).toBe(1);
	});

	it("自己的消息不计未读；正在查看的会话未读清零", () => {
		const items = [summary(CONV, 0, 0)];
		const mine = applyEventToSummaries(items, msg(1, ME), ME, false);
		expect(mine?.[0]?.unread).toBe(0);
		const viewing = applyEventToSummaries(mine ?? [], msg(2), ME, true);
		expect(viewing?.[0]?.unread).toBe(0);
		expect(viewing?.[0]?.lastReadSeq).toBe(2);
	});

	it("重复或旧事件不改变摘要", () => {
		const items =
			applyEventToSummaries([summary(CONV, 0, 0)], msg(2), ME, false) ?? [];
		expect(applyEventToSummaries(items, msg(1), ME, false)).toBe(items);
	});

	it("未知会话返回 null", () => {
		expect(applyEventToSummaries([], msg(1), ME, false)).toBeNull();
	});
});

describe("reconcileRead", () => {
	it("本地已读位置领先于服务端快照时，以本地为准并按已加载事件重算未读", () => {
		const stale = { ...summary(CONV, 3, 0), unread: 3, lastReadSeq: 0 };
		const events = { [CONV]: [msg(1), msg(2), msg(3)] };
		const [item] = reconcileRead([stale], { [CONV]: 2 }, events, ME);
		expect(item?.lastReadSeq).toBe(2);
		expect(item?.unread).toBe(1);
	});

	it("未加载事件时：本地已读到最新则未读为 0，否则保留服务端数", () => {
		const stale = { ...summary(CONV, 3, 0), unread: 3, lastReadSeq: 0 };
		expect(reconcileRead([stale], { [CONV]: 3 }, {}, ME)[0]?.unread).toBe(0);
		expect(reconcileRead([stale], { [CONV]: 1 }, {}, ME)[0]?.unread).toBe(3);
	});

	it("服务端已读位置不落后时原样返回", () => {
		const fresh = { ...summary(CONV, 3, 0), unread: 0, lastReadSeq: 3 };
		expect(reconcileRead([fresh], { [CONV]: 2 }, {}, ME)[0]).toBe(fresh);
	});
});
