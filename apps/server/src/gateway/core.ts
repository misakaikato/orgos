/**
 * 网关核心：本租户所有模型调用的唯一出口。外部入口（`/llm/v1/*`，任务令牌）与代理引擎
 * （进程内调用 `callGateway`）走同一个函数。
 *
 * 1. 解析模型引用（`厂商/模型` 或 `group/<id>`）得到按尝试顺序排列的上游；
 * 2. 上游有入口协议的端点 → 直通（只换 key、改写 model）；没有 → 经 IR 翻译到它有的协议；
 * 3. 连不上、5xx、429 且还有下一个上游 → 换下一个；每次尝试写一行 llm_requests；
 * 4. 厂商 key 只出现在发往上游的请求头里；上游错误信息回给调用方之前抹掉 key。
 */
import {
	type GatewayProtocol,
	type ProviderPreset,
	parseModelRef,
} from "@orgos/protocol";
import type { Scoped } from "@/db/scope";
import { anthropicMessages } from "@/gateway/anthropic";
import {
	CodecError,
	collect,
	EMPTY_USAGE,
	type IrEvent,
	type IrRequest,
	type IrResult,
	type IrStop,
	type IrUsage,
	mergeUsage,
	type ProtocolCodec,
	SseDecoder,
	str,
} from "@/gateway/ir";
import {
	type Attribution,
	recordAttempt,
	STATUS_ABORTED,
	STATUS_NO_RESPONSE,
} from "@/gateway/meter";
import { openaiChat } from "@/gateway/openai-chat";
import { openaiResponses } from "@/gateway/responses";
import {
	endpointUrl,
	scrubKey,
	upstreamHeaders,
	upstreamMessage,
	upstreamProtocolFor,
} from "@/gateway/upstream";
import { resolveModel, type UpstreamTarget } from "@/services/model-providers";

export const CODECS: Record<GatewayProtocol, ProtocolCodec> = {
	openai: openaiChat,
	anthropic: anthropicMessages,
	responses: openaiResponses,
};

/** 一次上游调用（含读完整个流）的上限。 */
export const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;

export type GatewayCall = {
	s: Scoped;
	protocol: GatewayProtocol;
	body: Record<string, unknown>;
	who: Attribution;
	/** 调用方的请求头（同协议直通时转发 anthropic-version / anthropic-beta）。 */
	headers?: Headers;
	signal?: AbortSignal;
	/** 代理引擎：上游走 openai 协议时按预设关闭思考。 */
	thinkingOff?: boolean;
};

export function isRetryable(status: number): boolean {
	return status === STATUS_NO_RESPONSE || status === 429 || status >= 500;
}

export function gatewayError(
	protocol: GatewayProtocol,
	status: number,
	message: string,
): Response {
	return Response.json(CODECS[protocol].errorBody(status, message), {
		status: status >= 200 && status <= 599 ? status : 502,
	});
}

const ID_PREFIX: Record<GatewayProtocol, string> = {
	openai: "chatcmpl-",
	anthropic: "msg_",
	responses: "resp_",
};

function responseId(protocol: GatewayProtocol): string {
	return `${ID_PREFIX[protocol]}${crypto.randomUUID().replaceAll("-", "")}`;
}

function withThinkingOff(
	body: Record<string, unknown>,
	protocol: GatewayProtocol,
	preset: ProviderPreset | undefined,
	on: boolean,
): Record<string, unknown> {
	return on && protocol === "openai" && preset?.openaiThinkingOff
		? { ...body, ...preset.openaiThinkingOff }
		: body;
}

/** 直通的请求体：换成上游的模型 id；OpenAI 流式时要求带用量；developer 角色归一为 system。 */
function passthroughBody(
	call: GatewayCall,
	t: UpstreamTarget,
): Record<string, unknown> {
	const body: Record<string, unknown> = { ...call.body, model: t.model };
	if (call.protocol === "openai") {
		if (Array.isArray(body.messages))
			body.messages = body.messages.map((m) =>
				m &&
				typeof m === "object" &&
				(m as { role?: unknown }).role === "developer"
					? { ...m, role: "system" }
					: m,
			);
		if (body.stream === true)
			body.stream_options = {
				...(body.stream_options && typeof body.stream_options === "object"
					? body.stream_options
					: {}),
				include_usage: true,
			};
	}
	return body;
}

export async function callGateway(call: GatewayCall): Promise<Response> {
	const inbound = CODECS[call.protocol];
	const ref = str(call.body.model);
	if (!ref || !parseModelRef(ref))
		return gatewayError(
			call.protocol,
			400,
			"model 须写成 厂商/模型 或 group/<id>（见 /llm/v1/models）",
		);
	const resolved = await resolveModel(call.s, ref);
	if (!resolved.ok) return gatewayError(call.protocol, 400, resolved.message);

	let ir: IrRequest | null = null;
	let last: Response | null = null;
	const { targets, groupId } = resolved;
	for (const [i, t] of targets.entries()) {
		const more = i < targets.length - 1;
		const out = upstreamProtocolFor(t.endpoints, call.protocol);
		const url = out ? endpointUrl(t.endpoints, out, "call") : null;
		if (!out || !url) {
			last = gatewayError(
				call.protocol,
				502,
				`厂商 ${t.provider} 没有可用的端点`,
			);
			continue;
		}
		const passthrough = out === call.protocol;
		let body: Record<string, unknown>;
		try {
			if (passthrough) body = passthroughBody(call, t);
			else {
				ir ??= inbound.toIr(call.body);
				body = CODECS[out].fromIr({ ...ir, model: t.model });
			}
		} catch (e) {
			if (e instanceof CodecError)
				return gatewayError(call.protocol, 400, e.message);
			throw e;
		}
		body = withThinkingOff(body, out, t.preset, call.thinkingOff === true);

		const started = Date.now();
		const record = (
			httpStatus: number,
			usage: IrUsage = EMPTY_USAGE,
			parseError = false,
		) =>
			recordAttempt(call.who, {
				provider: t.provider,
				preset: t.preset?.id ?? null,
				model: t.model,
				protocolIn: call.protocol,
				protocolOut: out,
				groupId,
				usage,
				parseError,
				httpStatus,
				durationMs: Date.now() - started,
			});

		let res: Response;
		try {
			res = await fetch(url, {
				method: "POST",
				headers: upstreamHeaders(
					t,
					out,
					passthrough ? call.headers : undefined,
				),
				body: JSON.stringify(body),
				signal: AbortSignal.any([
					AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
					...(call.signal ? [call.signal] : []),
				]),
			});
		} catch {
			if (call.signal?.aborted) {
				await record(STATUS_ABORTED);
				return gatewayError(call.protocol, STATUS_ABORTED, "调用已中止");
			}
			await record(STATUS_NO_RESPONSE);
			last = gatewayError(call.protocol, 502, `连不上厂商 ${t.provider}`);
			if (more) continue;
			return last;
		}
		if (!res.ok) {
			const text = scrubKey(await res.text().catch(() => ""), t.apiKey);
			await record(res.status);
			last = gatewayError(
				call.protocol,
				res.status,
				upstreamMessage(text, res.status),
			);
			if (more && isRetryable(res.status)) continue;
			return last;
		}
		return passthrough
			? passthroughResponse(res, inbound, call, record)
			: translatedResponse(res, CODECS[out], inbound, call, ref, record);
	}
	return last ?? gatewayError(call.protocol, 502, "没有可用的上游");
}

type Record_ = (
	httpStatus: number,
	usage?: IrUsage,
	parseError?: boolean,
) => Promise<void>;

/**
 * 直通：原样转发上游的响应体。非流式读完即入账；流式边转发边留一份，
 * 在流结束（或调用方断开）时解析用量入账。
 */
async function passthroughResponse(
	res: Response,
	codec: ProtocolCodec,
	call: GatewayCall,
	record: Record_,
): Promise<Response> {
	const streaming = call.body.stream === true;
	const headers = new Headers({
		"content-type":
			res.headers.get("content-type") ??
			(streaming ? "text/event-stream" : "application/json"),
	});
	if (!streaming) {
		let text: string;
		try {
			text = await res.text();
		} catch {
			await record(call.signal?.aborted ? STATUS_ABORTED : res.status);
			return gatewayError(call.protocol, 502, "上游的响应中断了");
		}
		const { usage, parseError } = codec.usageOf(text, false);
		await record(res.status, usage, parseError);
		return new Response(text, { status: res.status, headers });
	}
	headers.set("cache-control", "no-cache");
	const reader = res.body?.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let done = false;
	const finish = async (status: number) => {
		if (done) return;
		done = true;
		text += decoder.decode();
		const { usage, parseError } = codec.usageOf(text, streaming);
		await record(status, usage, parseError);
	};
	if (!reader) {
		void finish(res.status);
		return new Response(null, { status: res.status, headers });
	}
	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done: end, value } = await reader.read();
				if (end) {
					await finish(res.status);
					controller.close();
					return;
				}
				text += decoder.decode(value, { stream: true });
				controller.enqueue(value);
			} catch (err) {
				await finish(call.signal?.aborted ? STATUS_ABORTED : res.status);
				controller.error(err);
			}
		},
		async cancel() {
			await reader.cancel().catch(() => {});
			await finish(STATUS_ABORTED);
		},
	});
	return new Response(stream, { status: res.status, headers });
}

/** 上游事件流 → IR 事件（按到达顺序）。 */
async function* upstreamEvents(
	res: Response,
	codec: ProtocolCodec,
): AsyncGenerator<IrEvent> {
	const parser = codec.parser();
	const decoder = new SseDecoder();
	if (!res.body) return;
	for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
		for (const ev of decoder.push(chunk)) yield* parser.feed(ev);
	}
	for (const ev of decoder.end()) yield* parser.feed(ev);
}

/** 翻译：上游一律流式；入口要流式就边收边转，否则聚合成一个响应体。 */
async function translatedResponse(
	res: Response,
	upstream: ProtocolCodec,
	inbound: ProtocolCodec,
	call: GatewayCall,
	model: string,
	record: Record_,
): Promise<Response> {
	const id = responseId(inbound.protocol);
	let usage = EMPTY_USAGE;
	let stop: IrStop = "stop";
	let toolSeen = false;
	let failure: string | null = null;
	const absorb = (ev: IrEvent): boolean => {
		if (ev.type === "usage") usage = mergeUsage(usage, ev.usage);
		else if (ev.type === "finish") stop = ev.reason;
		else if (ev.type === "error") failure = ev.message;
		else if (ev.type === "tool_start") toolSeen = true;
		return (
			ev.type === "text" ||
			ev.type === "reasoning" ||
			ev.type.startsWith("tool_")
		);
	};
	const finalStop = () => (stop === "stop" && toolSeen ? "tool_calls" : stop);

	if (call.body.stream !== true) {
		const result: IrResult = { id, model, blocks: [], stop: "stop", usage };
		try {
			for await (const ev of upstreamEvents(res, upstream)) {
				absorb(ev);
				collect([ev], result);
			}
		} catch {
			await record(call.signal?.aborted ? STATUS_ABORTED : res.status, usage);
			return gatewayError(inbound.protocol, 502, "上游的响应中断了");
		}
		await record(res.status, usage);
		if (failure && result.blocks.length === 0)
			return gatewayError(inbound.protocol, 502, failure);
		return Response.json(
			inbound.result({ ...result, stop: finalStop(), usage }),
		);
	}

	const emitter = inbound.emitter({ id, model, request: call.body });
	const encoder = new TextEncoder();
	const events = upstreamEvents(res, upstream);
	let recorded = false;
	const finish = async (status: number) => {
		if (recorded) return;
		recorded = true;
		await record(status, usage);
	};
	let started = false;
	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				if (!started) {
					started = true;
					controller.enqueue(encoder.encode(emitter.start()));
					return;
				}
				for (;;) {
					const next = await events.next();
					if (next.done) {
						const tail = failure
							? emitter.error(failure)
							: emitter.end(finalStop(), usage);
						await finish(res.status);
						controller.enqueue(encoder.encode(tail));
						controller.close();
						return;
					}
					if (!absorb(next.value)) continue;
					const text = emitter.event(next.value);
					if (text) {
						controller.enqueue(encoder.encode(text));
						return;
					}
				}
			} catch {
				await finish(call.signal?.aborted ? STATUS_ABORTED : res.status);
				controller.enqueue(encoder.encode(emitter.error("上游的响应中断了")));
				controller.close();
			}
		},
		async cancel() {
			await events.return(undefined).catch(() => {});
			await finish(STATUS_ABORTED);
		},
	});
	return new Response(stream, {
		status: 200,
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
		},
	});
}
