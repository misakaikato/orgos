/**
 * 模型页的"测试"：对厂商配置的每种协议各发一个最小的非流式请求，报告延迟与结果。
 * 这是管理员对上游连通性的探测，不代表任何代理，不入 llm_requests。
 */
import {
	GATEWAY_PROTOCOLS,
	type GatewayProtocol,
	type ProviderTestResult,
} from "@orgos/protocol";
import { arr, isRecord, str } from "@/gateway/ir";
import {
	endpointUrl,
	scrubKey,
	type Upstream,
	upstreamHeaders,
	upstreamMessage,
} from "@/gateway/upstream";

const PROBE_TIMEOUT_MS = 30_000;
const PROBE_PROMPT = "只回复两个字：你好";
/** 留足余量：部分厂商默认先输出推理内容。 */
const PROBE_MAX_TOKENS = 256;

function probeBody(
	protocol: GatewayProtocol,
	up: Upstream,
	model: string,
): Record<string, unknown> {
	if (protocol === "anthropic")
		return {
			model,
			max_tokens: PROBE_MAX_TOKENS,
			messages: [{ role: "user", content: PROBE_PROMPT }],
		};
	if (protocol === "responses")
		return { model, input: PROBE_PROMPT, max_output_tokens: PROBE_MAX_TOKENS };
	return {
		model,
		max_tokens: PROBE_MAX_TOKENS,
		messages: [{ role: "user", content: PROBE_PROMPT }],
		...(up.preset?.openaiThinkingOff ?? {}),
	};
}

/** 从三种协议的非流式响应里取出文字。 */
function replyText(protocol: GatewayProtocol, body: unknown): string {
	if (!isRecord(body)) return "";
	if (protocol === "anthropic")
		return arr(body.content)
			.map((b) => (isRecord(b) && b.type === "text" ? (str(b.text) ?? "") : ""))
			.join("");
	if (protocol === "responses")
		return arr(body.output)
			.flatMap((it) => (isRecord(it) ? arr(it.content) : []))
			.map((c) => (isRecord(c) ? (str(c.text) ?? "") : ""))
			.join("");
	const choice = arr(body.choices)[0];
	return isRecord(choice) && isRecord(choice.message)
		? (str(choice.message.content) ?? "")
		: "";
}

export async function probeProvider(
	up: Upstream,
	model: string,
): Promise<ProviderTestResult[]> {
	const results: ProviderTestResult[] = [];
	for (const protocol of GATEWAY_PROTOCOLS) {
		const url = endpointUrl(up.endpoints, protocol, "call");
		if (!url) continue;
		const started = Date.now();
		try {
			const res = await fetch(url, {
				method: "POST",
				headers: upstreamHeaders(up, protocol),
				body: JSON.stringify(probeBody(protocol, up, model)),
				signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
			});
			const text = scrubKey(await res.text(), up.apiKey);
			let message: string;
			if (res.ok) {
				let parsed: unknown = null;
				try {
					parsed = JSON.parse(text);
				} catch {}
				message = replyText(protocol, parsed).trim() || "（没有文字回复）";
			} else message = upstreamMessage(text, res.status);
			results.push({
				protocol,
				ok: res.ok,
				latencyMs: Date.now() - started,
				httpStatus: res.status,
				message,
			});
		} catch (e) {
			results.push({
				protocol,
				ok: false,
				latencyMs: Date.now() - started,
				httpStatus: 0,
				message: scrubKey(
					e instanceof Error ? `连不上：${e.message}` : "连不上",
					up.apiKey,
				),
			});
		}
	}
	return results;
}
