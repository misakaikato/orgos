/**
 * 发往上游的那一跳：按协议拼 URL 与鉴权头（换成厂商的 key），以及把厂商 key 从任何要回给调用方
 * 或写进日志的文本里抹掉。网关核心、厂商"测试"与拉模型列表都经这里，不另写一套。
 */
import type {
	GatewayProtocol,
	ProviderEndpoints,
	ProviderPreset,
} from "@orgos/protocol";

export type Upstream = {
	providerId: string;
	/** 厂商名（模型引用里的前半段）。 */
	provider: string;
	preset: ProviderPreset | undefined;
	endpoints: ProviderEndpoints;
	apiKey: string | null;
};

const ANTHROPIC_VERSION = "2023-06-01";

/** 协议偏好：入口协议不可用时按这个顺序挑一个做翻译。 */
const FALLBACK_ORDER: readonly GatewayProtocol[] = [
	"openai",
	"anthropic",
	"responses",
];

export function upstreamProtocolFor(
	endpoints: ProviderEndpoints,
	inbound: GatewayProtocol,
): GatewayProtocol | null {
	if (endpoints[inbound]) return inbound;
	return FALLBACK_ORDER.find((p) => endpoints[p]) ?? null;
}

function trimBase(url: string): string {
	return url.replace(/\/+$/, "");
}

export function endpointUrl(
	endpoints: ProviderEndpoints,
	protocol: GatewayProtocol,
	path: "call" | "models",
): string | null {
	const base = endpoints[protocol];
	if (!base) return null;
	const b = trimBase(base);
	if (protocol === "anthropic")
		return path === "call" ? `${b}/v1/messages` : `${b}/v1/models`;
	if (protocol === "responses")
		return path === "call" ? `${b}/responses` : `${b}/models`;
	return path === "call" ? `${b}/chat/completions` : `${b}/models`;
}

/** 调用方带来的、可以原样转给同协议上游的头。 */
const PASS_HEADERS: Record<GatewayProtocol, readonly string[]> = {
	anthropic: ["anthropic-version", "anthropic-beta"],
	openai: [],
	responses: [],
};

export function upstreamHeaders(
	up: Pick<Upstream, "apiKey" | "preset">,
	protocol: GatewayProtocol,
	inbound?: Headers,
): Headers {
	const h = new Headers({ "content-type": "application/json" });
	if (inbound)
		for (const name of PASS_HEADERS[protocol]) {
			const v = inbound.get(name);
			if (v) h.set(name, v);
		}
	if (protocol === "anthropic") {
		if (!h.has("anthropic-version"))
			h.set("anthropic-version", ANTHROPIC_VERSION);
		if (up.apiKey) {
			h.set("x-api-key", up.apiKey);
			if ((up.preset?.anthropicAuth ?? "both") === "both")
				h.set("authorization", `Bearer ${up.apiKey}`);
		}
	} else if (up.apiKey) h.set("authorization", `Bearer ${up.apiKey}`);
	return h;
}

/** 把厂商 key 从文本里抹掉（上游的错误信息可能回显 key）。 */
export function scrubKey(text: string, key: string | null): string {
	return key && key.length >= 6 ? text.replaceAll(key, "***") : text;
}

/** 从上游错误响应里取一句人能读的原因。 */
export function upstreamMessage(text: string, status: number): string {
	try {
		const v = JSON.parse(text) as {
			error?: { message?: unknown } | string;
			message?: unknown;
		};
		const m =
			typeof v.error === "string"
				? v.error
				: typeof v.error?.message === "string"
					? v.error.message
					: typeof v.message === "string"
						? v.message
						: null;
		if (m) return m;
	} catch {}
	const t = text.trim().slice(0, 300);
	return t ? `上游返回 HTTP ${status}：${t}` : `上游返回 HTTP ${status}`;
}

/** 列出厂商的模型（openai 或 anthropic 端点的 /models）。 */
export async function fetchProviderModels(
	up: Upstream,
	signal?: AbortSignal,
): Promise<string[]> {
	const protocol: GatewayProtocol | null = up.endpoints.openai
		? "openai"
		: up.endpoints.anthropic
			? "anthropic"
			: up.endpoints.responses
				? "responses"
				: null;
	if (!protocol) throw new Error("没有可用的端点");
	const url = endpointUrl(up.endpoints, protocol, "models");
	if (!url) throw new Error("没有可用的端点");
	const res = await fetch(url, {
		headers: upstreamHeaders(up, protocol),
		signal: signal ?? AbortSignal.timeout(15_000),
	});
	const text = scrubKey(await res.text(), up.apiKey);
	if (!res.ok) throw new Error(upstreamMessage(text, res.status));
	const body = JSON.parse(text) as { data?: unknown; models?: unknown };
	const list = Array.isArray(body.data)
		? body.data
		: Array.isArray(body.models)
			? body.models
			: [];
	return list
		.map((m) =>
			typeof m === "string"
				? m
				: m && typeof m === "object"
					? ((m as { id?: unknown; name?: unknown }).id ??
						(m as { name?: unknown }).name)
					: null,
		)
		.filter((x): x is string => typeof x === "string")
		.sort();
}
