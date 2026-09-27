import type { Event, Principal, Task } from "@orgos/protocol";
import { describe, expect, it } from "vitest";
import { describeEvent } from "@/lib/describe";
import { currentTaskOf } from "@/lib/tasks";
import { buildThreadRows } from "@/lib/thread";

const TENANT = "44444444-4444-4444-8444-444444444444";
const CONV = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const EXT = "55555555-5555-4555-8555-555555555555";
const T1 = "66666666-6666-4666-8666-666666666661";
const T2 = "66666666-6666-4666-8666-666666666662";
const AT = "2026-09-27T08:00:00.000Z";

const ext: Principal = {
	id: EXT,
	tenantId: TENANT,
	kind: "agent",
	userId: null,
	ownerId: ME,
	handle: "me-claude",
	displayName: "Claude Code",
	createdAt: AT,
};
const map = new Map([[EXT, ext]]);

let seq = 0;
function taskEvent(
	type: "task.created" | "task.updated" | "task.ended",
	taskId: string,
): Event {
	seq += 1;
	const base = {
		id: seq,
		tenantId: TENANT,
		conversationId: CONV,
		seq,
		actorId: EXT,
		onBehalfOfId: ME,
		createdAt: AT,
	};
	if (type === "task.created")
		return { ...base, type, payload: { taskId, title: "加一个函数" } };
	if (type === "task.updated")
		return { ...base, type, payload: { taskId, state: "input_required" } };
	return {
		...base,
		type,
		payload: { taskId, state: "completed", summary: "做完了", artifacts: [] },
	};
}

function task(id: string, state: Task["state"]): Task {
	return {
		id,
		tenantId: TENANT,
		conversationId: CONV,
		requesterId: ME,
		assigneeId: EXT,
		onBehalfOfId: ME,
		title: "t",
		goal: "t",
		state,
		engine: "acp",
		adapter: "claude-code",
		runnerId: null,
		workspace: "/w",
		externalSessionId: null,
		resultSummary: null,
		artifacts: [],
		costMicroUsd: null,
		createdAt: AT,
		updatedAt: AT,
		endedAt: null,
	};
}

describe("任务在会话里", () => {
	const events = [
		taskEvent("task.created", T1),
		taskEvent("task.updated", T1),
		taskEvent("task.ended", T1),
		taskEvent("task.created", T2),
	];

	it("每个任务一张卡，放在它最近一次状态变化的位置", () => {
		const rows = buildThreadRows(events, map, ME, null).flatMap((r) =>
			r.kind === "task" ? [r.task] : [],
		);
		expect(rows).toEqual([
			{ taskId: T1, actorId: EXT, title: "加一个函数", createdAt: AT },
			{ taskId: T2, actorId: EXT, title: "加一个函数", createdAt: AT },
		]);
		const withFollowUp = [...events, taskEvent("task.updated", T1)];
		const order = buildThreadRows(withFollowUp, map, ME, null).flatMap((r) =>
			r.kind === "task" ? [r.task.taskId] : [],
		);
		expect(order).toEqual([T2, T1]);
	});

	it("当前任务：最近一个仍未结束的", () => {
		expect(
			currentTaskOf(events, {
				[T1]: { task: task(T1, "completed") },
				[T2]: { task: task(T2, "input_required") },
			})?.id,
		).toBe(T2);
		expect(
			currentTaskOf(events, {
				[T1]: { task: task(T1, "input_required") },
				[T2]: { task: task(T2, "canceled") },
			})?.id,
		).toBe(T1);
		expect(currentTaskOf(events, {})).toBeNull();
	});

	it("列表预览里的说法", () => {
		expect(describeEvent(events[0] as Event, map, ME)).toBe(
			"Claude Code接了任务：加一个函数",
		);
		expect(describeEvent(events[1] as Event, map, ME)).toBe("任务等你回复");
		expect(describeEvent(events[2] as Event, map, ME)).toBe(
			"任务已完成：做完了",
		);
	});
});
