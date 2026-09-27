/**
 * 集成：调度与循环——打断、/stop、群聊轮次、防循环、单次运行上限、写账失败不影响回复。
 */
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	LlmAbortedError,
	type LlmClient,
	type LlmRequest,
	type LlmResult,
} from "@/agent/llm-types";
import { STEP_LIMIT_TEXT } from "@/agent/loop";
import { createMockLlm } from "@/agent/mock-llm";
import { Scheduler, scheduler } from "@/agent/scheduler";
import { LIMIT_SUMMARY, MAX_MODEL_CALLS } from "@/agent/session";
import { llmRequests, principals } from "@/db/schema";
import { type PrincipalRow, scoped } from "@/db/scope";
import { postMessage } from "@/services/conversations";
import {
	actions,
	captureFrames,
	eventsOf,
	messagesBy,
	openDm,
	openGroup,
	say,
} from "./agent-helpers";
import { createTeam, type TeamMember, uniq } from "./helpers";

let alice: TeamMember;
let aliceRow: PrincipalRow;
let twin: string;
let ops: string;
let twinHandle: string;
let opsHandle: string;

beforeAll(async () => {
	[alice] = (await createTeam(["Alice"])) as [TeamMember];
	twin = alice.me.agents[0]?.principal.id ?? "";
	twinHandle = alice.me.agents[0]?.principal.handle ?? "";
	ops = alice.me.agents[1]?.principal.id ?? "";
	opsHandle = alice.me.agents[1]?.principal.handle ?? "";
	const row = await s().first(
		principals,
		eq(principals.id, alice.me.principal.id),
	);
	if (!row) throw new Error("找不到 alice");
	aliceRow = row;
});

function s() {
	return scoped(alice.me.tenant.id);
}

/** 新建一个助手并与它开私聊（私聊按成员去重，每个用例用自己的会话）。 */
async function freshDm(): Promise<{ cid: string; agent: string }> {
	const res = await alice.client.request("POST", "/api/agents", {
		displayName: "临时助手",
		handle: uniq("tmp-"),
		description: "测试用",
	});
	expect(res.status).toBe(201);
	const { agent } = (await res.json()) as {
		agent: { principal: { id: string } };
	};
	return {
		cid: await openDm(alice.client, agent.principal.id),
		agent: agent.principal.id,
	};
}

/** 由测试放行每一次模型调用；记录并发数。 */
function gatedLlm(reply: (req: LlmRequest) => LlmResult) {
	const calls: LlmRequest[] = [];
	const gates: (() => void)[] = [];
	let active = 0;
	let maxActive = 0;
	const llm: LlmClient = {
		async complete(req) {
			calls.push(req);
			active += 1;
			maxActive = Math.max(maxActive, active);
			try {
				await new Promise<void>((resolve, reject) => {
					gates.push(resolve);
					req.signal?.addEventListener("abort", () =>
						reject(new LlmAbortedError()),
					);
				});
			} finally {
				active -= 1;
			}
			return reply(req);
		},
	};
	return {
		llm,
		calls,
		release: () => gates.shift()?.(),
		maxActive: () => maxActive,
	};
}

const textReply = (req: LlmRequest): LlmResult => ({
	text: `回复：${req.trigger.text}`,
	toolCalls: [],
	reasoning: false,
});

async function post(cid: string, text: string) {
	const event = await postMessage(s(), aliceRow, cid, { text });
	if (event.type !== "message.posted") throw new Error("不是消息事件");
	return event;
}

describe("打断与中止", () => {
	it("运行中来了新消息：当前一步完成后停止，不发旧回复，从新消息开始新一轮", async () => {
		const { cid, agent } = await freshDm();
		const g = gatedLlm(textReply);
		const sched = new Scheduler({ llm: () => g.llm });
		void sched.onHumanMessage(s(), await post(cid, "第一条"));
		await vi.waitFor(() => expect(g.calls).toHaveLength(1));
		void sched.onHumanMessage(s(), await post(cid, "第二条"));
		g.release();
		await vi.waitFor(() => expect(g.calls).toHaveLength(2));
		g.release();
		await sched.idle(cid);
		const events = await eventsOf(alice.client, cid);
		expect(messagesBy(events, agent).map((m) => m.payload.text)).toEqual([
			"回复：第二条",
		]);
		expect(g.maxActive()).toBe(1);
	});

	it("stop：立即中止进行中的模型调用，不发回复，状态回到 idle", async () => {
		const { cid, agent } = await freshDm();
		const g = gatedLlm(textReply);
		const sched = new Scheduler({ llm: () => g.llm });
		const cap = captureFrames(alice.me.principal.id);
		try {
			void sched.onHumanMessage(s(), await post(cid, "慢慢说"));
			await vi.waitFor(() => expect(g.calls).toHaveLength(1));
			sched.stop(cid);
			await sched.idle(cid);
		} finally {
			cap.stop();
		}
		expect(messagesBy(await eventsOf(alice.client, cid), agent)).toEqual([]);
		const last = cap.frames.filter((f) => f.t === "status").at(-1);
		expect(last).toMatchObject({ t: "status", state: "idle", agentId: agent });
	});

	it("POST /stop 经真实路由中止假模型的流式输出，llm_requests 记 499", async () => {
		const { cid, agent } = await freshDm();
		const cap = captureFrames(alice.me.principal.id);
		try {
			const res = await alice.client.request(
				"POST",
				`/api/conversations/${cid}/messages`,
				{ text: "很长的一段话".repeat(40) },
			);
			expect(res.status).toBe(201);
			await vi.waitFor(() =>
				expect(cap.frames.some((f) => f.t === "draft")).toBe(true),
			);
			const stop = await alice.client.request(
				"POST",
				`/api/conversations/${cid}/stop`,
			);
			expect(stop.status).toBe(204);
			await scheduler.idle(cid);
		} finally {
			cap.stop();
		}
		expect(messagesBy(await eventsOf(alice.client, cid), agent)).toEqual([]);
		const rows = await s().select(
			llmRequests,
			eq(llmRequests.conversationId, cid),
		);
		expect(rows.map((r) => r.httpStatus)).toEqual([499]);
	});
});

describe("单次运行上限与记账", () => {
	it("模型一直调工具：8 次后落“步骤太多”并记 system 动作", async () => {
		const { cid, agent } = await freshDm();
		const calls: LlmRequest[] = [];
		const sched = new Scheduler({
			llm: () => ({
				async complete(req) {
					calls.push(req);
					return {
						text: "",
						toolCalls: [
							{
								id: `c${calls.length}`,
								name: "memory_search",
								arguments: '{"query":"预算"}',
							},
						],
						reasoning: false,
					};
				},
			}),
		});
		await sched.onHumanMessage(s(), await post(cid, "查个没完"));
		expect(calls).toHaveLength(MAX_MODEL_CALLS);
		const events = await eventsOf(alice.client, cid);
		expect(messagesBy(events, agent).at(-1)?.payload.text).toBe(
			STEP_LIMIT_TEXT,
		);
		expect(events.at(-1)).toMatchObject({
			type: "agent.action",
			payload: { tool: "system", ok: false, summary: LIMIT_SUMMARY.modelCalls },
		});
	});

	it("交接累计到 8 次：停止并记 system 动作", async () => {
		const { cid, agent } = await freshDm();
		let delegations = 0;
		const sched = new Scheduler({
			llm: () => ({
				async complete(req) {
					if (req.trigger.text === "子任务")
						return { text: "做完了", toolCalls: [], reasoning: false };
					const call = () => ({
						id: `d${++delegations}`,
						name: "delegate_to_teammate",
						arguments: JSON.stringify({ handle: opsHandle, task: "子任务" }),
					});
					return {
						text: "",
						toolCalls: [call(), call(), call()],
						reasoning: false,
					};
				},
			}),
		});
		await sched.onHumanMessage(s(), await post(cid, "分派"));
		const events = await eventsOf(alice.client, cid);
		const done = actions(events).filter(
			(a) => a.payload.tool === "delegate_to_teammate",
		);
		expect(done.filter((a) => a.payload.ok)).toHaveLength(8);
		expect(messagesBy(events, agent)).toEqual([]);
		expect(events.at(-1)).toMatchObject({
			type: "agent.action",
			actorId: agent,
			payload: { tool: "system", ok: false, summary: LIMIT_SUMMARY.handoffs },
		});
	});

	it("写账失败只记日志：回复照常落库", async () => {
		const { cid, agent } = await freshDm();
		const sched = new Scheduler({
			llm: () =>
				createMockLlm({
					record: async () => {
						throw new Error("db down");
					},
					sliceDelayMs: 0,
				}),
		});
		await sched.onHumanMessage(s(), await post(cid, "你好"));
		expect(
			messagesBy(await eventsOf(alice.client, cid), agent).map(
				(m) => m.payload.text,
			),
		).toEqual(["收到：你好"]);
	});
});

describe("群聊轮次", () => {
	it("@ 执行助手：只有它回复，分身 pass 不落消息也不落动作", async () => {
		const cid = await openGroup(alice.client, "两位代理", [twin, ops]);
		await say(alice.client, cid, `@${opsHandle} 你好`, { mentions: [ops] });
		const events = await eventsOf(alice.client, cid);
		expect(messagesBy(events, ops).map((m) => m.payload.text)).toEqual([
			`收到：@${opsHandle} 你好`,
		]);
		expect(messagesBy(events, twin)).toEqual([]);
		expect(actions(events)).toEqual([]);
	});

	it("互相点名：到上限停止，代理消息 ≤ 8，最后一条是说明上限的 system 动作", async () => {
		const cid = await openGroup(alice.client, "互相点名", [twin, ops]);
		const started = Date.now();
		await say(alice.client, cid, `@${twinHandle} @${opsHandle} 聊聊`, {
			mentions: [twin, ops],
		});
		expect(Date.now() - started).toBeLessThan(20_000);
		const events = await eventsOf(alice.client, cid);
		const agentMessages = events.filter(
			(e) => e.type === "message.posted" && e.actorId !== alice.me.principal.id,
		);
		expect(agentMessages.length).toBeGreaterThan(2);
		expect(agentMessages.length).toBeLessThanOrEqual(8);
		expect(agentMessages[0]?.actorId).toBe(twin);
		expect(events.at(-1)).toMatchObject({
			type: "agent.action",
			payload: { tool: "system", ok: false },
		});
		const last = events.at(-1);
		expect(last?.type === "agent.action" && last.payload.summary).toContain(
			"上限",
		);
	});

	it("人发新消息后重新开始计数", async () => {
		const cid = await openGroup(alice.client, "重新计数", [twin, ops]);
		await say(alice.client, cid, `@${opsHandle} 第一件`, { mentions: [ops] });
		await say(alice.client, cid, `@${opsHandle} 第二件`, { mentions: [ops] });
		const replies = messagesBy(await eventsOf(alice.client, cid), ops);
		expect(replies.map((m) => m.payload.text)).toEqual([
			`收到：@${opsHandle} 第一件`,
			`收到：@${opsHandle} 第二件`,
		]);
	});
});
