/**
 * 集成（MOCK_LLM=1）：上报的运行时校验——为他人办事时，回复口头声称已转交本人却没有调用
 * escalate_to_owner，先纠正一次；纠正后上报则只有 escalation.created，仍不改则落回复并记未上报的系统动作。
 * 为本人办事的运行不受影响。另含判定函数的单元用例。
 */
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import {
	claimsEscalated,
	ESCALATION_CLAIM_CORRECTION,
} from "@/agent/escalation-claim";
import type { LlmClient, LlmRequest } from "@/agent/llm-types";
import { createMockLlm } from "@/agent/mock-llm";
import { Scheduler } from "@/agent/scheduler";
import { llmRequests, principals } from "@/db/schema";
import { type PrincipalRow, scoped } from "@/db/scope";
import { postMessage } from "@/services/conversations";
import { actions, eventsOf, messagesBy, openDm } from "./agent-helpers";
import { createTeam, type TeamMember } from "./helpers";

let alice: TeamMember;
let bob: TeamMember;
let aliceTwin: string;
let pairDm: string;
let ownDm: string;

const s = () => scoped(alice.me.tenant.id);

beforeAll(async () => {
	[alice, bob] = (await createTeam(["Alice", "Bob"])) as [
		TeamMember,
		TeamMember,
	];
	aliceTwin =
		alice.me.agents.find((a) => a.role === "front")?.principal.id ?? "";
	pairDm = await openDm(bob.client, alice.me.principal.id);
	ownDm = await openDm(alice.client, aliceTwin);
});

async function rowOf(m: TeamMember): Promise<PrincipalRow> {
	const row = await s().first(principals, eq(principals.id, m.me.principal.id));
	if (!row) throw new Error("找不到主体");
	return row;
}

/** 以某人身份发一条消息，交给记录每次模型调用的调度器，等这一轮结束；返回这一轮的模型请求（调用时的消息快照）。 */
async function run(
	m: TeamMember,
	conversationId: string,
	text: string,
	opts: { askTwin?: boolean } = {},
): Promise<LlmRequest[]> {
	const calls: LlmRequest[] = [];
	const inner = createMockLlm({ sliceDelayMs: 0 });
	const llm: LlmClient = {
		complete(req) {
			calls.push({ ...req, messages: [...req.messages] });
			return inner.complete(req);
		},
	};
	const sched = new Scheduler({ llm: () => llm });
	const event = await postMessage(s(), await rowOf(m), conversationId, {
		text,
		...opts,
	});
	if (event.type !== "message.posted") throw new Error("不是消息");
	await sched.onHumanMessage(s(), event);
	await sched.idle(conversationId);
	return calls;
}

const hasCorrection = (req: LlmRequest | undefined) =>
	!!req?.messages.some(
		(x) => x.role === "user" && x.content === ESCALATION_CLAIM_CORRECTION,
	);

/** 某次运行记下的模型调用行数。 */
async function meteredCalls(req: LlmRequest | undefined): Promise<number> {
	const rows = await s().select(
		llmRequests,
		eq(llmRequests.runId, req?.meta.runId ?? ""),
	);
	return rows.length;
}

async function eventsSince(conversationId: string, afterId: number) {
	return (await eventsOf(bob.client, conversationId)).filter(
		(e) => e.id > afterId,
	);
}

async function lastEventId(client: TeamMember, conversationId: string) {
	return (await eventsOf(client.client, conversationId)).at(-1)?.id ?? 0;
}

describe("claimsEscalated", () => {
	it.each([
		"我已经把这条转给本人了",
		"已转交，请稍候",
		"这件事已上报",
		"我之前已经上报给 Alice 了",
		"我报给Alice了",
		"我问过本人，她还没回",
		"已通知Alice",
	])("声称已转交：%s", (text) => {
		expect(claimsEscalated(text, "Alice")).toBe(true);
	});

	it.each([
		"根据 Alice 共享的《Q4 路线图》，结算页 10 月 31 日上线。",
		"这需要 Alice 本人决定。",
		"本人答复：可以",
	])("没有声称：%s", (text) => {
		expect(claimsEscalated(text, "Alice")).toBe(false);
	});
});

describe("上报的运行时校验", () => {
	it("纠正后上报：纠正提示出现在第二次模型调用里，最终只有 escalation.created，两次调用都计量", async () => {
		const after = await lastEventId(bob, pairDm);
		const calls = await run(
			bob,
			pairDm,
			"#claim-fix 交付能否提前到 10 月 1 日",
			{
				askTwin: true,
			},
		);
		expect(calls).toHaveLength(2);
		expect(hasCorrection(calls[0])).toBe(false);
		expect(hasCorrection(calls[1])).toBe(true);
		expect(calls[1]?.messages.at(-2)).toMatchObject({
			role: "assistant",
			content: "已转交本人：交付能否提前到 10 月 1 日",
		});
		expect(await meteredCalls(calls[0])).toBe(2);

		const events = await eventsSince(pairDm, after);
		expect(events.find((e) => e.type === "escalation.created")).toMatchObject({
			actorId: aliceTwin,
			payload: { question: "交付能否提前到 10 月 1 日" },
		});
		expect(messagesBy(events, aliceTwin)).toEqual([]);
		expect(actions(events).filter((a) => a.payload.tool === "system")).toEqual(
			[],
		);
	});

	it("纠正后仍口头转交：落回复，并记一条未上报的系统动作", async () => {
		const after = await lastEventId(bob, pairDm);
		const calls = await run(bob, pairDm, "#claim", { askTwin: true });
		expect(calls).toHaveLength(2);
		expect(hasCorrection(calls[1])).toBe(true);
		expect(await meteredCalls(calls[0])).toBe(2);

		const events = await eventsSince(pairDm, after);
		expect(events.some((e) => e.type === "escalation.created")).toBe(false);
		expect(messagesBy(events, aliceTwin).map((m) => m.payload.text)).toEqual([
			"已转交本人",
		]);
		const system = actions(events).filter((a) => a.payload.tool === "system");
		expect(system).toHaveLength(1);
		expect(system[0]?.payload).toMatchObject({ tool: "system", ok: false });
		expect(system[0]?.payload.summary).toContain("escalate_to_owner");
	});

	it("为本人办事：同样的回复直接落下，只调用一次模型，没有系统动作", async () => {
		const after = await lastEventId(alice, ownDm);
		const calls = await run(alice, ownDm, "#claim");
		expect(calls).toHaveLength(1);
		expect(hasCorrection(calls[0])).toBe(false);

		const events = (await eventsOf(alice.client, ownDm)).filter(
			(e) => e.id > after,
		);
		expect(messagesBy(events, aliceTwin).map((m) => m.payload.text)).toEqual([
			"已转交本人",
		]);
		expect(actions(events)).toEqual([]);
	});
});
