/**
 * 确定性的假模型（MOCK_LLM=1）：e2e 与测试依赖它，不出网。
 *
 * 生成压缩检查点时：按固定格式列出被压缩的第一句、最后一句与条数（同样确定性）。
 *
 * 按本次运行的触发文本决定行为，优先级：
 * 1. 本次运行已有工具结果 → `完成：<工具结果前 60 字>`，不再调工具；
 * 2. 触发文本里的指令（文本中最先出现者生效）→ 调对应工具；
 * 3. 群聊里文本既没有 @ 本代理、也不含本代理 handle → pass；
 * 4. 上报后恢复运行 → `本人答复：<答复原文>`（暂不答复时为 `本人暂不答复`，附言跟在冒号后）；
 * 5. 协商：发起方第一步 continue + `{"slot":"周四 15:00"}`；应答方看到 proposal 时，
 *    目标含 #needowner（且本人还没答复过）→ need_owner，含 #reject → reject，否则 agree 同一 proposal；
 *    最近的 proposal 是自己提的（对方还没回应它）→ continue 重申同一 proposal；
 * 6. 其余 → `收到：<触发文本>`。
 *
 * 文本按 8 字切片流式输出；每次调用写一行 llm_requests（provider='mock'，tokens 按字数估算）。
 */
import {
	type ChatMessage,
	HTTP_STATUS_ABORTED,
	LlmAbortedError,
	type LlmClient,
	type LlmRequest,
	type LlmResult,
	type RunTrigger,
	sleep,
} from "@/agent/llm-types";
import {
	type RecordLlmRequest,
	recordLlmRequest,
	recordSafely,
} from "@/services/llm-requests";

export type MockDecision =
	| { kind: "text"; text: string }
	| { kind: "tool"; name: string; args: Record<string, unknown> };

export const MOCK_SLICE = 8;
export const MOCK_PROPOSAL = { slot: "周四 15:00" } as const;

type Directive = {
	pattern: RegExp;
	tool: string;
	args: (m: RegExpExecArray) => Record<string, unknown>;
};

const rest = (m: RegExpExecArray, i = 1) => (m[i] ?? "").trim();

function splitPipe(s: string): [string, string] {
	const at = s.indexOf("|");
	return at < 0
		? [s.trim(), ""]
		: [s.slice(0, at).trim(), s.slice(at + 1).trim()];
}

/** 指令与参数都取到文本末尾。 */
const DIRECTIVES: Directive[] = [
	{ pattern: /#pass\b/, tool: "pass", args: () => ({}) },
	{
		pattern: /#delegate:([a-z][a-z0-9-]*)\s+([\s\S]*)$/,
		tool: "delegate_to_teammate",
		args: (m) => ({ handle: rest(m), task: rest(m, 2) }),
	},
	{
		pattern: /#escalate\s+([\s\S]*)$/,
		tool: "escalate_to_owner",
		args: (m) => ({ question: rest(m) }),
	},
	{
		pattern: /#note\s+([\s\S]*)$/,
		tool: "knowledge_search",
		args: (m) => ({ query: rest(m) }),
	},
	{
		pattern: /#remember\s+([\s\S]*)$/,
		tool: "memory_save",
		args: (m) => {
			const [title, body] = splitPipe(rest(m));
			return { title, body };
		},
	},
	{
		pattern: /#commit\s+([\s\S]*)$/,
		tool: "create_commitment",
		args: (m) => ({ title: rest(m) }),
	},
	{
		pattern: /#negotiate:([a-z][a-z0-9-]*)\s+([\s\S]*)$/,
		tool: "negotiate",
		args: (m) => ({ personHandle: rest(m), goal: rest(m, 2) }),
	},
	{
		pattern: /#ls\s+([\s\S]*)$/,
		tool: "device_list",
		args: (m) => ({ path: rest(m) }),
	},
	{
		pattern: /#read\s+([\s\S]*)$/,
		tool: "device_read",
		args: (m) => ({ path: rest(m) }),
	},
	{
		pattern: /#write\s+([\s\S]*)$/,
		tool: "device_write",
		args: (m) => {
			const [path, content] = splitPipe(rest(m));
			return { path, content };
		},
	},
	{
		pattern: /#exec\s+([\s\S]*)$/,
		tool: "device_exec",
		args: (m) => ({ command: rest(m) }),
	},
];

function firstDirective(text: string): MockDecision | null {
	let best: { at: number; decision: MockDecision } | null = null;
	for (const d of DIRECTIVES) {
		const m = d.pattern.exec(text);
		if (m && (best === null || m.index < best.at)) {
			best = {
				at: m.index,
				decision: { kind: "tool", name: d.tool, args: d.args(m) },
			};
		}
	}
	return best?.decision ?? null;
}

function negotiationStep(n: NonNullable<RunTrigger["negotiation"]>) {
	if (n.lastProposal === undefined) {
		return {
			status: "continue",
			message: `提议：${MOCK_PROPOSAL.slot}`,
			proposal: MOCK_PROPOSAL,
		};
	}
	if (n.lastProposalMine) {
		return {
			status: "continue",
			message: "仍然提议这个时间",
			proposal: n.lastProposal,
		};
	}
	if (
		n.role === "responder" &&
		n.goal.includes("#needowner") &&
		!n.ownerAnswered
	)
		return { status: "need_owner", message: "这需要问本人" };
	if (n.role === "responder" && n.goal.includes("#reject"))
		return { status: "reject", message: "这个时间不行" };
	return { status: "agree", message: "同意", proposal: n.lastProposal };
}

const head = (text: string, n = 40) => Array.from(text).slice(0, n).join("");

/** 检查点：被压缩的对话是最后一条 user 消息里以“【”开头的各行。 */
function mockCheckpoint(messages: readonly ChatMessage[]): string {
	const last = messages.findLast((m) => m.role === "user");
	const lines = (last?.content ?? "")
		.split("\n")
		.filter((l) => l.startsWith("【"));
	return [
		`目标：${head(lines[0] ?? "（无）")}`,
		`进展：压缩了 ${lines.length} 条，最后一条是 ${head(lines.at(-1) ?? "（无）")}`,
		"决定：（无）",
		"下一步：（无）",
		"涉及文件：（无）",
	].join("\n");
}

/** 纯函数：按优先级决定这一步说什么或调什么工具。 */
export function mockDecide(
	trigger: RunTrigger,
	messages: readonly ChatMessage[],
): MockDecision {
	if (trigger.checkpoint)
		return { kind: "text", text: mockCheckpoint(messages) };
	const lastTool = messages.findLast((m) => m.role === "tool");
	if (lastTool) {
		return {
			kind: "text",
			text: `完成：${Array.from(lastTool.content).slice(0, 60).join("")}`,
		};
	}
	const directive = firstDirective(trigger.text);
	if (directive) return directive;
	if (
		trigger.conversationKind === "group" &&
		!trigger.mentions.includes(trigger.agent.id) &&
		!trigger.text.includes(trigger.agent.handle)
	) {
		return { kind: "tool", name: "pass", args: {} };
	}
	if (trigger.resume) {
		const { answer, declined } = trigger.resume;
		return {
			kind: "text",
			text: declined
				? `本人暂不答复${answer ? `：${answer}` : ""}`
				: `本人答复：${answer}`,
		};
	}
	if (trigger.negotiation) {
		return {
			kind: "tool",
			name: "negotiation_reply",
			args: negotiationStep(trigger.negotiation),
		};
	}
	return { kind: "text", text: `收到：${trigger.text}` };
}

function charCount(messages: readonly ChatMessage[]): number {
	let n = 0;
	for (const m of messages) n += Array.from(m.content ?? "").length;
	return n;
}

export type MockOptions = {
	record?: RecordLlmRequest;
	/** 每个切片之间的间隔，让界面看得到流式效果。 */
	sliceDelayMs?: number;
};

export function createMockLlm(opts: MockOptions = {}): LlmClient {
	const record = opts.record ?? recordLlmRequest;
	const sliceDelayMs = opts.sliceDelayMs ?? 15;

	return {
		async complete(req: LlmRequest): Promise<LlmResult> {
			const started = Date.now();
			const decision = mockDecide(req.trigger, req.messages);
			const output =
				decision.kind === "text"
					? decision.text
					: `${decision.name}${JSON.stringify(decision.args)}`;
			let httpStatus = 200;
			try {
				if (decision.kind === "text") {
					const chars = Array.from(decision.text);
					for (let i = 0; i < chars.length; i += MOCK_SLICE) {
						if (i > 0) await sleep(sliceDelayMs, req.signal);
						if (req.signal?.aborted) throw new LlmAbortedError();
						req.onDelta?.(chars.slice(i, i + MOCK_SLICE).join(""));
					}
				} else if (req.signal?.aborted) {
					throw new LlmAbortedError();
				}
			} catch (e) {
				httpStatus = HTTP_STATUS_ABORTED;
				throw e;
			} finally {
				await recordSafely(record, {
					tenantId: req.meta.tenantId,
					agentId: req.meta.agentId,
					onBehalfOfId: req.meta.onBehalfOfId,
					conversationId: req.meta.conversationId,
					runId: req.meta.runId,
					provider: "mock",
					model: "mock",
					inputTokens: charCount(req.messages),
					outputTokens: Array.from(output).length,
					cacheReadTokens: 0,
					costMicroUsd: null,
					durationMs: Date.now() - started,
					httpStatus,
					parseError: false,
				});
			}
			return decision.kind === "text"
				? { text: decision.text, toolCalls: [], reasoning: false }
				: {
						text: "",
						toolCalls: [
							{
								id: `mock-${decision.name}`,
								name: decision.name,
								arguments: JSON.stringify(decision.args),
							},
						],
						reasoning: false,
					};
		},
	};
}
