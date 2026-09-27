/**
 * 协议互转的中间形态。三种协议各自只和它互转（请求：协议 ⇄ IR；响应：上游流 → IR 事件 → 入口协议）。
 *
 * 不写两两转换：每种入口协议一个"解析为 IR"（toIr / parser），每种上游协议一个"由 IR 生成"
 * （fromIr / emitter），请求与流式响应各一套。直通时不经 IR，但用量解析仍是各协议的同一个 usageOf。
 *
 * - 请求里系统提示单独成段；消息内容片段有文本、图片、推理内容；工具调用挂在 assistant 消息上，
 *   工具结果是独立的 `tool` 消息（Anthropic 侧再并回 user 消息）；采样参数单列；
 * - 响应一律以事件流表示：开始、文字增量、推理增量、工具调用开始与参数增量、结束原因、用量；
 *   非流式的入口把事件聚合成 `IrResult` 再成形；
 * - 用量的 inputTokens 只记非缓存部分，与缓存读 / 写分开计价。
 */
import type { GatewayProtocol } from "@orgos/protocol";

export type IrContentPart =
	| { type: "text"; text: string }
	| { type: "image"; url?: string; data?: string; mediaType?: string }
	/** 推理内容（assistant）：Anthropic 的 thinking 带签名，只有带签名的才能回给 Anthropic 上游。 */
	| { type: "reasoning"; text: string; signature?: string };

export type IrToolCall = { id: string; name: string; arguments: string };

export type IrMessage =
	| { role: "user"; content: IrContentPart[] }
	| { role: "assistant"; content: IrContentPart[]; toolCalls: IrToolCall[] }
	| { role: "tool"; callId: string; content: string; isError?: boolean };

export type IrTool = {
	name: string;
	description?: string;
	parameters: unknown;
};

export type IrToolChoice =
	| { type: "auto" | "none" | "required" }
	| { type: "tool"; name: string };

export type IrRequest = {
	model: string;
	system: string[];
	messages: IrMessage[];
	tools: IrTool[];
	toolChoice?: IrToolChoice;
	maxTokens?: number;
	temperature?: number;
	topP?: number;
	stop?: string[];
	stream: boolean;
};

export type IrStop = "stop" | "length" | "tool_calls" | "content_filter";

export type IrUsage = {
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
};

export const EMPTY_USAGE: IrUsage = {
	inputTokens: null,
	outputTokens: null,
	cacheReadTokens: null,
	cacheWriteTokens: null,
};

/** 后到的字段覆盖先到的（流式里 usage 常分几次到达）。 */
export function mergeUsage(a: IrUsage, b: Partial<IrUsage>): IrUsage {
	return {
		inputTokens: b.inputTokens ?? a.inputTokens,
		outputTokens: b.outputTokens ?? a.outputTokens,
		cacheReadTokens: b.cacheReadTokens ?? a.cacheReadTokens,
		cacheWriteTokens: b.cacheWriteTokens ?? a.cacheWriteTokens,
	};
}

export type IrEvent =
	| { type: "start"; id?: string; model?: string }
	| { type: "text"; delta: string }
	| { type: "reasoning"; delta: string }
	/** index：本次响应里第几个工具调用（从 0 起，按出现顺序）。 */
	| { type: "tool_start"; index: number; id: string; name: string }
	| { type: "tool_args"; index: number; delta: string }
	| { type: "finish"; reason: IrStop }
	| { type: "usage"; usage: Partial<IrUsage> }
	| { type: "error"; message: string };

export type IrBlock =
	| { type: "text"; text: string }
	| { type: "reasoning"; text: string }
	| { type: "tool"; id: string; name: string; arguments: string };

export type IrResult = {
	id: string;
	model: string;
	blocks: IrBlock[];
	stop: IrStop;
	usage: IrUsage;
};

/** 一个 SSE 事件（`event:` 可缺省）。 */
export type SseEvent = { event?: string; data: string };

/** 上游流 → IR 事件。 */
export interface StreamParser {
	feed(ev: SseEvent): IrEvent[];
}

/** IR 事件 → 入口协议的 SSE 文本。结束原因与用量在上游流结束后一并交给 end。 */
export interface StreamEmitter {
	start(): string;
	event(ev: IrEvent): string;
	end(stop: IrStop, usage: IrUsage): string;
	error(message: string): string;
}

export type ProtocolCodec = {
	protocol: GatewayProtocol;
	/** 入口请求体 → IR；不支持的请求抛 CodecError。 */
	toIr(body: Record<string, unknown>): IrRequest;
	/** IR → 发给上游的请求体（一律流式）。 */
	fromIr(req: IrRequest): Record<string, unknown>;
	parser(): StreamParser;
	/** request：入口的原始请求体（例如 OpenAI 的 stream_options）。 */
	emitter(meta: {
		id: string;
		model: string;
		request: Record<string, unknown>;
	}): StreamEmitter;
	/** 非流式入口的响应体。 */
	result(res: IrResult): unknown;
	/** 该协议的错误体。 */
	errorBody(status: number, message: string): unknown;
	/** 直通时从上游响应文本里解析用量。 */
	usageOf(
		text: string,
		streaming: boolean,
	): {
		usage: IrUsage;
		parseError: boolean;
	};
};

export class CodecError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodecError";
	}
}

/** 把事件聚合成结果（非流式入口）。 */
export function collect(events: Iterable<IrEvent>, into: IrResult): void {
	for (const ev of events) {
		if (ev.type === "text") {
			const last = into.blocks.at(-1);
			if (last?.type === "text") last.text += ev.delta;
			else into.blocks.push({ type: "text", text: ev.delta });
		} else if (ev.type === "reasoning") {
			const last = into.blocks.at(-1);
			if (last?.type === "reasoning") last.text += ev.delta;
			else into.blocks.push({ type: "reasoning", text: ev.delta });
		} else if (ev.type === "tool_start") {
			into.blocks.push({
				type: "tool",
				id: ev.id,
				name: ev.name,
				arguments: "",
			});
		} else if (ev.type === "tool_args") {
			const tools = into.blocks.filter((b) => b.type === "tool");
			const t = tools[ev.index];
			if (t?.type === "tool") t.arguments += ev.delta;
		} else if (ev.type === "finish") into.stop = ev.reason;
		else if (ev.type === "usage") into.usage = mergeUsage(into.usage, ev.usage);
	}
}

// ─────────────────────────── 小工具 ───────────────────────────

export function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

export function num(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function arr(v: unknown): unknown[] {
	return Array.isArray(v) ? v : [];
}

/** 取有限数；给了却不是数 → 记一次格式错误。 */
export function usageNum(v: unknown, bad: { v: boolean }): number | null {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (v !== undefined && v !== null) bad.v = true;
	return null;
}

export function sseLine(data: unknown, event?: string): string {
	return `${event ? `event: ${event}\n` : ""}data: ${
		typeof data === "string" ? data : JSON.stringify(data)
	}\n\n`;
}

/** 工具调用参数须是 JSON 对象文本；空串视为 `{}`。 */
export function parseArgs(text: string): Record<string, unknown> {
	if (!text.trim()) return {};
	try {
		const v: unknown = JSON.parse(text);
		return isRecord(v) ? v : { value: v };
	} catch {
		return { _raw: text };
	}
}

/** SSE 解析：按空行分事件，支持 `event:` 与多行 `data:`。 */
export class SseDecoder {
	private buf = "";
	private decoder = new TextDecoder();

	push(chunk: Uint8Array | string): SseEvent[] {
		this.buf +=
			typeof chunk === "string"
				? chunk
				: this.decoder.decode(chunk, { stream: true });
		this.buf = this.buf.replace(/\r\n/g, "\n");
		const out: SseEvent[] = [];
		let at = this.buf.indexOf("\n\n");
		while (at >= 0) {
			const ev = parseBlock(this.buf.slice(0, at));
			if (ev) out.push(ev);
			this.buf = this.buf.slice(at + 2);
			at = this.buf.indexOf("\n\n");
		}
		return out;
	}

	end(): SseEvent[] {
		const rest = this.buf + this.decoder.decode();
		this.buf = "";
		const ev = parseBlock(rest.replace(/\r\n/g, "\n"));
		return ev ? [ev] : [];
	}
}

function parseBlock(block: string): SseEvent | null {
	let event: string | undefined;
	const data: string[] = [];
	for (const line of block.split("\n")) {
		if (line.startsWith("event:")) event = line.slice(6).trim();
		else if (line.startsWith("data:"))
			data.push(line.slice(5).replace(/^ /, ""));
	}
	if (data.length === 0) return null;
	return event ? { event, data: data.join("\n") } : { data: data.join("\n") };
}

/** 把整段 SSE 文本拆成事件（直通计量用）。 */
export function sseEvents(text: string): SseEvent[] {
	const d = new SseDecoder();
	return [...d.push(text), ...d.end()];
}

export function jsonOf(data: string): Record<string, unknown> | null {
	if (!data || data === "[DONE]") return null;
	try {
		const v: unknown = JSON.parse(data);
		return isRecord(v) ? v : null;
	} catch {
		return null;
	}
}
