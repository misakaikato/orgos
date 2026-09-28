/**
 * 集成（MOCK_LLM=1）：C4 分身之间的协商——negotiate 发起、两个分身轮流 negotiation_reply、
 * 判定（agreed / rejected / exhausted / need_owner 后恢复）、结果摘要、确认待办的 confirm / reject。
 */
import {
	type BrowserFrame,
	ErrorBodySchema,
	type Event,
	type WorkItem,
	WorkItemListResponseSchema,
	WorkItemResponseSchema,
} from "@orgos/protocol";
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { LlmClient, LlmRequest, LlmResult } from "@/agent/llm-types";
import { MOCK_PROPOSAL } from "@/agent/mock-llm";
import { Scheduler, scheduler } from "@/agent/scheduler";
import { NOT_FOUND_TEXT } from "@/agent/tools/negotiate";
import { conversations, llmRequests, workItems } from "@/db/schema";
import { scoped } from "@/db/scope";
import {
	deepEqual,
	judgeStep,
	negotiationStateOf,
	startNegotiation,
} from "@/services/negotiations";
import {
	actions,
	captureFrames,
	eventsOf,
	messagesBy,
	openDm,
	say,
} from "./agent-helpers";
import { type Client, createTeam, type TeamMember } from "./helpers";

let alice: TeamMember;
let bob: TeamMember;
let carol: TeamMember;
let dave: TeamMember;
let aliceTwin: string;
let aliceOps: string;
let bobTwin: string;
let carolTwin: string;
let ownDm: string;
let pairDm: string;

const twinOf = (m: TeamMember) =>
	m.me.agents.find((a) => a.role === "front")?.principal.id ?? "";

beforeAll(async () => {
	[alice, bob, carol] = (await createTeam(["Alice", "Bob", "Carol"])) as [
		TeamMember,
		TeamMember,
		TeamMember,
	];
	[dave] = (await createTeam(["Dave"])) as [TeamMember];
	aliceTwin = twinOf(alice);
	bobTwin = twinOf(bob);
	carolTwin = twinOf(carol);
	aliceOps =
		alice.me.agents.find((a) => a.role === "specialist")?.principal.id ?? "";
	ownDm = await openDm(alice.client, aliceTwin);
	pairDm = await openDm(alice.client, bob.me.principal.id);
});

function tenant() {
	return scoped(alice.me.tenant.id);
}

const handleOf = (m: TeamMember) => m.me.principal.handle;

async function openItems(c: Client): Promise<WorkItem[]> {
	const res = await c.request("GET", "/api/work-items?status=open");
	expect(res.status).toBe(200);
	return WorkItemListResponseSchema.parse(await res.json()).items;
}

function resolve(c: Client, id: string, body: unknown): Promise<Response> {
	return c.request("POST", `/api/work-items/${id}/resolve`, body);
}

async function expectError(res: Response, status: number, code: string) {
	expect(res.status).toBe(status);
	expect(ErrorBodySchema.parse(await res.json()).error.code).toBe(code);
}

async function negotiationCount(): Promise<number> {
	return (
		await tenant().select(conversations, eq(conversations.kind, "negotiation"))
	).length;
}

type Step = Extract<Event, { type: "negotiation.step" }>;
const stepsIn = (events: readonly Event[]) =>
	events.filter((e): e is Step => e.type === "negotiation.step");
const endedIn = (events: readonly Event[]) =>
	events.find((e) => e.type === "negotiation.ended");

async function confirmationRows(negotiationId: string) {
	return tenant().select(
		workItems,
		eq(workItems.kind, "confirmation"),
		sql`${workItems.payload}->>'negotiationConversationId' = ${negotiationId}`,
	);
}

const confirmationsOf = (items: WorkItem[], negotiationId: string) =>
	items.filter(
		(w) =>
			w.kind === "confirmation" &&
			w.payload.negotiationConversationId === negotiationId,
	);

/** alice 对自己的分身发起协商，等协商跑完（或停在等本人），返回协商会话 id。 */
async function negotiate(goal: string): Promise<string> {
	await say(alice.client, ownDm, `#negotiate:${handleOf(bob)} ${goal}`);
	const started = (await eventsOf(alice.client, pairDm)).findLast(
		(e) => e.type === "negotiation.started",
	);
	if (started?.type !== "negotiation.started") throw new Error("没有协商卡片");
	expect(started.payload.goal).toBe(goal);
	const id = started.payload.negotiationConversationId;
	await scheduler.idle(id);
	return id;
}

describe("C4 agreed：两个分身谈妥，双方本人确认", () => {
	let negotiationId: string;
	let aliceFrames: BrowserFrame[];
	let bobFrames: BrowserFrame[];

	beforeAll(async () => {
		const a = captureFrames(alice.me.principal.id);
		const b = captureFrames(bob.me.principal.id);
		try {
			negotiationId = await negotiate("约周四讨论预算");
		} finally {
			a.stop();
			b.stop();
		}
		aliceFrames = a.frames;
		bobFrames = b.frames;
	});

	it("协商会话 kind=negotiation，两位分身为成员、两位本人为 observer，且不在两人的会话列表里", async () => {
		const row = await tenant().first(
			conversations,
			eq(conversations.id, negotiationId),
		);
		expect(row?.kind).toBe("negotiation");
		for (const who of [alice, bob]) {
			const res = await who.client.request("GET", "/api/conversations");
			const { items } = (await res.json()) as {
				items: { conversation: { id: string; kind: string } }[];
			};
			expect(items.some((x) => x.conversation.id === negotiationId)).toBe(
				false,
			);
			expect(items.some((x) => x.conversation.kind === "negotiation")).toBe(
				false,
			);
		}
		expect(
			(
				await carol.client.request(
					"GET",
					`/api/conversations/${negotiationId}/events`,
				)
			).status,
		).toBe(404);
	});

	it("两人私聊里有 negotiation.started（actor 为 alice 的分身）；原会话记了 negotiate 动作", async () => {
		const started = (await eventsOf(bob.client, pairDm)).filter(
			(e) => e.type === "negotiation.started",
		);
		expect(started.at(-1)).toMatchObject({
			actorId: aliceTwin,
			onBehalfOfId: alice.me.principal.id,
			payload: { negotiationConversationId: negotiationId },
		});
		const own = await eventsOf(alice.client, ownDm);
		expect(
			actions(own).find((a) => a.payload.tool === "negotiate")?.payload,
		).toMatchObject({ ok: true });
	});

	it("发起方先提议、应答方 agree 同一 proposal → agreed，proposal 为 {slot:周四 15:00}", async () => {
		const events = await eventsOf(alice.client, negotiationId);
		const steps = stepsIn(events);
		expect(
			steps.map((e) => [e.actorId, e.payload.step, e.payload.status]),
		).toEqual([
			[aliceTwin, 1, "continue"],
			[bobTwin, 2, "agree"],
		]);
		expect(steps[0]?.payload.proposal).toEqual(MOCK_PROPOSAL);
		expect(endedIn(events)).toMatchObject({
			actorId: aliceTwin,
			payload: { outcome: "agreed", proposal: { slot: "周四 15:00" } },
		});
		expect(await negotiationStateOf(tenant(), negotiationId)).toMatchObject({
			state: "ended",
			step: 2,
		});
		expect(events.some((e) => e.type === "message.posted")).toBe(false);
		const rows = await tenant().select(
			llmRequests,
			eq(llmRequests.conversationId, negotiationId),
		);
		expect(rows.map((r) => r.agentId).sort()).toEqual(
			[aliceTwin, bobTwin].sort(),
		);
	});

	it("发起方分身在原会话回一句结果摘要", async () => {
		const texts = messagesBy(
			await eventsOf(alice.client, ownDm),
			aliceTwin,
		).map((m) => m.payload.text);
		expect(
			texts.some((t) => t.startsWith("完成：已发起与Bob的分身的协商")),
		).toBe(true);
		expect(texts).toContain(
			"和Bob的分身谈妥了：周四 15:00。等你和Bob都确认后就算定下来，确认入口在待办和你们的私聊里。",
		);
	});

	it("两人各有一条 confirmation 待办（按各自视角的标题、关联私聊、带 proposal），并推给各自", async () => {
		for (const [who, other, otherName, frames] of [
			[alice, bobTwin, "Bob", aliceFrames],
			[bob, aliceTwin, "Alice", bobFrames],
		] as const) {
			const [item, ...rest] = confirmationsOf(
				await openItems(who.client),
				negotiationId,
			);
			expect(rest).toEqual([]);
			expect(item).toMatchObject({
				kind: "confirmation",
				title: `确认与${otherName}的约定：周四 15:00`,
				status: "open",
				ownerId: who.me.principal.id,
				requesterId: other,
				conversationId: pairDm,
				payload: {
					negotiationConversationId: negotiationId,
					proposal: MOCK_PROPOSAL,
				},
			});
			expect(
				frames.some((f) => f.t === "work_item" && f.workItem.id === item?.id),
			).toBe(true);
		}
	});

	it("两人都 confirm → 两条均 done，协商会话落 confirmation.resolved ×2", async () => {
		for (const who of [alice, bob]) {
			const [item] = confirmationsOf(
				await openItems(who.client),
				negotiationId,
			);
			const res = await resolve(who.client, item?.id ?? "", {
				action: "confirm",
			});
			expect(res.status).toBe(200);
			const { workItem } = WorkItemResponseSchema.parse(await res.json());
			expect(workItem).toMatchObject({
				status: "done",
				resolution: { action: "confirm" },
			});
		}
		expect(
			(await confirmationRows(negotiationId)).map((w) => w.status),
		).toEqual(["done", "done"]);
		const resolved = (await eventsOf(bob.client, negotiationId)).filter(
			(e) => e.type === "confirmation.resolved",
		);
		expect(
			resolved.map((e) => [
				e.actorId,
				e.type === "confirmation.resolved" && e.payload.action,
			]),
		).toEqual([
			[alice.me.principal.id, "confirm"],
			[bob.me.principal.id, "confirm"],
		]);
	});
});

describe("C4 need_owner：应答方请本人定，本人答复后协商继续并结束", () => {
	let negotiationId: string;
	let decision: WorkItem;

	beforeAll(async () => {
		negotiationId = await negotiate("约周五 #needowner");
		const items = (await openItems(bob.client)).filter(
			(w) =>
				w.kind === "decision" &&
				w.payload.negotiationConversationId === negotiationId,
		);
		expect(items).toHaveLength(1);
		decision = items[0] as WorkItem;
	});

	it("停在 waiting_owner：bob 收到 decision 待办，卡片落在两人私聊", async () => {
		expect(await negotiationStateOf(tenant(), negotiationId)).toMatchObject({
			state: "waiting_owner",
			step: 2,
		});
		const events = await eventsOf(alice.client, negotiationId);
		expect(stepsIn(events).at(-1)).toMatchObject({
			actorId: bobTwin,
			payload: { status: "need_owner" },
		});
		expect(endedIn(events)).toBeUndefined();
		expect(decision).toMatchObject({
			kind: "decision",
			ownerId: bob.me.principal.id,
			requesterId: aliceTwin,
			conversationId: pairDm,
			payload: {
				askedById: aliceTwin,
				negotiationConversationId: negotiationId,
				options: ["接受：周四 15:00", "改约其他时间", "不约了"],
			},
		});
		expect(
			(await eventsOf(alice.client, pairDm)).findLast(
				(e) => e.type === "escalation.created",
			),
		).toMatchObject({
			actorId: bobTwin,
			payload: {
				workItemId: decision.id,
				negotiationConversationId: negotiationId,
				options: ["接受：周四 15:00", "改约其他时间", "不约了"],
			},
		});
	});

	it("bob 答复后恢复 bob 的分身，协商继续直到 agreed；私聊里没有分身的回复消息", async () => {
		const res = await resolve(bob.client, decision.id, {
			action: "answer",
			text: "可以",
		});
		expect(res.status).toBe(200);
		await scheduler.idle(negotiationId);
		const events = await eventsOf(bob.client, negotiationId);
		expect(stepsIn(events).map((e) => [e.actorId, e.payload.status])).toEqual([
			[aliceTwin, "continue"],
			[bobTwin, "need_owner"],
			[bobTwin, "continue"],
			[aliceTwin, "continue"],
			[bobTwin, "agree"],
		]);
		expect(stepsIn(events)[2]?.payload.message).toBe("本人答复：可以");
		expect(endedIn(events)).toMatchObject({ payload: { outcome: "agreed" } });
		expect(
			confirmationsOf(await openItems(bob.client), negotiationId),
		).toHaveLength(1);
		const dm = await eventsOf(bob.client, pairDm);
		expect(messagesBy(dm, bobTwin)).toEqual([]);
		expect(messagesBy(dm, aliceTwin)).toEqual([]);
		expect(dm.findLast((e) => e.type === "escalation.resolved")).toMatchObject({
			payload: { workItemId: decision.id, action: "answer" },
		});
	});
});

describe("C4 rejected", () => {
	it("应答方 reject → outcome=rejected，没有 confirmation 待办，原会话摘要说明没谈成", async () => {
		const negotiationId = await negotiate("约周六 #reject");
		const events = await eventsOf(alice.client, negotiationId);
		expect(stepsIn(events).map((e) => e.payload.status)).toEqual([
			"continue",
			"reject",
		]);
		expect(endedIn(events)).toMatchObject({ payload: { outcome: "rejected" } });
		expect(await confirmationRows(negotiationId)).toEqual([]);
		expect(
			messagesBy(await eventsOf(alice.client, ownDm), aliceTwin).map(
				(m) => m.payload.text,
			),
		).toContain("和Bob的分身没谈成：这个时间不行");
	});
});

/** 按顺序回放给定的模型输出；每个元素是一次调用的结果。 */
function scriptedLlm(script: ((req: LlmRequest) => LlmResult)[]) {
	const calls: LlmRequest[] = [];
	const llm: LlmClient = {
		async complete(req) {
			const next = script[calls.length] ?? script.at(-1);
			calls.push(req);
			if (!next) throw new Error("脚本为空");
			return next(req);
		},
	};
	return { llm, calls };
}

const reply = (args: Record<string, unknown>) => (): LlmResult => ({
	text: "",
	toolCalls: [
		{
			id: "call",
			name: "negotiation_reply",
			arguments: JSON.stringify(args),
		},
	],
	reasoning: false,
});

async function freshNegotiation(goal: string) {
	return startNegotiation(tenant(), {
		initiatorAgentId: carolTwin,
		responderAgentId: twinOf(bob),
		goal,
		title: goal,
	});
}

describe("C4 判定与协议", () => {
	it("来回 8 步没谈拢 → exhausted，第 8 步后不再运行，无确认待办", async () => {
		let n = 0;
		const { llm, calls } = scriptedLlm([
			() =>
				reply({
					status: "continue",
					message: "换一个",
					proposal: { n: ++n },
				})(),
		]);
		const sched = new Scheduler({ llm: () => llm });
		const nego = await freshNegotiation("来回拉锯");
		await sched.negotiate(tenant(), nego.id);
		const events = await eventsOf(carol.client, nego.id);
		expect(stepsIn(events).map((e) => e.payload.step)).toEqual([
			1, 2, 3, 4, 5, 6, 7, 8,
		]);
		expect(stepsIn(events).map((e) => e.actorId)).toEqual(
			[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (i % 2 ? carolTwin : bobTwin)),
		);
		expect(endedIn(events)).toMatchObject({
			payload: { outcome: "exhausted", proposal: { n: 8 } },
		});
		expect(calls).toHaveLength(8);
		expect(await confirmationRows(nego.id)).toEqual([]);
	});

	it("运行没有以 negotiation_reply 结束 → 视为 continue，message 取其文本", async () => {
		const { llm } = scriptedLlm([
			() => ({ text: "我再想想", toolCalls: [], reasoning: false }),
			reply({ status: "reject", message: "不约了" }),
		]);
		const sched = new Scheduler({ llm: () => llm });
		const nego = await freshNegotiation("自由发挥");
		await sched.negotiate(tenant(), nego.id);
		const steps = stepsIn(await eventsOf(carol.client, nego.id));
		expect(steps[0]).toMatchObject({
			actorId: carolTwin,
			payload: { step: 1, status: "continue", message: "我再想想" },
		});
		expect(steps[0]?.payload.proposal).toBeUndefined();
		expect(steps[1]?.payload.status).toBe("reject");
	});

	it("agree 与对方最近的 proposal 不一致：工具退回、不算一步；改正后达成", async () => {
		const offer = { 日期: "周二", 时间: "15:00" };
		const { llm, calls } = scriptedLlm([
			reply({ status: "continue", message: "周二 15:00？", proposal: offer }),
			reply({ status: "agree", message: "好", proposal: { 日期: "周二" } }),
			reply({
				status: "agree",
				message: "好",
				proposal: { 时间: "15:00", 日期: "周二" },
			}),
		]);
		const sched = new Scheduler({ llm: () => llm });
		const nego = await freshNegotiation("约周二");
		await sched.negotiate(tenant(), nego.id);
		const events = await eventsOf(carol.client, nego.id);
		expect(stepsIn(events).map((e) => e.payload.status)).toEqual([
			"continue",
			"agree",
		]);
		expect(endedIn(events)).toMatchObject({
			payload: { outcome: "agreed", proposal: offer },
		});
		const rejected = calls[2]?.messages.findLast((m) => m.role === "tool");
		expect(rejected?.content).toContain("没有提交");
	});

	it("不能 agree 自己提的方案", async () => {
		const offer = { slot: "周三" };
		const { llm } = scriptedLlm([
			reply({ status: "continue", message: "周三？", proposal: offer }),
			reply({ status: "continue", message: "我想想" }),
			reply({ status: "agree", message: "那就周三", proposal: offer }),
			reply({ status: "reject", message: "不行" }),
		]);
		const sched = new Scheduler({ llm: () => llm });
		const nego = await freshNegotiation("约周三");
		await sched.negotiate(tenant(), nego.id);
		const events = await eventsOf(carol.client, nego.id);
		expect(stepsIn(events).map((e) => [e.actorId, e.payload.status])).toEqual([
			[carolTwin, "continue"],
			[bobTwin, "continue"],
			[carolTwin, "reject"],
		]);
		expect(endedIn(events)).toMatchObject({ payload: { outcome: "rejected" } });
	});
});

describe("negotiate 的对象与可用范围", () => {
	it("找不到此人：不存在、自己、别的租户、代理 → 工具返回“找不到此人”，不建会话", async () => {
		const before = await negotiationCount();
		for (const who of [
			"nobody-here",
			handleOf(alice),
			handleOf(dave),
			bob.me.agents[0]?.principal.handle ?? "",
		]) {
			await say(alice.client, ownDm, `#negotiate:${who} 约一下`);
			const events = await eventsOf(alice.client, ownDm);
			expect(actions(events).at(-1)?.payload).toMatchObject({
				tool: "negotiate",
				ok: false,
			});
			expect(messagesBy(events, aliceTwin).at(-1)?.payload.text).toBe(
				`完成：${NOT_FOUND_TEXT}`,
			);
		}
		expect(await negotiationCount()).toBe(before);
	});

	it("只有分身为本人时可用：执行助手、替他人办事的分身 → 无权限", async () => {
		const before = await negotiationCount();
		const opsDm = await openDm(alice.client, aliceOps);
		await say(alice.client, opsDm, `#negotiate:${handleOf(bob)} 约一下`);
		expect(
			messagesBy(await eventsOf(alice.client, opsDm), aliceOps).at(-1)?.payload
				.text,
		).toContain("无权限");
		await say(bob.client, pairDm, `#negotiate:${handleOf(carol)} 约一下`, {
			askTwin: true,
		});
		expect(
			messagesBy(await eventsOf(bob.client, pairDm), aliceTwin).at(-1)?.payload
				.text,
		).toContain("无权限");
		expect(await negotiationCount()).toBe(before);
	});
});

describe("确认待办的处理", () => {
	/** 新协商并谈妥，返回 alice 与 bob 各自的确认待办。 */
	async function agreed(): Promise<{
		mine: WorkItem;
		theirs: WorkItem;
		id: string;
	}> {
		const id = await negotiate("约周一");
		const [mine] = confirmationsOf(await openItems(alice.client), id);
		const [theirs] = confirmationsOf(await openItems(bob.client), id);
		if (!mine || !theirs) throw new Error("缺少确认待办");
		return { mine, theirs, id };
	}

	it("不是处理人、跨租户、不存在 → 404；动作不符 → 400", async () => {
		const { mine } = await agreed();
		await expectError(
			await resolve(bob.client, mine.id, { action: "confirm" }),
			404,
			"NOT_FOUND",
		);
		await expectError(
			await resolve(dave.client, mine.id, { action: "confirm" }),
			404,
			"NOT_FOUND",
		);
		await expectError(
			await resolve(alice.client, crypto.randomUUID(), { action: "confirm" }),
			404,
			"NOT_FOUND",
		);
		await expectError(
			await resolve(alice.client, mine.id, { action: "answer", text: "好" }),
			400,
			"WORK_ITEM_ACTION_MISMATCH",
		);
	});

	it("一方 reject：自己 done（resolution reject），另一条 cancelled 并推给对方；对方再处理 → 409", async () => {
		const { mine, theirs, id } = await agreed();
		const bobCap = captureFrames(bob.me.principal.id);
		let res: Response;
		try {
			res = await resolve(alice.client, mine.id, { action: "reject" });
		} finally {
			bobCap.stop();
		}
		expect(res.status).toBe(200);
		expect(
			WorkItemResponseSchema.parse(await res.json()).workItem,
		).toMatchObject({
			status: "done",
			resolution: { action: "reject" },
		});
		const rows = await confirmationRows(id);
		expect(rows.find((w) => w.id === theirs.id)?.status).toBe("cancelled");
		expect(
			bobCap.frames.some(
				(f) =>
					f.t === "work_item" &&
					f.workItem.id === theirs.id &&
					f.workItem.status === "cancelled",
			),
		).toBe(true);
		await expectError(
			await resolve(bob.client, theirs.id, { action: "confirm" }),
			409,
			"WORK_ITEM_NOT_OPEN",
		);
		const resolved = (await eventsOf(alice.client, id)).filter(
			(e) => e.type === "confirmation.resolved",
		);
		expect(resolved).toHaveLength(1);
		expect(resolved[0]).toMatchObject({
			actorId: alice.me.principal.id,
			payload: { workItemId: mine.id, action: "reject" },
		});
	});

	it("已确认再处理 → 409；同一条并发处理只有一个成功、只落一条事件", async () => {
		const { mine, theirs, id } = await agreed();
		const results = await Promise.all([
			resolve(alice.client, mine.id, { action: "confirm" }),
			resolve(alice.client, mine.id, { action: "confirm" }),
		]);
		expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
		await expectError(
			await resolve(alice.client, mine.id, { action: "reject" }),
			409,
			"WORK_ITEM_NOT_OPEN",
		);
		expect(
			(await eventsOf(alice.client, id)).filter(
				(e) => e.type === "confirmation.resolved",
			),
		).toHaveLength(1);
		expect(
			(await resolve(bob.client, theirs.id, { action: "confirm" })).status,
		).toBe(200);
	});

	it("双方同时驳回：一个成功、另一个 409（已被对方作废），不死锁", async () => {
		const { mine, theirs, id } = await agreed();
		const results = await Promise.all([
			resolve(alice.client, mine.id, { action: "reject" }),
			resolve(bob.client, theirs.id, { action: "reject" }),
		]);
		expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
		const rows = await confirmationRows(id);
		expect(rows.map((w) => w.status).sort()).toEqual(["cancelled", "done"]);
		expect(
			(await eventsOf(alice.client, id)).filter(
				(e) => e.type === "confirmation.resolved",
			),
		).toHaveLength(1);
	});
});

describe("judgeStep（纯函数）", () => {
	const base = {
		initiatorAgentId: crypto.randomUUID(),
		responderAgentId: crypto.randomUUID(),
		goal: "g",
		step: 0,
		maxSteps: 8,
		state: "running" as const,
	};
	const a = base.initiatorAgentId;
	const b = base.responderAgentId;

	it("深度相等不看键顺序、看数组顺序", () => {
		expect(
			deepEqual({ x: 1, y: [1, { z: 2 }] }, { y: [1, { z: 2 }], x: 1 }),
		).toBe(true);
		expect(deepEqual({ y: [1, 2] }, { y: [2, 1] })).toBe(false);
		expect(deepEqual({ x: 1 }, { x: 1, y: undefined })).toBe(false);
	});

	it("agree 对方的 proposal → agreed；第 8 步的 need_owner → exhausted；普通一步只推进", () => {
		const offered = judgeStep(base, a, {
			status: "continue",
			message: "",
			proposal: { s: 1 },
		}).next;
		expect(offered).toMatchObject({ step: 1, lastProposalBy: a });
		expect(
			judgeStep(offered, b, {
				status: "agree",
				message: "",
				proposal: { s: 1 },
			}).outcome,
		).toBe("agreed");
		expect(
			judgeStep({ ...offered, step: 7 }, b, {
				status: "need_owner",
				message: "",
			}).outcome,
		).toBe("exhausted");
		expect(
			judgeStep(offered, b, { status: "need_owner", message: "" }),
		).toMatchObject({
			outcome: null,
			next: { state: "waiting_owner", step: 2 },
		});
	});
});
