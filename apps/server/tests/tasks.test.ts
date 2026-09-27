/**
 * 任务：状态机（对齐 A2A）、不允许的迁移不留痕迹；delegate_to_teammate 生成 engine=builtin 的任务
 * （结果写回任务并作为工具结果）；可交办范围（外部助手只替本人干活）。
 */
import {
	type Agent,
	canTransition,
	type Event,
	isTaskEnded,
	TASK_STATES,
	TaskListResponseSchema,
	TaskResponseSchema,
	taskTitleOf,
} from "@orgos/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { delegatableTeammates } from "@/agent/tools/delegate";
import { scoped } from "@/db/scope";
import { createTask, transitionTask } from "@/services/tasks";
import { eventsOf, messagesBy, openDm, say } from "./agent-helpers";
import { createTeam, type TeamMember } from "./helpers";

describe("状态机", () => {
	it("结束态不再迁移；input_required 与 awaiting_approval 只能经 working 互通", () => {
		for (const s of TASK_STATES)
			if (isTaskEnded(s))
				for (const t of TASK_STATES) expect(canTransition(s, t)).toBe(false);
		expect(canTransition("submitted", "working")).toBe(true);
		expect(canTransition("submitted", "input_required")).toBe(false);
		expect(canTransition("working", "input_required")).toBe(true);
		expect(canTransition("input_required", "working")).toBe(true);
		expect(canTransition("input_required", "awaiting_approval")).toBe(false);
		expect(canTransition("awaiting_approval", "working")).toBe(true);
		expect(canTransition("input_required", "completed")).toBe(true);
	});

	it("标题取目标第一行，最多 40 字", () => {
		expect(taskTitleOf("  整理周报\n细节在这里")).toBe("整理周报");
		expect(taskTitleOf("字".repeat(50))).toBe(`${"字".repeat(40)}…`);
	});
});

function agent(
	id: string,
	role: Agent["role"],
	engine: Agent["engine"] = "builtin",
): Agent {
	return {
		principal: {
			id,
			tenantId: "t",
			kind: "agent",
			userId: null,
			ownerId: "owner",
			handle: id,
			displayName: id,
			createdAt: new Date().toISOString(),
		},
		role,
		description: "",
		delegationPolicy: "",
		model: "m",
		runnerId: null,
		updatedAt: new Date().toISOString(),
		engine,
	};
}

describe("可交办范围", () => {
	const team = [
		agent("twin", "front"),
		agent("ops", "specialist"),
		agent("ext", "specialist", "acp"),
	];
	const self = team[0] as Agent;

	it("为本人：同组除自己以外都可以（含外部助手）", () => {
		expect(
			delegatableTeammates(team, self, { kind: "owner" }).map(
				(a) => a.principal.id,
			),
		).toEqual(["ops", "ext"]);
	});

	it("为他人：只有同组的内置助手，外部助手不在其中", () => {
		expect(
			delegatableTeammates(team, self, {
				kind: "other",
				principalId: "bob",
			}).map((a) => a.principal.id),
		).toEqual(["ops"]);
	});
});

describe("delegate_to_teammate 生成 builtin 任务", () => {
	let alice: TeamMember;
	let bob: TeamMember;
	let twin: string;
	let ops: { id: string; handle: string };

	beforeAll(async () => {
		[alice, bob] = (await createTeam(["Alice", "Bob"])) as [
			TeamMember,
			TeamMember,
		];
		const [t, o] = alice.me.agents;
		twin = t?.principal.id ?? "";
		ops = { id: o?.principal.id ?? "", handle: o?.principal.handle ?? "" };
	});

	it("为本人：任务 completed、结果写回，工具结果照旧作为回复", async () => {
		const dm = await openDm(alice.client, twin);
		await say(alice.client, dm, `#delegate:${ops.handle} 整理周报`);
		const events = await eventsOf(alice.client, dm);
		const [reply] = messagesBy(events, twin);
		expect(reply?.payload.text).toBe("完成：收到：整理周报");
		const created = events.find(
			(e): e is Extract<Event, { type: "task.created" }> =>
				e.type === "task.created",
		);
		expect(created).toMatchObject({
			actorId: ops.id,
			onBehalfOfId: alice.me.principal.id,
			payload: { title: "整理周报" },
		});
		const ended = events.find((e) => e.type === "task.ended");
		expect(ended).toMatchObject({
			payload: { state: "completed", summary: "收到：整理周报" },
		});
		const res = await alice.client.request(
			"GET",
			`/api/tasks?conversationId=${dm}`,
		);
		const { items } = TaskListResponseSchema.parse(await res.json());
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			engine: "builtin",
			state: "completed",
			requesterId: twin,
			assigneeId: ops.id,
			onBehalfOfId: alice.me.principal.id,
			resultSummary: "收到：整理周报",
		});
		expect(items[0]?.endedAt).not.toBeNull();
		const one = await alice.client.request("GET", `/api/tasks/${items[0]?.id}`);
		expect(TaskResponseSchema.parse(await one.json()).assignee?.id).toBe(
			ops.id,
		);
		// 内置任务是同步的，不能从外面完成或停止。
		const done = await alice.client.request(
			"POST",
			`/api/tasks/${items[0]?.id}/complete`,
		);
		expect(done.status).toBe(403);
	});

	it("为他人：任务为提问者办，提问者看得到任务与执行者", async () => {
		const pair = await openDm(bob.client, alice.me.principal.id);
		await say(bob.client, pair, `#delegate:${ops.handle} 查下周报`, {
			askTwin: true,
		});
		const res = await bob.client.request(
			"GET",
			`/api/tasks?conversationId=${pair}`,
		);
		const { items } = TaskListResponseSchema.parse(await res.json());
		expect(items[0]).toMatchObject({
			engine: "builtin",
			state: "completed",
			onBehalfOfId: bob.me.principal.id,
		});
		const one = await bob.client.request("GET", `/api/tasks/${items[0]?.id}`);
		expect(TaskResponseSchema.parse(await one.json()).assignee).toMatchObject({
			id: ops.id,
			displayName: "Alice的执行助手",
		});
	});

	it("不允许的迁移返回 null，不落事件", async () => {
		const s = scoped(alice.me.tenant.id);
		const dm = await openDm(alice.client, twin);
		const task = await createTask(s, {
			conversationId: dm,
			requesterId: alice.me.principal.id,
			assignee: { id: ops.id, ownerId: alice.me.principal.id },
			onBehalfOfId: alice.me.principal.id,
			goal: "试一下",
			engine: "builtin",
		});
		const before = (await eventsOf(alice.client, dm)).length;
		expect(await transitionTask(s, task.id, "input_required")).toBeNull();
		expect(await transitionTask(s, task.id, "canceled")).toMatchObject({
			state: "canceled",
		});
		expect(await transitionTask(s, task.id, "working")).toBeNull();
		const after = await eventsOf(alice.client, dm);
		expect(after.slice(before).map((e) => e.type)).toEqual(["task.ended"]);
	});
});
