/**
 * 代理引擎的模型客户端：经网关的进程内入口（`@/gateway/core` 的 callGateway）调用，
 * 以 OpenAI Chat Completions 的形态说话；不直连厂商、不持有 key、不写账（计量只在网关）。
 *
 * - `stream: true`，`max_tokens: 4000`；上游走 openai 协议时由网关按预设关闭思考；
 * - 5xx / 429 / 连不上或超时重试 2 次（1s、3s），每次重试都是网关里的一次新尝试（各记一行账）；中止不重试；
 * - `MOCK_LLM=1` 时换成 `@/agent/mock-llm`，不出网。
 */
import { randomUUID } from "node:crypto";
import {
	LlmAbortedError,
	type LlmClient,
	LlmUnavailableError,
	MAX_TOKENS,
	sleep,
	type ToolCall,
} from "@/agent/llm-types";
import { createMockLlm } from "@/agent/mock-llm";
import { scoped } from "@/db/scope";
import { env, modelMode } from "@/env";
import { callGateway, isRetryable } from "@/gateway/core";
import { SseDecoder } from "@/gateway/ir";
import { STATUS_ABORTED, STATUS_NO_RESPONSE } from "@/gateway/meter";
import { openaiChat } from "@/gateway/openai-chat";

export type GatewayClientOptions = {
	retryDelaysMs?: readonly number[];
	/** 单次调用（含读完整个流）的超时。 */
	timeoutMs?: number;
};

type Reply = {
	text: string;
	calls: Map<number, ToolCall>;
	reasoning: boolean;
	error: string | null;
};

async function readReply(
	res: Response,
	onDelta?: (delta: string) => void,
): Promise<Reply> {
	const reply: Reply = {
		text: "",
		calls: new Map(),
		reasoning: false,
		error: null,
	};
	const parser = openaiChat.parser();
	const decoder = new SseDecoder();
	const apply = (chunk: Uint8Array | null) => {
		const events = chunk ? decoder.push(chunk) : decoder.end();
		for (const sse of events)
			for (const ev of parser.feed(sse)) {
				if (ev.type === "text") {
					reply.text += ev.delta;
					onDelta?.(ev.delta);
				} else if (ev.type === "reasoning") reply.reasoning = true;
				else if (ev.type === "tool_start")
					reply.calls.set(ev.index, {
						id: ev.id,
						name: ev.name,
						arguments: "",
					});
				else if (ev.type === "tool_args") {
					const call = reply.calls.get(ev.index);
					if (call) call.arguments += ev.delta;
				} else if (ev.type === "error") reply.error = ev.message;
			}
	};
	if (res.body)
		for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>)
			apply(chunk);
	apply(null);
	return reply;
}

export function createGatewayClient(
	opts: GatewayClientOptions = {},
): LlmClient {
	const delays = opts.retryDelaysMs ?? [1_000, 3_000];
	const timeoutMs = opts.timeoutMs ?? env.LLM_TIMEOUT_MS;
	return {
		async complete(req) {
			const body = {
				model: req.meta.model,
				messages: req.messages,
				...(req.tools.length > 0 ? { tools: req.tools } : {}),
				stream: true,
				stream_options: { include_usage: true },
				max_tokens: MAX_TOKENS,
			};
			for (let attempt = 0; ; attempt++) {
				if (req.signal?.aborted) throw new LlmAbortedError();
				let status = STATUS_NO_RESPONSE;
				try {
					const res = await callGateway({
						s: scoped(req.meta.tenantId),
						protocol: "openai",
						body,
						who: {
							tenantId: req.meta.tenantId,
							agentId: req.meta.agentId,
							onBehalfOfId: req.meta.onBehalfOfId,
							conversationId: req.meta.conversationId,
							runId: req.meta.runId,
							taskId: req.meta.taskId,
						},
						signal: AbortSignal.any([
							AbortSignal.timeout(timeoutMs),
							...(req.signal ? [req.signal] : []),
						]),
						thinkingOff: true,
					});
					status = res.status;
					if (res.ok) {
						const reply = await readReply(res, req.onDelta);
						if (!reply.error) {
							if (reply.reasoning)
								console.warn(
									`[llm] ${req.meta.model} 的响应里出现了推理内容（思考应已关闭）`,
								);
							return {
								text: reply.text,
								toolCalls: [...reply.calls.entries()]
									.sort(([a], [b]) => a - b)
									.map(([, c]) => ({ ...c, id: c.id || randomUUID() })),
								reasoning: reply.reasoning,
							};
						}
						status = 502;
					} else await res.body?.cancel();
				} catch {
					status = STATUS_NO_RESPONSE;
				}
				if (req.signal?.aborted) throw new LlmAbortedError();
				// 调用方没中止却是 499：本次调用超时。
				if (status === STATUS_ABORTED) status = STATUS_NO_RESPONSE;
				const delay = delays[attempt];
				if (delay === undefined || !isRetryable(status))
					throw new LlmUnavailableError(status);
				await sleep(delay, req.signal);
			}
		},
	};
}

/** 按当前环境选择模型客户端（每次运行调用，环境变量变化即时生效）。 */
export function getLlmClient(): LlmClient {
	return modelMode() === "mock" ? createMockLlm() : createGatewayClient();
}
