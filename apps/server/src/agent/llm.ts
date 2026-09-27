/**
 * 模型调用的唯一入口：OpenAI 兼容 Chat Completions 流式调用（DeepSeek）。
 *
 * - `stream: true` + `stream_options.include_usage`；DeepSeek 带 `thinking: { type: 'disabled' }`
 *   （不带时思考会吃光 max_tokens）；`max_tokens: 4000`；请求体经 normalizeOpenAiRoles。
 * - 5xx / 429 / 网络错误或超时重试 2 次（1s、3s）；中止不重试。
 * - 每次 HTTP 调用结束（成功、失败、中止）写一行 llm_requests；写账失败只记日志。
 * - 密钥只来自 DEEPSEEK_API_KEY。`MOCK_LLM=1`（或没有密钥）时换成 `@/agent/mock-llm`。
 */
import { randomUUID } from "node:crypto";
import { defaultProvider, pricingFor } from "@/agent/llm-config";
import {
	HTTP_STATUS_ABORTED,
	HTTP_STATUS_NO_RESPONSE,
	LlmAbortedError,
	type LlmClient,
	LlmUnavailableError,
	MAX_TOKENS,
	sleep,
	type ToolCall,
} from "@/agent/llm-types";
import { createMockLlm } from "@/agent/mock-llm";
import {
	computeCostMicroUsd,
	injectIncludeUsage,
	normalizeOpenAiRoles,
	parseUsage,
} from "@/agent/usage-meter";
import { modelMode } from "@/env";
import {
	type RecordLlmRequest,
	recordLlmRequest,
	recordSafely,
} from "@/services/llm-requests";

const RETRYABLE = (status: number) =>
	status === 429 || status >= 500 || status === HTTP_STATUS_NO_RESPONSE;

type StreamState = {
	raw: string;
	text: string;
	reasoning: boolean;
	calls: Map<number, ToolCall>;
};

function applyChunk(
	state: StreamState,
	line: string,
	onDelta?: (d: string) => void,
) {
	if (!line.startsWith("data:")) return;
	const payload = line.slice(5).trim();
	if (!payload || payload === "[DONE]") return;
	let obj: unknown;
	try {
		obj = JSON.parse(payload);
	} catch {
		return;
	}
	const choices = (obj as { choices?: unknown }).choices;
	const delta = Array.isArray(choices)
		? (choices[0] as { delta?: Record<string, unknown> } | undefined)?.delta
		: undefined;
	if (!delta) return;
	if (typeof delta.content === "string" && delta.content) {
		state.text += delta.content;
		onDelta?.(delta.content);
	}
	if (typeof delta.reasoning_content === "string" && delta.reasoning_content)
		state.reasoning = true;
	if (Array.isArray(delta.tool_calls)) {
		for (const tc of delta.tool_calls as Record<string, unknown>[]) {
			const index = typeof tc.index === "number" ? tc.index : 0;
			const fn = (tc.function ?? {}) as { name?: unknown; arguments?: unknown };
			const cur = state.calls.get(index) ?? {
				id: "",
				name: "",
				arguments: "",
			};
			if (typeof tc.id === "string" && tc.id) cur.id = tc.id;
			if (typeof fn.name === "string") cur.name += fn.name;
			if (typeof fn.arguments === "string") cur.arguments += fn.arguments;
			state.calls.set(index, cur);
		}
	}
}

async function readStream(
	body: ReadableStream<Uint8Array>,
	state: StreamState,
	onDelta?: (d: string) => void,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		const chunk = decoder.decode(value, { stream: true });
		state.raw += chunk;
		buf += chunk;
		let idx = buf.indexOf("\n");
		while (idx >= 0) {
			applyChunk(state, buf.slice(0, idx).trim(), onDelta);
			buf = buf.slice(idx + 1);
			idx = buf.indexOf("\n");
		}
	}
	applyChunk(state, buf.trim(), onDelta);
}

export type DeepSeekOptions = {
	apiKey?: string;
	fetch?: typeof fetch;
	record?: RecordLlmRequest;
	retryDelaysMs?: readonly number[];
	/** 单次 HTTP 调用（含读完整个流）的超时。 */
	timeoutMs?: number;
};

export function createDeepSeekClient(opts: DeepSeekOptions = {}): LlmClient {
	const fetchImpl = opts.fetch ?? fetch;
	const record = opts.record ?? recordLlmRequest;
	const delays = opts.retryDelaysMs ?? [1_000, 3_000];
	const timeoutMs = opts.timeoutMs ?? 120_000;
	const provider = defaultProvider();

	return {
		async complete(req) {
			const apiKey = opts.apiKey ?? process.env[provider.apiKeyEnv];
			if (!apiKey) throw new Error(`${provider.apiKeyEnv} 未设置`);
			const pricing = pricingFor(provider, req.meta.model);
			const body = injectIncludeUsage(
				normalizeOpenAiRoles(
					JSON.stringify({
						model: req.meta.model,
						messages: req.messages,
						...(req.tools.length > 0 ? { tools: req.tools } : {}),
						stream: true,
						stream_options: { include_usage: true },
						max_tokens: MAX_TOKENS,
						thinking: { type: "disabled" },
					}),
				).body,
			).body;

			for (let attempt = 0; ; attempt++) {
				if (req.signal?.aborted) throw new LlmAbortedError();
				const started = Date.now();
				const state: StreamState = {
					raw: "",
					text: "",
					reasoning: false,
					calls: new Map(),
				};
				let httpStatus = HTTP_STATUS_NO_RESPONSE;
				let failure: unknown = null;
				try {
					const signal = AbortSignal.any([
						AbortSignal.timeout(timeoutMs),
						...(req.signal ? [req.signal] : []),
					]);
					const res = await fetchImpl(`${provider.baseUrl}/chat/completions`, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							authorization: `Bearer ${apiKey}`,
						},
						body,
						signal,
					});
					httpStatus = res.status;
					if (!res.ok || !res.body) state.raw = await res.text();
					else await readStream(res.body, state, req.onDelta);
				} catch (e) {
					failure = e;
				}
				const aborted = req.signal?.aborted === true;
				if (aborted) httpStatus = HTTP_STATUS_ABORTED;
				else if (failure) httpStatus = HTTP_STATUS_NO_RESPONSE;
				const usage = parseUsage(state.raw, { httpStatus, streaming: true });
				await recordSafely(record, {
					tenantId: req.meta.tenantId,
					agentId: req.meta.agentId,
					onBehalfOfId: req.meta.onBehalfOfId,
					conversationId: req.meta.conversationId,
					provider: provider.id,
					model: req.meta.model,
					inputTokens: usage.inputTokens,
					outputTokens: usage.outputTokens,
					cacheReadTokens: usage.cacheReadTokens,
					costMicroUsd: computeCostMicroUsd(usage, pricing),
					durationMs: Date.now() - started,
					httpStatus,
					parseError: usage.parseError,
				});
				if (aborted) throw new LlmAbortedError();
				if (!failure && httpStatus >= 200 && httpStatus < 300) {
					if (state.reasoning)
						console.warn(
							`[llm] ${req.meta.model} 的响应里出现了推理内容（思考应已关闭）`,
						);
					return {
						text: state.text,
						toolCalls: [...state.calls.entries()]
							.sort(([a], [b]) => a - b)
							.map(([, c]) => ({ ...c, id: c.id || randomUUID() })),
						reasoning: state.reasoning,
					};
				}
				const delay = delays[attempt];
				if (delay === undefined || !RETRYABLE(httpStatus))
					throw new LlmUnavailableError(httpStatus);
				await sleep(delay, req.signal);
			}
		},
	};
}

/** 按当前环境选择模型客户端（每次运行调用，环境变量变化即时生效）。 */
export function getLlmClient(): LlmClient {
	return modelMode() === "mock" ? createMockLlm() : createDeepSeekClient();
}
