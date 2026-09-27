/**
 * 模型客户端的共享类型与错误（真实客户端 `@/agent/llm` 与假模型 `@/agent/mock-llm` 共用）。
 */
import type { CONVERSATION_KINDS } from "@orgos/protocol";

export type ToolCall = { id: string; name: string; arguments: string };

export type ChatMessage =
	| { role: "system" | "user"; content: string }
	| {
			role: "assistant";
			content: string | null;
			tool_calls?: {
				id: string;
				type: "function";
				function: { name: string; arguments: string };
			}[];
	  }
	| { role: "tool"; tool_call_id: string; content: string };

export type ToolSpec = {
	type: "function";
	function: { name: string; description: string; parameters: unknown };
};

/** 记账归属。 */
export type LlmMeta = {
	tenantId: string;
	agentId: string;
	onBehalfOfId: string | null;
	conversationId: string | null;
	model: string;
};

/**
 * 本次运行的触发信息。真实模型从 messages 里读上下文，不看它；
 * 确定性的假模型（mock-llm）按它决定行为。
 */
export type RunTrigger = {
	/** 人类消息原文、上报答复原文、协商对方的上一步，或转交的任务。 */
	text: string;
	/** 触发消息里被 @ 的主体 id。 */
	mentions: readonly string[];
	agent: { id: string; handle: string };
	conversationKind: (typeof CONVERSATION_KINDS)[number];
	/** 上报后本人答复（或暂不答复）、恢复运行；answer 为答复原文（暂不答复时可为空）。 */
	resume?: { answer: string; declined?: boolean };
	/** 协商中的一步。 */
	negotiation?: {
		role: "initiator" | "responder";
		goal: string;
		lastProposal?: unknown;
		/** 最近的 proposal 是自己提的。 */
		lastProposalMine: boolean;
		/** 本人已答复过自己在这次协商里的 need_owner。 */
		ownerAnswered: boolean;
	};
};

export type LlmRequest = {
	messages: ChatMessage[];
	tools: ToolSpec[];
	meta: LlmMeta;
	trigger: RunTrigger;
	signal?: AbortSignal;
	/** 流式文本增量。 */
	onDelta?: (delta: string) => void;
};

export type LlmResult = {
	text: string;
	toolCalls: ToolCall[];
	/** 响应里出现了推理内容（思考应已关闭，出现即异常）。 */
	reasoning: boolean;
};

export interface LlmClient {
	complete(req: LlmRequest): Promise<LlmResult>;
}

/** 重试后仍失败。 */
export class LlmUnavailableError extends Error {
	constructor(readonly httpStatus: number) {
		super(`模型暂时不可用（HTTP ${httpStatus}）`);
		this.name = "LlmUnavailableError";
	}
}

/** 本次调用被中止（/stop 或进程内取消）。 */
export class LlmAbortedError extends Error {
	constructor() {
		super("模型调用已中止");
		this.name = "LlmAbortedError";
	}
}

export const MAX_TOKENS = 4000;
/** 没有 HTTP 响应（网络错误、超时）时记的状态码。 */
export const HTTP_STATUS_NO_RESPONSE = 0;
/** 被本方中止时记的状态码（沿用 nginx 的 499 client closed request）。 */
export const HTTP_STATUS_ABORTED = 499;

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new LlmAbortedError());
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new LlmAbortedError());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
