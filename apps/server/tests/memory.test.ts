/**
 * 集成（MOCK_LLM=1）：记忆层——提炼的四种触发与确定性、可见范围的推导、类别授权、第三人规则、
 * 取代链与本人更正、撤回、画像只拼可见段落、伪造出处被丢弃、凭据清洗、代答记录与本人控制接口、
 * memory_search 取代 knowledge_search、系统运行的计量。
 */
import {
	AnswerActionResponseSchema,
	DisclosureResponseSchema,
	type Event,
	MemoryItemListResponseSchema,
	MemorySourcesResponseSchema,
	TwinAnswerListResponseSchema,
} from "@orgos/protocol";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { LlmClient } from "@/agent/llm-types";
import { createMockLlm } from "@/agent/mock-llm";
import { TOOLS } from "@/agent/tools";
import { llmRequests, memoryItems, memoryJobs, runs, tasks } from "@/db/schema";
import { scoped } from "@/db/scope";
import { rebuildProfile, visibleSections } from "@/memory/profiles";
import { drainMemoryJobs } from "@/memory/worker";
import {
	eventsOf,
	messagesBy,
	openDm,
	openGroup,
	say,
	topicsOf,
} from "./agent-helpers";
import { createTeam, type TeamMember } from "./helpers";

let alice: TeamMember;
let bob: TeamMember;
let carol: TeamMember;
let aliceTwin: string;
let aliceOpsHandle: string;
let dmAC: string;
let dmBA: string;
let ownDm: string;
let group: string;

const MIN = 60_000;
const s = () => scoped(alice.me.tenant.id);
const later = (minutes = 11) => new Date(Date.now() + minutes * MIN);

/** 执行到期的提炼作业（默认越过 10 分钟的去抖）。 */
const drain = (now = later()) => drainMemoryJobs(s(), { now });

beforeAll(async () => {
	[alice, bob, carol] = (await createTeam(["Alice", "Bob", "Carol"])) as [
		TeamMember,
		TeamMember,
		TeamMember,
	];
	aliceTwin =
		alice.me.agents.find((a) => a.role === "front")?.principal.id ?? "";
	aliceOpsHandle =
		alice.me.agents.find((a) => a.role === "specialist")?.principal.handle ??
		"";
	dmAC = await openDm(alice.client, carol.me.principal.id);
	dmBA = await openDm(bob.client, alice.me.principal.id);
	ownDm = await openDm(alice.client, aliceTwin);
	group = await openGroup(alice.client, "记忆测试群", [
		bob.me.principal.id,
		carol.me.principal.id,
	]);
});

async function itemsBy(subjectId: string) {
	return s()
		.executor.select()
		.from(memoryItems)
		.where(s().where(memoryItems, eq(memoryItems.subjectId, subjectId)))
		.orderBy(desc(memoryItems.createdAt));
}

async function itemWith(text: string) {
	const [row] = await s().select(
		memoryItems,
		sql`${memoryItems.content} like ${`%${text}%`}`,
	);
	if (!row) throw new Error(`没有含“${text}”的条目`);
	return row;
}

/** bob 在与 alice 的私聊里问 alice 的分身，返回分身的最新回复。 */
async function bobAsks(text: string) {
	await say(bob.client, dmBA, text, { askTwin: true });
	const reply = messagesBy(await eventsOf(bob.client, dmBA), aliceTwin).at(-1);
	if (!reply) throw new Error("分身没有回复");
	return reply;
}

const sorted = (ids: string[]) => [...ids].sort();

describe("提炼：去抖与确定性", () => {
	it("人类消息排一个 10 分钟后执行的作业；新消息推后它；到期前不提炼", async () => {
		await say(
			alice.client,
			dmAC,
			"#fact 项目进展|和 Carol 确认星火项目完成 80%",
		);
		const topic = (await topicsOf(alice.client, dmAC))[0];
		const [job] = await s().select(
			memoryJobs,
			eq(memoryJobs.topicId, topic?.id ?? ""),
			eq(memoryJobs.status, "pending"),
		);
		expect(job?.trigger).toBe("idle");
		const first = job?.runAfter.getTime() ?? 0;
		expect(first - Date.now()).toBeGreaterThan(9 * MIN);
		await say(carol.client, dmAC, "收到，我这边同步给设计。");
		const [bumped] = await s().select(
			memoryJobs,
			eq(memoryJobs.id, job?.id ?? ""),
		);
		expect(bumped?.runAfter.getTime()).toBeGreaterThanOrEqual(first);
		expect(await drain(new Date())).toBe(0);
		expect(await itemsBy(alice.me.principal.id)).toEqual([]);
	});

	it("到期后：#fact 产出对应条目（类别、内容、出处、参与者可见范围），重复执行不重复写", async () => {
		expect(await drain()).toBeGreaterThan(0);
		const row = await itemWith("星火项目完成 80%");
		const events = await eventsOf(alice.client, dmAC);
		const source = events.find(
			(e) => e.type === "message.posted" && e.payload.text.includes("#fact"),
		);
		expect(row).toMatchObject({
			subjectId: alice.me.principal.id,
			kind: "fact",
			category: "项目进展",
			content: "和 Carol 确认星火项目完成 80%",
			status: "active",
			ownerCorrected: false,
			scope: {
				kind: "participants",
				principalIds: sorted([alice.me.principal.id, carol.me.principal.id]),
			},
			sources: [
				{
					kind: "event",
					id: String(source?.id),
					conversationId: dmAC,
					topicId: source?.topicId,
				},
			],
		});
		await say(
			alice.client,
			dmAC,
			"#fact 项目进展|和 Carol 确认星火项目完成 80%",
		);
		await drain();
		const same = await s().select(
			memoryItems,
			eq(memoryItems.content, "和 Carol 确认星火项目完成 80%"),
		);
		expect(same).toHaveLength(1);
	});

	it("计量挂在系统运行名下：runs 与 llm_requests 的代理为空，运行列表里不出现", async () => {
		const [run] = await s()
			.executor.select()
			.from(runs)
			.where(
				s().where(
					runs,
					isNull(runs.agentId),
					sql`${runs.trigger} like 'memory_job:%'`,
				),
			)
			.limit(1);
		expect(run).toMatchObject({ state: "completed", actingForId: null });
		const calls = await s().select(
			llmRequests,
			eq(llmRequests.runId, run?.id ?? ""),
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.agentId).toBeNull();
		const res = await alice.client.request(
			"GET",
			`/api/runs?topicId=${run?.topicId}`,
		);
		const body = (await res.json()) as { items: { id: string }[] };
		expect(body.items.map((r) => r.id)).not.toContain(run?.id);
	});
});

describe("可见范围按来源推导", () => {
	it("本人与自己的代理 → owner；群聊 → participants{当时的真人}；答复 → 两人", async () => {
		await say(alice.client, ownDm, "#fact 工作方式偏好|Alice 习惯上午写文档");
		await say(bob.client, group, "#fact 技术方案|订单服务改用双写迁移");
		await drain();
		expect((await itemWith("上午写文档")).scope).toEqual({
			kind: "owner",
			principalIds: [alice.me.principal.id],
		});
		const g = await itemWith("双写迁移");
		expect(g.subjectId).toBe(bob.me.principal.id);
		expect(g.scope).toEqual({
			kind: "participants",
			principalIds: sorted([
				alice.me.principal.id,
				bob.me.principal.id,
				carol.me.principal.id,
			]),
		});
	});

	it("上报被答复：不调模型直接写 decision，出处指向答复事件与待办", async () => {
		await alice.client.request("PATCH", "/api/me/status", { status: "busy" });
		await say(bob.client, dmBA, "#escalate 星火能否提前到 10 月 15 日");
		await alice.client.request("PATCH", "/api/me/status", {
			status: "available",
		});
		const items = (await (
			await alice.client.request("GET", "/api/work-items?status=open")
		).json()) as { items: { id: string; kind: string }[] };
		const item = items.items.find((w) => w.kind === "decision");
		const calls = await s().select(llmRequests);
		const res = await alice.client.request(
			"POST",
			`/api/work-items/${item?.id}/resolve`,
			{ action: "answer", text: "可以提前到 10 月 15 日" },
		);
		expect(res.status).toBe(200);
		const resolved = (await eventsOf(bob.client, dmBA)).find(
			(e) => e.type === "escalation.resolved",
		);
		const [job] = await s().select(
			memoryJobs,
			eq(memoryJobs.trigger, "resolution"),
			eq(memoryJobs.eventId, resolved?.id ?? 0),
		);
		expect(job).toBeTruthy();
		await drainMemoryJobs(s(), { now: new Date() });
		const decision = await itemWith("可以提前到 10 月 15 日");
		expect(decision).toMatchObject({
			kind: "decision",
			category: "决定与口径",
			subjectId: alice.me.principal.id,
			scope: {
				kind: "participants",
				principalIds: sorted([alice.me.principal.id, bob.me.principal.id]),
			},
		});
		expect(decision.sources).toEqual([
			expect.objectContaining({ kind: "event", id: String(resolved?.id) }),
			{ kind: "work_item", id: item?.id },
		]);
		// resolution 作业不调模型（此间新增的调用只来自分身恢复运行）。
		const after = await s().select(llmRequests, isNull(llmRequests.agentId));
		expect(after.length).toBe(calls.filter((c) => c.agentId === null).length);
	});
});

describe("替他人回答：类别授权与第三人规则", () => {
	it("bob 问 alice 的分身，alice 只在与 carol 的私聊里说过的进展：答出事实，不含 carol 的名字与原话", async () => {
		const reply = await bobAsks("#note 星火项目完成");
		expect(reply.payload.text).toMatch(/^完成：/);
		expect(reply.payload.text).toContain("星火项目完成 80%");
		expect(reply.payload.text).not.toContain("Carol");
		expect(reply.payload.text).not.toContain(carol.me.principal.handle);
		expect(reply.payload.text).not.toContain("#fact");
		expect(reply.payload.text).toContain("来自与同事的交流");
		expect(reply.payload.text).not.toMatch(/\[M:[0-9a-f]{8}\]/);
		const row = await itemWith("星火项目完成 80%");
		expect(reply.payload.citations).toEqual([
			{ id: row.id, content: "和 同事 确认星火项目完成 80%" },
		]);
		expect(reply.payload.askedById).toBe(bob.me.principal.id);
	});

	it("薪酬类默认不外露 → 无结果；本人开启后可外露（仍按第三人规则）", async () => {
		await say(alice.client, dmAC, "#fact 薪酬|Alice 月薪三万");
		await drain();
		expect((await itemWith("月薪三万")).category).toBe("薪酬");
		expect((await bobAsks("#note 月薪")).payload.text).toContain("无结果");

		const put = await alice.client.request("PUT", "/api/memory/disclosure", {
			category: "薪酬",
			allowed: true,
		});
		const { rules } = DisclosureResponseSchema.parse(await put.json());
		expect(rules).toHaveLength(14);
		expect(rules.find((r) => r.category === "薪酬")).toEqual({
			category: "薪酬",
			allowed: true,
			isDefault: false,
		});
		expect((await bobAsks("#note 月薪")).payload.text).toContain("月薪三万");
		await alice.client.request("PUT", "/api/memory/disclosure", {
			category: "薪酬",
			allowed: false,
		});
		expect((await bobAsks("#note 月薪")).payload.text).toContain("无结果");
	});

	it("本人自己问：能看到全部（含出处里的人名）", async () => {
		await say(alice.client, ownDm, "#note 月薪");
		const reply = messagesBy(await eventsOf(alice.client, ownDm), aliceTwin).at(
			-1,
		);
		expect(reply?.payload.text).toContain("月薪三万");
		expect(reply?.payload.askedById).toBeUndefined();
	});

	it("出处：会话成员能拿到原消息链接，非成员拿不到", async () => {
		const row = await itemWith("星火项目完成 80%");
		const links = async (c: TeamMember) =>
			MemorySourcesResponseSchema.parse(
				await (
					await c.client.request("GET", `/api/memory/items/${row.id}/sources`)
				).json(),
			).links;
		expect(await links(carol)).toEqual([
			expect.objectContaining({ conversationId: dmAC, label: "与Alice的私聊" }),
		]);
		expect(await links(bob)).toEqual([]);
	});
});

describe("取代链、本人更正与撤回", () => {
	let answer: Event;

	it("新情况取代旧条目：旧的 superseded 并链到新的，只检索到新的", async () => {
		await say(alice.client, dmAC, "#fact 排期与交付|星火项目 10 月 20 日上线");
		await drain();
		const old = await itemWith("10 月 20 日上线");
		await say(
			alice.client,
			dmAC,
			"#fact 排期与交付|星火项目改到 10 月 25 日上线|supersede",
		);
		await drain();
		const next = await itemWith("10 月 25 日上线");
		const [was] = await s().select(memoryItems, eq(memoryItems.id, old.id));
		expect(was).toMatchObject({
			status: "superseded",
			supersededById: next.id,
		});
		const reply = await bobAsks("#note 星火 上线");
		expect(reply.payload.text).toContain("10 月 25 日上线");
		expect(reply.payload.text).not.toContain("10 月 20 日上线");
		answer = reply;
	});

	it("代答记录列出这次回答（谁问、答了什么、依据）；“不对”写本人更正并取代被引用的条目", async () => {
		const res = await alice.client.request("GET", "/api/memory/answers");
		const { items } = TwinAnswerListResponseSchema.parse(await res.json());
		const found = items.find((a) => a.answer.id === answer.id);
		expect(found).toMatchObject({
			askedById: bob.me.principal.id,
			conversationId: dmBA,
			handled: null,
		});
		expect(found?.question?.type).toBe("message.posted");
		const cited = await itemWith("10 月 25 日上线");
		expect(found?.citedStatus).toMatchObject({ [cited.id]: "active" });
		expect(
			(await bob.client.request("GET", "/api/memory/answers")).status,
		).toBe(200);
		expect(
			(
				await bob.client.request(
					"POST",
					`/api/memory/answers/${answer.id}/correct`,
					{ text: "x" },
				)
			).status,
		).toBe(404);

		expect(
			(
				await alice.client.request(
					"POST",
					`/api/memory/answers/${answer.id}/correct`,
					{ text: "x", replaces: [aliceTwin] },
				)
			).status,
		).toBe(400);
		const fix = await alice.client.request(
			"POST",
			`/api/memory/answers/${answer.id}/correct`,
			{ text: "星火项目上线日期待定，等 15 日对账结果", replaces: [cited.id] },
		);
		expect(fix.status).toBe(201);
		const [correction, superseded] = AnswerActionResponseSchema.parse(
			await fix.json(),
		).items;
		expect(correction).toMatchObject({
			ownerCorrected: true,
			category: "排期与交付",
			subjectId: alice.me.principal.id,
			scope: { kind: "owner", principalIds: [alice.me.principal.id] },
		});
		expect(superseded).toMatchObject({
			id: cited.id,
			status: "superseded",
			supersededById: correction?.id,
		});
		const again = await bobAsks("#note 星火 上线");
		expect(again.payload.text).toContain("待定");
		expect(again.payload.citations?.[0]?.id).toBe(correction?.id);
		const list = TwinAnswerListResponseSchema.parse(
			await (await alice.client.request("GET", "/api/memory/answers")).json(),
		).items;
		expect(list.find((a) => a.answer.id === answer.id)?.handled).toBe(
			"corrected",
		);
	});

	it("撤回后不再被检索；别人撤回不了", async () => {
		const correction = await itemWith("待定");
		expect(
			(
				await bob.client.request(
					"POST",
					`/api/memory/items/${correction.id}/retract`,
				)
			).status,
		).toBe(404);
		const res = await alice.client.request(
			"POST",
			`/api/memory/items/${correction.id}/retract`,
		);
		expect(res.status).toBe(200);
		expect((await bobAsks("#note 星火 上线")).payload.text).not.toContain(
			"待定",
		);
	});

	it("“不许对外说”：改成允许对外的类别 → 400；改成不对外的类别后不再外露", async () => {
		const reply = await bobAsks("#note 星火项目完成");
		const url = `/api/memory/answers/${reply.id}/withhold`;
		expect(
			(
				await alice.client.request("POST", url, {
					mode: "category",
					category: "项目进展",
				})
			).status,
		).toBe(400);
		const res = await alice.client.request("POST", url, {
			mode: "category",
			category: "私人事务",
		});
		expect(res.status).toBe(200);
		expect((await itemWith("星火项目完成 80%")).category).toBe("私人事务");
		expect((await bobAsks("#note 星火项目完成")).payload.text).not.toContain(
			"80%",
		);
	});
});

describe("本人的记忆页接口", () => {
	it("只列自己的条目，可搜索、编辑（记为本人更正）；别人的 404", async () => {
		const list = MemoryItemListResponseSchema.parse(
			await (
				await alice.client.request("GET", "/api/memory/items?q=上午")
			).json(),
		).items;
		expect(list.map((i) => i.content)).toEqual(["Alice 习惯上午写文档"]);
		const id = list[0]?.id ?? "";
		const patched = await alice.client.request(
			"PATCH",
			`/api/memory/items/${id}`,
			{ content: "Alice 习惯上午写文档、下午开会" },
		);
		expect(patched.status).toBe(200);
		expect((await itemWith("下午开会")).ownerCorrected).toBe(true);
		expect(
			(
				await bob.client.request("PATCH", `/api/memory/items/${id}`, {
					content: "x",
				})
			).status,
		).toBe(404);
		const bobs = MemoryItemListResponseSchema.parse(
			await (await bob.client.request("GET", "/api/memory/items")).json(),
		).items;
		expect(bobs.every((i) => i.subjectId === bob.me.principal.id)).toBe(true);
	});
});

describe("画像只拼可见段落", () => {
	it("为 bob：只给不涉及第三人、类别可外露的段落；为本人：全部；撤回的条目所在段落不再给出", async () => {
		const now = new Date();
		await rebuildProfile(s(), alice.me.principal.id, createMockLlm(), now);
		const owner = { ownerId: alice.me.principal.id, requesterId: null };
		const forBob = { ...owner, requesterId: bob.me.principal.id };
		const mine = await visibleSections(s(), alice.me.principal.id, owner);
		const theirs = await visibleSections(s(), alice.me.principal.id, forBob);
		const texts = (xs: { text: string }[]) => xs.map((x) => x.text);
		expect(texts(mine)).toEqual(
			expect.arrayContaining([
				"Alice 习惯上午写文档、下午开会",
				"Alice 月薪三万",
			]),
		);
		expect(texts(theirs)).toContain("Alice 习惯上午写文档、下午开会");
		expect(texts(theirs)).not.toContain("Alice 月薪三万");
		expect(texts(theirs).some((t) => t.includes("星火项目"))).toBe(false);
		expect(texts(mine).some((t) => t.includes("星火项目"))).toBe(true);
		// 与 bob 本人的答复（scope 含 bob）可见。
		expect(
			texts(theirs).some((t) => t.includes("可以提前到 10 月 15 日")),
		).toBe(true);
		const reply = await bobAsks("#note 上午 文档");
		expect(reply.payload.text).toContain("[画像·");

		const pref = await itemWith("下午开会");
		await alice.client.request("POST", `/api/memory/items/${pref.id}/retract`);
		expect(
			texts(await visibleSections(s(), alice.me.principal.id, forBob)),
		).not.toContain("Alice 习惯上午写文档、下午开会");
	});
});

describe("校验与清洗", () => {
	it("模型给出的出处不在本批材料里：整条丢弃", async () => {
		await say(alice.client, dmAC, "伪造出处测试：这条消息之后不会有条目");
		const forged: LlmClient = {
			async complete(req) {
				if (!req.trigger.memory) throw new Error("只用于提炼");
				return {
					text: JSON.stringify({
						items: [
							{
								subject: alice.me.principal.handle,
								kind: "fact",
								category: "项目进展",
								content: "伪造出处的条目",
								sources: [1],
							},
						],
					}),
					toolCalls: [],
					reasoning: false,
				};
			},
		};
		await drainMemoryJobs(s(), { now: later(), llm: forged });
		expect(
			await s().select(memoryItems, eq(memoryItems.content, "伪造出处的条目")),
		).toEqual([]);
	});

	it("写入前抹掉凭据", async () => {
		await say(
			alice.client,
			dmAC,
			"#fact 技术方案|测试库密码: hunter2secret 已更新",
		);
		await drain();
		const row = await itemWith("测试库密码");
		expect(row.content).not.toContain("hunter2secret");
		expect(row.content).toContain("«已抹去 13 字符»");
	});
});

describe("任务结束与压缩前触发提炼", () => {
	const env = { ...process.env };
	afterEach(() => {
		for (const k of ["ORGOS_COMPACT_MAX_EVENTS", "ORGOS_COMPACT_KEEP_TOKENS"])
			if (env[k] === undefined) delete process.env[k];
			else process.env[k] = env[k];
	});

	it("任务结束：给任务话题排 task_end 作业，提炼其中的过程与结果", async () => {
		await say(
			alice.client,
			ownDm,
			`#delegate:${aliceOpsHandle} #fact 项目进展|周报初稿已整理完`,
		);
		const [task] = await s()
			.executor.select()
			.from(tasks)
			.where(s().where(tasks, eq(tasks.requesterId, aliceTwin)))
			.orderBy(desc(tasks.createdAt))
			.limit(1);
		expect(task?.state).toBe("completed");
		const [job] = await s().select(
			memoryJobs,
			eq(memoryJobs.topicId, task?.topicId ?? ""),
			eq(memoryJobs.trigger, "task_end"),
		);
		expect(job?.status).toBe("pending");
		await drainMemoryJobs(s(), { now: new Date() });
		const row = await itemWith("周报初稿已整理完");
		expect(row.sources[0]?.topicId).toBe(task?.topicId);
		expect(row.scope).toEqual({
			kind: "owner",
			principalIds: [alice.me.principal.id],
		});
	});

	it("压缩前：排 compaction 作业，被压缩的那段即材料", async () => {
		process.env.ORGOS_COMPACT_MAX_EVENTS = "6";
		process.env.ORGOS_COMPACT_KEEP_TOKENS = "40";
		const res = await alice.client.request(
			"POST",
			`/api/conversations/${ownDm}/topics`,
			{ title: "压缩测试" },
		);
		const topicId = ((await res.json()) as { topic: { id: string } }).topic.id;
		const post = (text: string) =>
			alice.client
				.request("POST", `/api/conversations/${ownDm}/messages`, {
					text,
					topicId,
				})
				.then(async (r) => {
					expect(r.status).toBe(201);
					const { scheduler } = await import("@/agent/scheduler");
					await scheduler.idle(ownDm);
				});
		await post("#fact 技术方案|压缩前说过的方案 A");
		for (const n of ["二", "三", "四"]) await post(`第${n}件事`);
		const jobs = await s().select(
			memoryJobs,
			and(
				eq(memoryJobs.topicId, topicId),
				eq(memoryJobs.trigger, "compaction"),
			),
		);
		expect(jobs.length).toBeGreaterThan(0);
		await drainMemoryJobs(s(), { now: new Date() });
		expect((await itemWith("压缩前说过的方案 A")).sources[0]?.topicId).toBe(
			topicId,
		);
	});
});

describe("协商结束：直写 decision", () => {
	it("谈妥：双方本人各一条 decision，可见范围为两人，出处是协商结束事件", async () => {
		await say(
			alice.client,
			ownDm,
			`#negotiate:${bob.me.principal.handle} 约周四讨论星火预算`,
		);
		const started = (await eventsOf(bob.client, dmBA)).findLast(
			(e) => e.type === "negotiation.started",
		);
		if (started?.type !== "negotiation.started") throw new Error("没有协商");
		const { scheduler } = await import("@/agent/scheduler");
		await scheduler.idle(started.payload.negotiationConversationId);
		await drainMemoryJobs(s(), { now: new Date() });
		const rows = await s().select(
			memoryItems,
			eq(memoryItems.kind, "decision"),
			sql`${memoryItems.content} like '%经代理协商约定%'`,
		);
		expect(sorted(rows.map((r) => r.subjectId))).toEqual(
			sorted([alice.me.principal.id, bob.me.principal.id]),
		);
		expect(rows[0]?.content).toContain("周四 15:00");
		expect(rows[0]?.scope).toEqual({
			kind: "participants",
			principalIds: sorted([alice.me.principal.id, bob.me.principal.id]),
		});
		expect(rows[0]?.sources[0]?.conversationId).toBe(
			started.payload.negotiationConversationId,
		);
	});
});

describe("统一检索工具", () => {
	it("memory_search 取代 knowledge_search：旧工具已从工具表删除", async () => {
		const names = TOOLS.map((t) => t.name);
		expect(names).toContain("memory_search");
		expect(names).not.toContain("knowledge_search");
	});
});
