/**
 * 任务：状态机（对齐 A2A）、不允许的迁移不留痕迹；delegate_to_teammate 在目标私聊里新开任务话题、
 * 生成 engine=builtin 的任务（结果发在任务话题里并作为工具结果）；可交办范围（外部助手只替本人干活）。
 */
import {
	type Agent,
	canTransition,
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
import {
	eventsOf,
	messagesBy,
	openDm,
	say,
	topicEventsOf,
	topicsOf,
} from "./agent-helpers";
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

	it("为本人：在本人与助手的私聊里新开任务话题；任务 completed、结果发在话题里，工具结果照旧作为回复", async () => {
		const dm = await openDm(alice.client, twin);
		await say(alice.client, dm, `#delegate:${ops.handle} 整理周报`);
		const events = await eventsOf(alice.client, dm);
		const [reply] = messagesBy(events, twin);
		expect(reply?.payload.text).toBe("完成：收到：整理周报");
		// 交办处的会话里只有交办动作，任务在目标私聊的任务话题里。
		expect(events.some((e) => e.type === "task.created")).toBe(false);
		const opsDm = await openDm(alice.client, ops.id);
		const topics = await topicsOf(alice.client, opsDm);
		const topic = topics.find((t) => t.kind === "task");
		expect(topic).toMatchObject({
			title: "整理周报",
			isMain: false,
			taskState: "completed",
		});
		const inTopic = await topicEventsOf(alice.client, opsDm, topic?.id ?? "");
		expect(inTopic[0]).toMatchObject({
			type: "task.created",
			actorId: ops.id,
			onBehalfOfId: alice.me.principal.id,
			payload: { title: "整理周报" },
		});
		expect(messagesBy(inTopic, ops.id).map((m) => m.payload.text)).toEqual([
			"收到：整理周报",
		]);
		expect(inTopic.find((e) => e.type === "task.ended")).toMatchObject({
			payload: { state: "completed", summary: "收到：整理周报" },
		});
		const res = await alice.client.request(
			"GET",
			`/api/tasks?conversationId=${opsDm}`,
		);
		const { items } = TaskListResponseSchema.parse(await res.json());
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			engine: "builtin",
			state: "completed",
			topicId: topic?.id,
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
		// 已结束的任务不能再完成。
		const done = await alice.client.request(
			"POST",
			`/api/tasks/${items[0]?.id}/complete`,
		);
		expect(done.status).toBe(409);
	});

	it("别人经分身交办：任务话题在本人与助手的私聊里，为提问者办；提问者看得到任务与执行者", async () => {
		const pair = await openDm(bob.client, alice.me.principal.id);
		await say(bob.client, pair, `#delegate:${ops.handle} 查下周报`, {
			askTwin: true,
		});
		const res = await bob.client.request("GET", "/api/tasks");
		const { items } = TaskListResponseSchema.parse(await res.json());
		const task = items.find((t) => t.goal === "查下周报");
		expect(task).toMatchObject({
			engine: "builtin",
			state: "completed",
			onBehalfOfId: bob.me.principal.id,
		});
		const one = await bob.client.request("GET", `/api/tasks/${task?.id}`);
		expect(TaskResponseSchema.parse(await one.json()).assignee).toMatchObject({
			id: ops.id,
			displayName: "Alice的执行助手",
		});
		// 任务话题在 Alice 与助手的私聊里：Bob 看不到那个会话。
		const opsDm = await openDm(alice.client, ops.id);
		expect(task?.conversationId).toBe(opsDm);
		const peek = await bob.client.request(
			"GET",
			`/api/conversations/${opsDm}/topics`,
		);
		expect(peek.status).toBe(404);
	});

	it("不允许的迁移返回 null，不落事件", async () => {
		const s = scoped(alice.me.tenant.id);
		const dm = await openDm(alice.client, twin);
		const { task, topic } = await createTask(s, {
			conversationId: dm,
			requesterId: alice.me.principal.id,
			assignee: { id: ops.id, ownerId: alice.me.principal.id },
			onBehalfOfId: alice.me.principal.id,
			goal: "试一下",
			engine: "builtin",
		});
		const before = (await topicEventsOf(alice.client, dm, topic.id)).length;
		expect(await transitionTask(s, task.id, "input_required")).toBeNull();
		expect(await transitionTask(s, task.id, "canceled")).toMatchObject({
			state: "canceled",
		});
		expect(await transitionTask(s, task.id, "working")).toBeNull();
		const after = await topicEventsOf(alice.client, dm, topic.id);
		expect(after.slice(before).map((e) => e.type)).toEqual(["task.ended"]);
	});
});
