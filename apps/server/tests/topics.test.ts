/**
 * 集成（MOCK_LLM=1）：话题与运行记录。
 *
 * 话题的建立与接口（主线唯一、新话题、改名归档、事件按话题读取、旧客户端不传 topicId 落主线）；
 * 引擎只读当前话题；不同话题各自排队、互不打断；运行记录与 llm_requests.runId；
 * 压缩检查点（小阈值）前后的上下文；近期工作简报（为他人时只列对方可见的会话）；
 * 内置代理的转为任务 / 完成后继续聊；转成群聊（引用原话题、不复制事件、原话题标记已转出）。
 */
import {
	ConversationListResponseSchema,
	CreateConversationResponseSchema,
	type Event,
	RunListResponseSchema,
	RunResponseSchema,
	TaskResponseSchema,
	TopicResponseSchema,
	TopicSourceResponseSchema,
} from "@orgos/protocol";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	BRIEF_PREFIX,
	CHECKPOINT_PREFIX,
	recentWorkBrief,
} from "@/agent/context";
import type { LlmClient, LlmRequest } from "@/agent/llm-types";
import { createMockLlm } from "@/agent/mock-llm";
import { Scheduler } from "@/agent/scheduler";
import { compactions, llmRequests, principals, topics } from "@/db/schema";
import { type PrincipalRow, scoped } from "@/db/scope";
import { postMessage } from "@/services/conversations";
import {
	messagesBy,
	openDm,
	say,
	topicEventsOf,
	topicsOf,
} from "./agent-helpers";
import { createTeam, type TeamMember, uniq } from "./helpers";

let alice: TeamMember;
let bob: TeamMember;
let aliceRow: PrincipalRow;
let twin: string;
let ops: string;

const s = () => scoped(alice.me.tenant.id);

beforeAll(async () => {
	[alice, bob] = (await createTeam(["Alice", "Bob"])) as [
		TeamMember,
		TeamMember,
	];
	twin = alice.me.agents[0]?.principal.id ?? "";
	ops = alice.me.agents[1]?.principal.id ?? "";
	const row = await s().first(
		principals,
		eq(principals.id, alice.me.principal.id),
	);
	if (!row) throw new Error("找不到 alice");
	aliceRow = row;
});

/** 记下每次模型调用的请求，行为照假模型。 */
function recordingLlm() {
	const calls: LlmRequest[] = [];
	const inner = createMockLlm({ sliceDelayMs: 0 });
	const llm: LlmClient = {
		complete(req) {
			calls.push(req);
			return inner.complete(req);
		},
	};
	return { calls, llm };
}

async function newTopic(conversationId: string, title: string) {
	const res = await alice.client.request(
		"POST",
		`/api/conversations/${conversationId}/topics`,
		{ title },
	);
	expect(res.status).toBe(201);
	return TopicResponseSchema.parse(await res.json()).topic;
}

/** 以 alice 身份在某话题发一条消息，交给指定调度器，等这一轮结束。 */
async function sayWith(
	sched: Scheduler,
	conversationId: string,
	text: string,
	topicId?: string,
) {
	const event = await postMessage(s(), aliceRow, conversationId, {
		text,
		...(topicId ? { topicId } : {}),
	});
	if (event.type !== "message.posted") throw new Error("不是消息");
	await sched.onHumanMessage(s(), event);
	return event;
}

/** 一次请求里交给模型的全部文本。 */
function promptText(req: LlmRequest): string {
	return req.messages.map((m) => m.content ?? "").join("\n");
}

async function freshAssistant(): Promise<{ id: string; cid: string }> {
	const res = await alice.client.request("POST", "/api/agents", {
		displayName: "临时助手",
		handle: uniq("tmp-"),
		description: "测试用",
	});
	const { agent } = (await res.json()) as {
		agent: { principal: { id: string } };
	};
	return {
		id: agent.principal.id,
		cid: await openDm(alice.client, agent.principal.id),
	};
}

describe("话题的建立与接口", () => {
	it("每个会话一个主线；主线在前、其余按最近活动；主线不能改名、不能归档", async () => {
		const cid = await openDm(alice.client, ops);
		const [main] = await topicsOf(alice.client, cid);
		expect(main).toMatchObject({ isMain: true, title: "主线", kind: "chat" });
		const a = await newTopic(cid, "话题甲");
		const b = await newTopic(cid, "话题乙");
		await alice.client.request("POST", `/api/conversations/${cid}/messages`, {
			text: "#pass 甲这边动一下",
			topicId: a.id,
		});
		const order = (await topicsOf(alice.client, cid)).map((t) => t.id);
		expect(order.slice(0, 3)).toEqual([main?.id, a.id, b.id]);
		for (const patch of [{ title: "改名" }, { archived: true }]) {
			const res = await alice.client.request(
				"PATCH",
				`/api/topics/${main?.id}`,
				patch,
			);
			expect(res.status).toBe(400);
		}
		const renamed = await alice.client.request("PATCH", `/api/topics/${b.id}`, {
			title: "话题乙（改）",
		});
		expect(TopicResponseSchema.parse(await renamed.json()).topic.title).toBe(
			"话题乙（改）",
		);
		const second = await s()
			.executor.execute(
				sql`insert into topics (tenant_id, conversation_id, title, is_main, created_by)
				values (${alice.me.tenant.id}, ${cid}, '第二个主线', true, ${alice.me.principal.id})`,
			)
			.catch((e: unknown) => e);
		expect(String((second as Error).cause ?? second)).toContain(
			"topics_one_main_per_conversation",
		);
	});

	it("不传 topicId 的消息落主线；events 缺省读主线、给 topicId 读该话题；别的会话的话题 → 404", async () => {
		const cid = await openDm(alice.client, bob.me.principal.id);
		const [main] = await topicsOf(alice.client, cid);
		const side = await newTopic(cid, "旁支");
		await alice.client.request("POST", `/api/conversations/${cid}/messages`, {
			text: "主线上的话",
		});
		await alice.client.request("POST", `/api/conversations/${cid}/messages`, {
			text: "旁支上的话",
			topicId: side.id,
		});
		const inMain = await topicEventsOf(alice.client, cid, main?.id ?? "");
		const byDefault = (
			(await (
				await alice.client.request(
					"GET",
					`/api/conversations/${cid}/events?limit=200`,
				)
			).json()) as { items: Event[] }
		).items;
		expect(byDefault.map((e) => e.id)).toEqual(inMain.map((e) => e.id));
		expect(messagesBy(inMain, alice.me.principal.id).at(-1)?.payload.text).toBe(
			"主线上的话",
		);
		const inSide = await topicEventsOf(alice.client, cid, side.id);
		expect(inSide.map((e) => e.topicId)).toEqual([side.id]);
		const other = await openDm(alice.client, twin);
		const wrong = await alice.client.request(
			"POST",
			`/api/conversations/${other}/messages`,
			{ text: "串门", topicId: side.id },
		);
		expect(wrong.status).toBe(404);
		// 会话列表一行显示最近活动的话题。
		const list = ConversationListResponseSchema.parse(
			await (await alice.client.request("GET", "/api/conversations")).json(),
		);
		expect(
			list.items.find((x) => x.conversation.id === cid)?.lastTopic,
		).toEqual({ id: side.id, title: "旁支", isMain: false });
		// 对方的话题列表带各话题的未读数。
		const forBob = await topicsOf(bob.client, cid);
		expect(forBob.find((t) => t.id === side.id)?.unread).toBe(1);
		expect(forBob.find((t) => t.isMain)?.unread).toBe(1);
		expect(
			(await topicsOf(alice.client, cid)).every((t) => t.unread === 0),
		).toBe(true);
		// 非成员看不到话题。
		const peek = await bob.client.request(
			"GET",
			`/api/conversations/${other}/topics`,
		);
		expect(peek.status).toBe(404);
	});
});

describe("引擎按话题运转", () => {
	it("只读当前话题：另一个话题的内容不进上下文（近期工作简报除外）", async () => {
		const { cid } = await freshAssistant();
		const a = await newTopic(cid, "甲");
		const b = await newTopic(cid, "乙");
		const { calls, llm } = recordingLlm();
		const sched = new Scheduler({ llm: () => llm });
		await sayWith(sched, cid, "甲的暗号是蓝莓", a.id);
		await sayWith(sched, cid, "乙这边问个事", b.id);
		const req = calls.at(-1);
		if (!req) throw new Error("没有模型调用");
		const brief = req.messages.at(-1);
		expect(brief?.content).toContain(BRIEF_PREFIX);
		expect(
			req.messages.slice(0, -1).some((m) => (m.content ?? "").includes("蓝莓")),
		).toBe(false);
		expect(promptText(req)).toContain("乙这边问个事");
		expect(req.messages[0]?.content).toContain("话题“乙”");
	});

	it("不同话题各自排队：一个话题在跑时，另一个话题的消息不打断它", async () => {
		const { cid } = await freshAssistant();
		const a = await newTopic(cid, "慢");
		const b = await newTopic(cid, "快");
		let release = () => {};
		const hold = new Promise<void>((r) => {
			release = r;
		});
		const inner = createMockLlm({ sliceDelayMs: 0 });
		const sched = new Scheduler({
			llm: () => ({
				async complete(req) {
					if (req.trigger.text === "慢慢来") await hold;
					return inner.complete(req);
				},
			}),
		});
		const slow = sayWith(sched, cid, "慢慢来", a.id);
		await new Promise((r) => setTimeout(r, 50));
		await sayWith(sched, cid, "先回我", b.id);
		release();
		await slow;
		for (const [topic, text] of [
			[a.id, "收到：慢慢来"],
			[b.id, "收到：先回我"],
		] as const) {
			const events = await topicEventsOf(alice.client, cid, topic);
			expect(
				messagesBy(events, events.at(-1)?.actorId ?? "").at(-1)?.payload.text,
			).toBe(text);
		}
	});

	it("运行记录：开始到结束、为谁办、触发来源；模型调用带 runId；被新消息打断记 canceled", async () => {
		const { id: agentId, cid } = await freshAssistant();
		const sched = new Scheduler({
			llm: () => createMockLlm({ sliceDelayMs: 0 }),
		});
		const event = await sayWith(sched, cid, "记一下运行");
		const [main] = await topicsOf(alice.client, cid);
		const res = await alice.client.request(
			"GET",
			`/api/runs?topicId=${main?.id}`,
		);
		const [run] = RunListResponseSchema.parse(await res.json()).items;
		expect(run).toMatchObject({
			agentId,
			conversationId: cid,
			topicId: main?.id,
			engine: "builtin",
			state: "completed",
			trigger: `event:${event.id}`,
			actingForId: alice.me.principal.id,
			summary: "收到：记一下运行",
		});
		expect(run?.endedAt).not.toBeNull();
		const rows = await s().select(
			llmRequests,
			eq(llmRequests.runId, run?.id ?? ""),
		);
		expect(rows.length).toBeGreaterThan(0);
		const detail = RunResponseSchema.parse(
			await (await alice.client.request("GET", `/api/runs/${run?.id}`)).json(),
		);
		expect(detail.usage.requests).toBe(rows.length);
		// 我的代理的运行都能按代理列出；别人的代理 403。
		const byAgent = await alice.client.request(
			"GET",
			`/api/runs?agentId=${agentId}`,
		);
		expect(RunListResponseSchema.parse(await byAgent.json()).items[0]?.id).toBe(
			run?.id,
		);
		const foreign = await bob.client.request(
			"GET",
			`/api/runs?agentId=${agentId}`,
		);
		expect(foreign.status).toBe(403);
		expect(
			(await bob.client.request("GET", `/api/runs/${run?.id}`)).status,
		).toBe(404);

		// 被新消息打断：第一轮卡在模型调用上，第二条消息到来后它记为 canceled。
		let release = () => {};
		const hold = new Promise<void>((r) => {
			release = r;
		});
		const inner = createMockLlm({ sliceDelayMs: 0 });
		const gated = new Scheduler({
			llm: () => ({
				async complete(req) {
					if (req.trigger.text === "第一句") await hold;
					return inner.complete(req);
				},
			}),
		});
		const first = sayWith(gated, cid, "第一句");
		await new Promise((r) => setTimeout(r, 50));
		const next = await postMessage(s(), aliceRow, cid, { text: "第二句" });
		if (next.type !== "message.posted") throw new Error("不是消息");
		const second = gated.onHumanMessage(s(), next);
		release();
		await Promise.all([first, second]);
		const after = RunListResponseSchema.parse(
			await (
				await alice.client.request("GET", `/api/runs?topicId=${main?.id}`)
			).json(),
		).items;
		expect(after.slice(0, 2).map((r) => [r.state, r.summary])).toEqual([
			["completed", "收到：第二句"],
			["canceled", "被新消息打断"],
		]);
	});

	it("为他人办事的运行记下对方", async () => {
		const pair = await openDm(bob.client, alice.me.principal.id);
		await say(bob.client, pair, "问个事", { askTwin: true });
		const [main] = await topicsOf(bob.client, pair);
		const [run] = RunListResponseSchema.parse(
			await (
				await bob.client.request("GET", `/api/runs?topicId=${main?.id}`)
			).json(),
		).items;
		expect(run).toMatchObject({
			agentId: twin,
			actingForId: bob.me.principal.id,
		});
	});
});

describe("压缩检查点", () => {
	const env = { ...process.env };
	afterEach(() => {
		for (const k of ["ORGOS_COMPACT_MAX_EVENTS", "ORGOS_COMPACT_KEEP_TOKENS"])
			if (env[k] === undefined) delete process.env[k];
			else process.env[k] = env[k];
	});

	it("未压缩事件超过阈值：先由同一模型写检查点，之后从检查点 + 其后事件开始，最近的保留原文", async () => {
		process.env.ORGOS_COMPACT_MAX_EVENTS = "6";
		process.env.ORGOS_COMPACT_KEEP_TOKENS = "40";
		const { id: agentId, cid } = await freshAssistant();
		const topic = await newTopic(cid, "长话题");
		const { calls, llm } = recordingLlm();
		const sched = new Scheduler({ llm: () => llm });
		for (const n of ["一", "二", "三"])
			await sayWith(sched, cid, `第${n}件事`, topic.id);
		const before = calls.at(-1);
		expect(
			before?.messages.some((m) => m.content === "【Alice】第一件事"),
		).toBe(true);
		expect(promptText(before as LlmRequest)).not.toContain(CHECKPOINT_PREFIX);
		expect(
			await s().select(compactions, eq(compactions.topicId, topic.id)),
		).toHaveLength(0);

		calls.length = 0;
		await sayWith(sched, cid, "第四件事", topic.id);
		const [checkpointCall, answer] = calls;
		expect(checkpointCall?.trigger.checkpoint).toBe(true);
		expect(promptText(checkpointCall as LlmRequest)).toContain(
			"【Alice】第一件事",
		);
		const [row] = await s().select(
			compactions,
			and(eq(compactions.topicId, topic.id), eq(compactions.agentId, agentId)),
		);
		expect(row?.summary).toMatch(/^目标：【Alice】第一件事/);
		expect(row?.summary).toContain("涉及文件：");
		expect(answer?.messages[1]?.content).toBe(
			`${CHECKPOINT_PREFIX}\n${row?.summary}`,
		);
		expect(
			answer?.messages.some((m) => m.content === "【Alice】第一件事"),
		).toBe(false);
		expect(
			answer?.messages.some((m) => m.content === "【Alice】第四件事"),
		).toBe(true);
		// 检查点与这次回复同属一次运行。
		expect(checkpointCall?.meta.runId).toBe(answer?.meta.runId);

		// 下一次运行直接从检查点开始，不再重复压缩同一段。
		calls.length = 0;
		await sayWith(sched, cid, "第五件事", topic.id);
		expect(calls.every((c) => !c.trigger.checkpoint)).toBe(true);
		expect(calls[0]?.messages[1]?.content).toContain(CHECKPOINT_PREFIX);
	});
});

describe("近期工作简报", () => {
	it("列出该代理在其他话题与会话里的最后一句；为他人办事时只列对方也在的会话", async () => {
		const own = await openDm(alice.client, ops);
		const t = await newTopic(own, "私事");
		const sched = new Scheduler({
			llm: () => createMockLlm({ sliceDelayMs: 0 }),
		});
		await sayWith(sched, own, "私下安排：周五请假", t.id);
		const group = CreateConversationResponseSchema.parse(
			await (
				await alice.client.request("POST", "/api/conversations", {
					kind: "group",
					title: "项目群",
					memberIds: [bob.me.principal.id, ops],
				})
			).json(),
		).conversation.id;
		const posted = await postMessage(s(), aliceRow, group, {
			text: "@ops 大家同步一下进度",
			mentions: [ops],
		});
		if (posted.type !== "message.posted") throw new Error("不是消息");
		await sched.onHumanMessage(s(), posted);
		const [elsewhere] = await topicsOf(
			alice.client,
			await openDm(alice.client, bob.me.principal.id),
		);
		const forOwner = await recentWorkBrief(s(), {
			agentId: ops,
			currentTopicId: elsewhere?.id ?? "",
			visibleTo: null,
		});
		expect(forOwner).toContain("收到：私下安排：周五请假");
		expect(forOwner).toContain("群聊“项目群”");
		const lines = (forOwner ?? "").split("\n").slice(1);
		expect(lines.length).toBeLessThanOrEqual(10);
		expect(Array.from(forOwner ?? "").length).toBeLessThanOrEqual(350);
		const forBob = await recentWorkBrief(s(), {
			agentId: ops,
			currentTopicId: elsewhere?.id ?? "",
			visibleTo: bob.me.principal.id,
		});
		expect(forBob).toContain("群聊“项目群”");
		expect(forBob).not.toContain("周五请假");
		// 当前话题自己的发言不进简报；48 小时以前的也不进。
		const [groupMain] = await topicsOf(alice.client, group);
		const inGroup = await recentWorkBrief(s(), {
			agentId: ops,
			currentTopicId: groupMain?.id ?? "",
			visibleTo: null,
		});
		expect(inGroup).not.toContain("项目群");
		const later = await recentWorkBrief(s(), {
			agentId: ops,
			currentTopicId: elsewhere?.id ?? "",
			visibleTo: null,
			now: new Date(Date.now() + 49 * 60 * 60 * 1000),
		});
		expect(later).toBeNull();
	});
});

describe("转为任务（内置代理）", () => {
	it("话题转为任务后运行服务于任务；完成后话题照样可聊，之后的运行不再服务于它", async () => {
		const { cid } = await freshAssistant();
		const topic = await newTopic(cid, "写周报");
		const sched = new Scheduler({
			llm: () => createMockLlm({ sliceDelayMs: 0 }),
		});
		await sayWith(sched, cid, "帮我起个周报草稿", topic.id);
		const res = await alice.client.request(
			"POST",
			`/api/topics/${topic.id}/to-task`,
			{},
		);
		expect(res.status).toBe(201);
		const task = TaskResponseSchema.parse(await res.json()).task;
		expect(task).toMatchObject({
			engine: "builtin",
			state: "input_required",
			goal: "帮我起个周报草稿",
			topicId: topic.id,
		});
		await sayWith(sched, cid, "再加一段风险", topic.id);
		const runs = RunListResponseSchema.parse(
			await (
				await alice.client.request("GET", `/api/runs?topicId=${topic.id}`)
			).json(),
		).items;
		expect(runs[0]?.taskId).toBe(task.id);
		expect(runs[1]?.taskId).toBeNull();
		const current = TaskResponseSchema.parse(
			await (await alice.client.request("GET", `/api/tasks/${task.id}`)).json(),
		).task;
		expect(current.state).toBe("input_required");
		const done = await alice.client.request(
			"POST",
			`/api/tasks/${task.id}/complete`,
		);
		expect(TaskResponseSchema.parse(await done.json()).task.state).toBe(
			"completed",
		);
		await sayWith(sched, cid, "谢谢", topic.id);
		const after = RunListResponseSchema.parse(
			await (
				await alice.client.request("GET", `/api/runs?topicId=${topic.id}`)
			).json(),
		).items;
		expect(after[0]).toMatchObject({ taskId: null, state: "completed" });
		const events = await topicEventsOf(alice.client, cid, topic.id);
		expect(events.map((e) => e.type)).toContain("task.ended");
	});

	it("只在本人与自己代理的私聊里：两人私聊的话题转为任务 → 400", async () => {
		const pair = await openDm(alice.client, bob.me.principal.id);
		const topic = await newTopic(pair, "两人话题");
		await alice.client.request("POST", `/api/conversations/${pair}/messages`, {
			text: "我们的事",
			topicId: topic.id,
		});
		const res = await alice.client.request(
			"POST",
			`/api/topics/${topic.id}/to-task`,
			{},
		);
		expect(res.status).toBe(400);
	});
});

describe("转成群聊", () => {
	it("新群主线引用原话题（不复制事件），原话题标记已转出；新成员可展开原话题，代理把它当前置历史", async () => {
		const own = await openDm(alice.client, ops);
		const topic = await newTopic(own, "方案讨论");
		const sched = new Scheduler({
			llm: () => createMockLlm({ sliceDelayMs: 0 }),
		});
		await sayWith(sched, own, "方案 A 用消息队列解耦", topic.id);
		const res = await alice.client.request(
			"POST",
			`/api/topics/${topic.id}/to-group`,
			{ memberIds: [bob.me.principal.id, ops] },
		);
		expect(res.status).toBe(201);
		const { conversation } = CreateConversationResponseSchema.parse(
			await res.json(),
		);
		expect(conversation).toMatchObject({ kind: "group", title: "方案讨论" });
		const [groupMain] = await topicsOf(bob.client, conversation.id);
		expect(groupMain?.sourceTopicId).toBe(topic.id);
		const groupEvents = await topicEventsOf(
			bob.client,
			conversation.id,
			groupMain?.id ?? "",
		);
		expect(new Set(groupEvents.map((e) => e.type))).toEqual(
			new Set(["member.joined"]),
		);
		const origin = (await topicsOf(alice.client, own)).find(
			(t) => t.id === topic.id,
		);
		expect(origin?.movedToConversationId).toBe(conversation.id);
		expect(
			(await topicEventsOf(alice.client, own, topic.id)).at(-1),
		).toMatchObject({
			type: "topic.moved",
			payload: { conversationId: conversation.id, title: "方案讨论" },
		});
		// Bob 不是原私聊的成员，但能经新群展开原话题。
		expect(
			(await bob.client.request("GET", `/api/conversations/${own}/events`))
				.status,
		).toBe(404);
		const source = TopicSourceResponseSchema.parse(
			await (
				await bob.client.request("GET", `/api/topics/${groupMain?.id}/source`)
			).json(),
		);
		expect(source.topic.id).toBe(topic.id);
		expect(
			source.events.some(
				(e) =>
					e.type === "message.posted" &&
					e.payload.text === "方案 A 用消息队列解耦",
			),
		).toBe(true);
		// 群里代理的上下文从原话题的历史接着来。
		const { calls, llm } = recordingLlm();
		const withSource = new Scheduler({ llm: () => llm });
		const posted = await postMessage(s(), aliceRow, conversation.id, {
			text: "@ops 接着说",
			mentions: [ops],
		});
		if (posted.type !== "message.posted") throw new Error("不是消息");
		await withSource.onHumanMessage(s(), posted);
		expect(promptText(calls[0] as LlmRequest)).toContain(
			"方案 A 用消息队列解耦",
		);
		const [row] = await s().select(topics, eq(topics.id, groupMain?.id ?? ""));
		expect(row?.sourceTopicId).toBe(topic.id);
	});
});
