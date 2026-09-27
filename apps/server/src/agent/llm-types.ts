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
	/** 系统运行（记忆提炼、画像整理）为空。 */
	agentId: string | null;
	onBehalfOfId: string | null;
	conversationId: string | null;
	/** 这次调用属于哪次运行。 */
	runId: string | null;
	/** 这次运行服务的任务。 */
	taskId: string | null;
	/** 模型引用：`厂商/模型` 或 `group/<id>`。 */
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
	/** 生成压缩检查点（不是一次回复）。 */
	checkpoint?: true;
	/** 记忆层的系统调用：从话题材料提炼条目，或把条目整理成画像（输出 JSON）。 */
	memory?: "extract" | "profile";
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
	/** 要求模型只输出一个 JSON 对象。 */
	json?: boolean;
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
