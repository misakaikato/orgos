/**
 * LLM 用量解析与成本核算（OpenAI 兼容协议）。
 *
 * 纯函数，永不抛错：解析失败只产出 parseError=true，由调用方据实落库（tokens / cost 为 null）。
 * 流式取最末含 usage 的 chunk；非流式取响应体 usage。
 * prompt_tokens / completion_tokens / prompt_tokens_details.cached_tokens(cacheRead)。
 *
 * 成本：costMicroUsd = round(Σ tokens_i × pricePerMtok_i)。单价缺失 / 解析失败 → null。
 * （pricePerMtok 为"美元 / 1e6 token"，乘 token 数恰得"微美元"，1e6 量纲相消。）
 */
import type { ModelPricing } from "@/agent/llm-config";

export interface UsageTokens {
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadTokens: number | null;
}

export interface UsageResult extends UsageTokens {
	/** true = 响应带了 usage，但字段损坏（上游格式漂移的信号）。 */
	parseError: boolean;
}

const NULL_USAGE: UsageResult = {
	inputTokens: null,
	outputTokens: null,
	cacheReadTokens: null,
	parseError: false,
};

/** 取有限数；非有限 / 非数值 → null，并标记 malformed。 */
function num(v: unknown, malformed: { v: boolean }): number | null {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (v !== undefined && v !== null) malformed.v = true;
	return null;
}

/** 拆出 SSE 文本中的 `data:` 载荷并解析为对象；跳过空行 / [DONE] / 非 JSON。 */
export function sseDataObjects(text: string): unknown[] {
	const out: unknown[] = [];
	for (const line of text.split("\n")) {
		const raw = line.trimStart();
		if (!raw.startsWith("data:")) continue;
		const payload = raw.slice(5).trim();
		if (!payload || payload === "[DONE]") continue;
		try {
			out.push(JSON.parse(payload));
		} catch {
			// 单行 JSON 坏掉不致命：跳过（其余行可能仍含 usage）。
		}
	}
	return out;
}

/** 非 2xx 视为失败响应：无 usage 期望。 */
export function isOkStatus(httpStatus: number): boolean {
	return httpStatus >= 200 && httpStatus < 300;
}

/** 解析用量；httpStatus 非 2xx 直接空结果。 */
export function parseUsage(
	text: string,
	opts: { httpStatus: number; streaming: boolean },
): UsageResult {
	if (!isOkStatus(opts.httpStatus)) return { ...NULL_USAGE };
	return opts.streaming ? parseStream(text) : parseJson(text);
}

function fromUsageObject(u: Record<string, unknown>): UsageResult {
	const malformed = { v: false };
	const input = num(u.prompt_tokens, malformed);
	const output = num(u.completion_tokens, malformed);
	const details = u.prompt_tokens_details as
		| { cached_tokens?: unknown }
		| undefined;
	const cacheRead = num(details?.cached_tokens, malformed);
	return {
		inputTokens: subtractCached(input, cacheRead),
		outputTokens: output,
		cacheReadTokens: cacheRead,
		parseError: malformed.v,
	};
}

function parseStream(text: string): UsageResult {
	let last: Record<string, unknown> | null = null;
	for (const obj of sseDataObjects(text)) {
		const u = (obj as { usage?: unknown })?.usage;
		if (u && typeof u === "object") last = u as Record<string, unknown>;
	}
	return last ? fromUsageObject(last) : { ...NULL_USAGE };
}

function parseJson(text: string): UsageResult {
	let obj: unknown;
	try {
		obj = JSON.parse(text);
	} catch {
		return { ...NULL_USAGE };
	}
	const u = (obj as { usage?: unknown })?.usage;
	if (!u || typeof u !== "object") return { ...NULL_USAGE };
	return fromUsageObject(u as Record<string, unknown>);
}

/**
 * prompt_tokens 含缓存命中部分；inputTokens 记非缓存部分（prompt − cached），保证成本可加。
 */
function subtractCached(
	input: number | null,
	cacheRead: number | null,
): number | null {
	if (input === null || cacheRead === null) return input;
	return Math.max(0, input - cacheRead);
}

/**
 * 成本（微美元整数）。pricing 为 null（未定价）或 parseError → null；
 * 否则 round(Σ tokens × pricePerMtok)，缺省项按 0。
 */
export function computeCostMicroUsd(
	u: UsageTokens & { parseError?: boolean },
	p: ModelPricing | null,
): number | null {
	if (!p) return null;
	if (u.parseError) return null;
	const term = (tok: number | null, price?: number): number =>
		tok !== null && price !== undefined ? tok * price : 0;
	const sum =
		term(u.inputTokens, p.inputPerMtok) +
		term(u.outputTokens, p.outputPerMtok) +
		term(u.cacheReadTokens, p.cacheReadPerMtok);
	return Math.round(sum);
}

/**
 * messages[].role === "developer" 归一为 "system"（DeepSeek 只认 system，developer 会 400）。
 * 幂等；非 JSON / 无 developer 原样返回。
 */
export function normalizeOpenAiRoles(bodyText: string): {
	body: string;
	modified: boolean;
} {
	let body: unknown;
	try {
		body = JSON.parse(bodyText);
	} catch {
		return { body: bodyText, modified: false };
	}
	const messages = (body as { messages?: unknown }).messages;
	if (!Array.isArray(messages)) return { body: bodyText, modified: false };
	let modified = false;
	for (const m of messages) {
		if (
			m &&
			typeof m === "object" &&
			(m as { role?: unknown }).role === "developer"
		) {
			(m as { role: string }).role = "system";
			modified = true;
		}
	}
	return modified
		? { body: JSON.stringify(body), modified }
		: { body: bodyText, modified };
}

/**
 * stream:true 时向请求体注入 stream_options.include_usage（幂等）。
 * 已含 include_usage===true 则不动；非 JSON / 非 stream:true 原样返回。
 */
export function injectIncludeUsage(bodyText: string): {
	body: string;
	modified: boolean;
} {
	let body: unknown;
	try {
		body = JSON.parse(bodyText);
	} catch {
		return { body: bodyText, modified: false };
	}
	if (
		body &&
		typeof body === "object" &&
		(body as { stream?: unknown }).stream === true
	) {
		const b = body as {
			stream_options?: { include_usage?: unknown } & Record<string, unknown>;
		};
		if (b.stream_options?.include_usage !== true) {
			b.stream_options = {
				...(b.stream_options ?? {}),
				include_usage: true,
			};
			return { body: JSON.stringify(body), modified: true };
		}
	}
	return { body: bodyText, modified: false };
}
