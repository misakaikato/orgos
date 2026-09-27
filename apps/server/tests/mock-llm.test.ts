/**
 * 单元：假模型的 6 条优先级、8 字切片与记账（不连库）。
 */
import { describe, expect, it } from "vitest";
import { ESCALATION_CLAIM_CORRECTION } from "@/agent/escalation-claim";
import type { ChatMessage, LlmRequest, RunTrigger } from "@/agent/llm-types";
import { LlmAbortedError } from "@/agent/llm-types";
import { createMockLlm, MOCK_PROPOSAL, mockDecide } from "@/agent/mock-llm";
import type { LlmRequestRow } from "@/services/llm-requests";

const AGENT = {
	id: "11111111-1111-4111-8111-111111111111",
	handle: "alice-twin",
};

function trigger(text: string, extra: Partial<RunTrigger> = {}): RunTrigger {
	return {
		text,
		mentions: [],
		agent: AGENT,
		conversationKind: "dm",
		...extra,
	};
}

const toolResult = (content: string): ChatMessage => ({
	role: "tool",
	tool_call_id: "t1",
	content,
});

describe("mockDecide 优先级", () => {
	it("1. 已有工具结果 → 完成：前 60 字，不再调工具", () => {
		const long = "字".repeat(80);
		expect(mockDecide(trigger("#note 预算"), [toolResult(long)])).toEqual({
			kind: "text",
			text: `完成：${"字".repeat(60)}`,
		});
	});

	it.each([
		["#pass", "pass", {}],
		[
			"#delegate:alice-ops 整理周报",
			"delegate_to_teammate",
			{ handle: "alice-ops", task: "整理周报" },
		],
		["#escalate 能提前吗", "escalate_to_owner", { question: "能提前吗" }],
		["#note 预算 口径", "memory_search", { query: "预算 口径" }],
		[
			"#remember 私事|下周三请假看牙",
			"memory_save",
			{ title: "私事", body: "下周三请假看牙" },
		],
		["#commit 周五交周报", "create_commitment", { title: "周五交周报" }],
		[
			"#negotiate:bob 约周四讨论预算",
			"negotiate",
			{ personHandle: "bob", goal: "约周四讨论预算" },
		],
		["#ls .", "device_list", { path: "." }],
		["#read a.txt", "device_read", { path: "a.txt" }],
		["#write a.txt|hi", "device_write", { path: "a.txt", content: "hi" }],
		["#exec echo hi", "device_exec", { command: "echo hi" }],
	])("2. 指令 %s → 调 %s", (text, name, args) => {
		expect(mockDecide(trigger(text), [])).toEqual({ kind: "tool", name, args });
	});

	it("2. 文本里最先出现的指令生效", () => {
		expect(
			mockDecide(trigger("先 #note 预算 再 #remember a|b"), []),
		).toMatchObject({ kind: "tool", name: "memory_search" });
		expect(
			mockDecide(trigger("#delegate:alice-ops #note 看牙"), []),
		).toMatchObject({
			name: "delegate_to_teammate",
			args: { task: "#note 看牙" },
		});
	});

	it("2. #claim 只口头说已转交；#claim-fix 收到纠正提示后调 escalate_to_owner", () => {
		const corrected: ChatMessage[] = [
			{ role: "assistant", content: "已转交本人" },
			{ role: "user", content: ESCALATION_CLAIM_CORRECTION },
		];
		expect(mockDecide(trigger("#claim"), [])).toEqual({
			kind: "text",
			text: "已转交本人",
		});
		expect(mockDecide(trigger("#claim"), corrected)).toEqual({
			kind: "text",
			text: "已转交本人",
		});
		expect(mockDecide(trigger("#claim-fix 能提前吗"), [])).toEqual({
			kind: "text",
			text: "已转交本人：能提前吗",
		});
		expect(mockDecide(trigger("#claim-fix 能提前吗"), corrected)).toEqual({
			kind: "tool",
			name: "escalate_to_owner",
			args: { question: "能提前吗" },
		});
	});

	it("3. 群聊里没 @ 本代理、也不含 handle → pass；点名或提到 handle 则不 pass", () => {
		const group = { conversationKind: "group" as const };
		expect(mockDecide(trigger("大家好", group), [])).toEqual({
			kind: "tool",
			name: "pass",
			args: {},
		});
		expect(
			mockDecide(trigger("你好", { ...group, mentions: [AGENT.id] }), []),
		).toEqual({ kind: "text", text: "收到：你好" });
		expect(mockDecide(trigger("收到：@alice-twin 聊聊", group), [])).toEqual({
			kind: "text",
			text: "收到：收到：@alice-twin 聊聊",
		});
	});

	it("4. 上报恢复 → 本人答复：原文", () => {
		expect(
			mockDecide(trigger("可以", { resume: { answer: "可以" } }), []),
		).toEqual({ kind: "text", text: "本人答复：可以" });
		expect(
			mockDecide(trigger("", { resume: { answer: "", declined: true } }), []),
		).toEqual({ kind: "text", text: "本人暂不答复" });
		expect(
			mockDecide(
				trigger("下周再说", { resume: { answer: "下周再说", declined: true } }),
				[],
			),
		).toEqual({ kind: "text", text: "本人暂不答复：下周再说" });
	});

	it("5. 协商：发起方先提议，应答方按目标 agree / need_owner / reject", () => {
		const step = (
			role: "initiator" | "responder",
			goal: string,
			lastProposal?: unknown,
			flags: { lastProposalMine?: boolean; ownerAnswered?: boolean } = {},
		) =>
			mockDecide(
				trigger("对方的上一步", {
					negotiation: {
						role,
						goal,
						lastProposal,
						lastProposalMine: flags.lastProposalMine ?? false,
						ownerAnswered: flags.ownerAnswered ?? false,
					},
				}),
				[],
			);
		expect(step("initiator", "约周四")).toEqual({
			kind: "tool",
			name: "negotiation_reply",
			args: {
				status: "continue",
				message: "提议：周四 15:00",
				proposal: MOCK_PROPOSAL,
			},
		});
		expect(step("responder", "约周四", MOCK_PROPOSAL)).toMatchObject({
			args: { status: "agree", proposal: MOCK_PROPOSAL },
		});
		expect(step("responder", "约周四 #needowner", MOCK_PROPOSAL)).toMatchObject(
			{ args: { status: "need_owner" } },
		);
		expect(step("responder", "约周四 #reject", MOCK_PROPOSAL)).toMatchObject({
			args: { status: "reject" },
		});
		expect(
			step("responder", "约周四 #needowner", MOCK_PROPOSAL, {
				ownerAnswered: true,
			}),
		).toMatchObject({ args: { status: "agree", proposal: MOCK_PROPOSAL } });
		expect(
			step("initiator", "约周四", MOCK_PROPOSAL, { lastProposalMine: true }),
		).toMatchObject({
			args: { status: "continue", proposal: MOCK_PROPOSAL },
		});
	});

	it("6. 其余 → 收到：触发文本", () => {
		expect(mockDecide(trigger("你好"), [])).toEqual({
			kind: "text",
			text: "收到：你好",
		});
	});
});

function request(text: string, extra: Partial<LlmRequest> = {}): LlmRequest {
	return {
		messages: [
			{ role: "system", content: "系统" },
			{ role: "user", content: text },
		],
		tools: [],
		meta: {
			tenantId: "t",
			agentId: AGENT.id,
			onBehalfOfId: null,
			conversationId: null,
			runId: null,
			taskId: null,
			model: "deepseek-v4-flash",
		},
		trigger: trigger(text),
		...extra,
	};
}

describe("createMockLlm", () => {
	it("文本按 8 字切片流式输出，并记一行 provider=mock 的账", async () => {
		const rows: LlmRequestRow[] = [];
		const llm = createMockLlm({
			record: async (r) => {
				rows.push(r);
			},
			sliceDelayMs: 0,
		});
		const deltas: string[] = [];
		const text = "一二三四五六七八九十甲乙丙丁戊己庚";
		const res = await llm.complete(
			request(text, { onDelta: (d) => deltas.push(d) }),
		);
		expect(res.text).toBe(`收到：${text}`);
		expect(deltas).toEqual([
			"收到：一二三四五",
			"六七八九十甲乙丙",
			"丁戊己庚",
		]);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			provider: "mock",
			httpStatus: 200,
			outputTokens: res.text.length,
			inputTokens: 2 + text.length,
		});
	});

	it("工具调用不产生草稿", async () => {
		const deltas: string[] = [];
		const res = await createMockLlm({
			record: async () => {},
		}).complete(request("#note 预算", { onDelta: (d) => deltas.push(d) }));
		expect(deltas).toEqual([]);
		expect(res.toolCalls).toEqual([
			{
				id: "mock-memory_search",
				name: "memory_search",
				arguments: JSON.stringify({ query: "预算" }),
			},
		]);
	});

	it("中止：抛 LlmAbortedError，仍记账（499）", async () => {
		const rows: LlmRequestRow[] = [];
		const controller = new AbortController();
		const llm = createMockLlm({
			record: async (r) => {
				rows.push(r);
			},
			sliceDelayMs: 20,
		});
		const pending = llm.complete(
			request("很长的一段话".repeat(10), {
				signal: controller.signal,
				onDelta: () => controller.abort(),
			}),
		);
		await expect(pending).rejects.toBeInstanceOf(LlmAbortedError);
		expect(rows.map((r) => r.httpStatus)).toEqual([499]);
	});

	it("写账失败不影响输出", async () => {
		const llm = createMockLlm({
			record: async () => {
				throw new Error("db down");
			},
			sliceDelayMs: 0,
		});
		await expect(llm.complete(request("你好"))).resolves.toMatchObject({
			text: "收到：你好",
		});
	});
});
