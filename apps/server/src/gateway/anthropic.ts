/**
 * Anthropic Messages ⇄ IR。
 *
 * - 请求：system 可为字符串或文本块；user 消息里的 tool_result 拆成 IR 的 tool 消息（排在同条消息的
 *   其余内容之前）；assistant 的 tool_use 的 input 序列化为参数文本；thinking 块即推理内容（带签名）；
 *   发往 Anthropic 上游时只带回有签名的推理内容；
 *   没有 input_schema 的服务端工具（web_search 等）不支持翻译，丢弃；
 * - 发往上游：相邻同角色消息合并（tool 结果并入 user 且排在最前）、空文本块去掉，max_tokens 必填；
 * - 流：message_start 的用量（输入与缓存）、content_block_* 的文字与 input_json_delta、
 *   message_delta 的 stop_reason 与输出用量；
 * - 出流：工具块在整条消息结束时才关闭（OpenAI 上游的并行工具调用可能交错到达），文字块在下一个块开始时关闭。
 */
import { randomUUID } from "node:crypto";
import {
	arr,
	CodecError,
	EMPTY_USAGE,
	type IrContentPart,
	type IrEvent,
	type IrMessage,
	type IrRequest,
	type IrStop,
	type IrToolChoice,
	type IrUsage,
	isRecord,
	jsonOf,
	mergeUsage,
	num,
	type ProtocolCodec,
	parseArgs,
	type SseEvent,
	sseEvents,
	sseLine,
	str,
	usageNum,
} from "@/gateway/ir";

/** 上游要求必填 max_tokens；入口没给时用这个值。 */
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 8192;

function imageOf(b: Record<string, unknown>): IrContentPart | null {
	const src = isRecord(b.source) ? b.source : null;
	if (!src) return null;
	if (src.type === "base64")
		return {
			type: "image",
			data: str(src.data) ?? "",
			mediaType: str(src.media_type),
		};
	if (src.type === "url" && typeof src.url === "string")
		return { type: "image", url: src.url };
	return null;
}

function blocksOf(content: unknown): Record<string, unknown>[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return arr(content).filter(isRecord);
}

function toolResultText(content: unknown): string {
	if (typeof content === "string") return content;
	return blocksOf(content)
		.map((b) => (b.type === "text" ? (str(b.text) ?? "") : ""))
		.join("");
}

function toolChoiceOf(v: unknown): IrToolChoice | undefined {
	if (!isRecord(v)) return undefined;
	if (v.type === "auto" || v.type === "none") return { type: v.type };
	if (v.type === "any") return { type: "required" };
	if (v.type === "tool" && typeof v.name === "string")
		return { type: "tool", name: v.name };
	return undefined;
}

function toIr(body: Record<string, unknown>): IrRequest {
	if (!Array.isArray(body.messages))
		throw new CodecError("messages 必须是数组");
	const system =
		typeof body.system === "string"
			? [body.system]
			: blocksOf(body.system).flatMap((b) =>
					b.type === "text" && typeof b.text === "string" ? [b.text] : [],
				);
	const messages: IrMessage[] = [];
	for (const m of body.messages) {
		if (!isRecord(m)) continue;
		const blocks = blocksOf(m.content);
		if (m.role === "user") {
			const content: IrContentPart[] = [];
			for (const b of blocks) {
				if (b.type === "tool_result")
					messages.push({
						role: "tool",
						callId: str(b.tool_use_id) ?? "",
						content: toolResultText(b.content),
						...(b.is_error === true ? { isError: true } : {}),
					});
				else if (b.type === "text" && typeof b.text === "string")
					content.push({ type: "text", text: b.text });
				else if (b.type === "image") {
					const img = imageOf(b);
					if (img) content.push(img);
				}
			}
			if (content.length > 0) messages.push({ role: "user", content });
		} else if (m.role === "assistant") {
			const content: IrContentPart[] = [];
			const toolCalls: { id: string; name: string; arguments: string }[] = [];
			for (const b of blocks) {
				if (b.type === "text" && typeof b.text === "string")
					content.push({ type: "text", text: b.text });
				else if (b.type === "thinking" && typeof b.thinking === "string")
					content.push({
						type: "reasoning",
						text: b.thinking,
						...(typeof b.signature === "string" && b.signature
							? { signature: b.signature }
							: {}),
					});
				else if (b.type === "tool_use")
					toolCalls.push({
						id: str(b.id) ?? `toolu_${randomUUID()}`,
						name: str(b.name) ?? "",
						arguments: JSON.stringify(b.input ?? {}),
					});
			}
			messages.push({ role: "assistant", content, toolCalls });
		}
	}
	return {
		model: str(body.model) ?? "",
		system,
		messages,
		tools: arr(body.tools).flatMap((t) =>
			isRecord(t) && t.input_schema !== undefined
				? [
						{
							name: str(t.name) ?? "",
							description: str(t.description),
							parameters: t.input_schema,
						},
					]
				: [],
		),
		toolChoice: toolChoiceOf(body.tool_choice),
		maxTokens: num(body.max_tokens),
		temperature: num(body.temperature),
		topP: num(body.top_p),
		stop: arr(body.stop_sequences).filter(
			(x): x is string => typeof x === "string",
		),
		stream: body.stream === true,
	};
}

type Out = { role: "user" | "assistant"; content: Record<string, unknown>[] };

function fromIr(req: IrRequest): Record<string, unknown> {
	const out: Out[] = [];
	const push = (role: Out["role"], blocks: Record<string, unknown>[]) => {
		if (blocks.length === 0) return;
		const last = out.at(-1);
		if (last?.role === role) last.content.push(...blocks);
		else out.push({ role, content: blocks });
	};
	for (const m of req.messages) {
		if (m.role === "tool") {
			push("user", [
				{
					type: "tool_result",
					tool_use_id: m.callId,
					content: m.content,
					...(m.isError ? { is_error: true } : {}),
				},
			]);
		} else if (m.role === "user") {
			push(
				"user",
				m.content.flatMap((p): Record<string, unknown>[] =>
					p.type === "text"
						? p.text
							? [{ type: "text", text: p.text }]
							: []
						: p.type === "reasoning"
							? []
							: [
									{
										type: "image",
										source: p.url
											? { type: "url", url: p.url }
											: {
													type: "base64",
													media_type: p.mediaType ?? "image/png",
													data: p.data ?? "",
												},
									},
								],
				),
			);
		} else {
			push("assistant", [
				...m.content.flatMap((p) =>
					p.type === "reasoning" && p.signature
						? [{ type: "thinking", thinking: p.text, signature: p.signature }]
						: [],
				),
				...m.content.flatMap((p) =>
					p.type === "text" && p.text ? [{ type: "text", text: p.text }] : [],
				),
				...m.toolCalls.map((tc) => ({
					type: "tool_use",
					id: tc.id,
					name: tc.name,
					input: parseArgs(tc.arguments),
				})),
			]);
		}
	}
	// 工具结果必须紧跟在 user 消息开头。
	for (const m of out)
		if (m.role === "user")
			m.content.sort(
				(a, b) =>
					Number(b.type === "tool_result") - Number(a.type === "tool_result"),
			);
	const choice = req.toolChoice;
	return {
		model: req.model,
		...(req.system.length > 0 ? { system: req.system.join("\n\n") } : {}),
		messages: out,
		max_tokens: req.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
		...(req.tools.length > 0
			? {
					tools: req.tools.map((t) => ({
						name: t.name,
						...(t.description ? { description: t.description } : {}),
						input_schema: t.parameters,
					})),
				}
			: {}),
		...(choice && req.tools.length > 0
			? {
					tool_choice:
						choice.type === "tool"
							? { type: "tool", name: choice.name }
							: { type: choice.type === "required" ? "any" : choice.type },
				}
			: {}),
		...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
		...(req.topP !== undefined ? { top_p: req.topP } : {}),
		...(req.stop && req.stop.length > 0 ? { stop_sequences: req.stop } : {}),
		stream: true,
	};
}

const STOP_IN: Record<string, IrStop> = {
	end_turn: "stop",
	stop_sequence: "stop",
	pause_turn: "stop",
	max_tokens: "length",
	model_context_window_exceeded: "length",
	tool_use: "tool_calls",
	refusal: "content_filter",
};

const STOP_OUT: Record<IrStop, string> = {
	stop: "end_turn",
	length: "max_tokens",
	tool_calls: "tool_use",
	content_filter: "refusal",
};

function usagePart(
	u: Record<string, unknown>,
	bad: { v: boolean },
): Partial<IrUsage> {
	const out: Partial<IrUsage> = {};
	if (u.input_tokens !== undefined)
		out.inputTokens = usageNum(u.input_tokens, bad);
	if (u.output_tokens !== undefined)
		out.outputTokens = usageNum(u.output_tokens, bad);
	if (u.cache_read_input_tokens !== undefined)
		out.cacheReadTokens = usageNum(u.cache_read_input_tokens, bad);
	if (u.cache_creation_input_tokens !== undefined)
		out.cacheWriteTokens = usageNum(u.cache_creation_input_tokens, bad);
	return out;
}

function parser() {
	const kinds = new Map<number, "text" | "thinking" | "tool" | "other">();
	const toolIndex = new Map<number, number>();
	return {
		feed(ev: SseEvent): IrEvent[] {
			const obj = jsonOf(ev.data);
			if (!obj) return [];
			const bad = { v: false };
			switch (obj.type) {
				case "message_start": {
					const msg = isRecord(obj.message) ? obj.message : {};
					return [
						{ type: "start", id: str(msg.id), model: str(msg.model) },
						...(isRecord(msg.usage)
							? [{ type: "usage" as const, usage: usagePart(msg.usage, bad) }]
							: []),
					];
				}
				case "content_block_start": {
					const index = num(obj.index) ?? 0;
					const block = isRecord(obj.content_block) ? obj.content_block : {};
					if (block.type === "text") {
						kinds.set(index, "text");
						const t = str(block.text);
						return t ? [{ type: "text", delta: t }] : [];
					}
					if (block.type === "thinking") {
						kinds.set(index, "thinking");
						const t = str(block.thinking);
						return t ? [{ type: "reasoning", delta: t }] : [];
					}
					if (block.type === "tool_use") {
						kinds.set(index, "tool");
						const i = toolIndex.size;
						toolIndex.set(index, i);
						const input = block.input;
						const initial =
							isRecord(input) && Object.keys(input).length > 0
								? JSON.stringify(input)
								: "";
						return [
							{
								type: "tool_start",
								index: i,
								id: str(block.id) ?? `toolu_${randomUUID()}`,
								name: str(block.name) ?? "",
							},
							...(initial
								? [{ type: "tool_args" as const, index: i, delta: initial }]
								: []),
						];
					}
					kinds.set(index, "other");
					return [];
				}
				case "content_block_delta": {
					const index = num(obj.index) ?? 0;
					const delta = isRecord(obj.delta) ? obj.delta : {};
					if (delta.type === "text_delta" && typeof delta.text === "string")
						return delta.text ? [{ type: "text", delta: delta.text }] : [];
					if (
						delta.type === "thinking_delta" &&
						typeof delta.thinking === "string"
					)
						return delta.thinking
							? [{ type: "reasoning", delta: delta.thinking }]
							: [];
					if (
						delta.type === "input_json_delta" &&
						typeof delta.partial_json === "string"
					) {
						const i = toolIndex.get(index);
						return i === undefined || !delta.partial_json
							? []
							: [{ type: "tool_args", index: i, delta: delta.partial_json }];
					}
					return [];
				}
				case "message_delta": {
					const out: IrEvent[] = [];
					const delta = isRecord(obj.delta) ? obj.delta : {};
					const reason = str(delta.stop_reason);
					if (reason)
						out.push({ type: "finish", reason: STOP_IN[reason] ?? "stop" });
					if (isRecord(obj.usage))
						out.push({ type: "usage", usage: usagePart(obj.usage, bad) });
					return out;
				}
				case "error": {
					const err = isRecord(obj.error) ? obj.error : {};
					return [{ type: "error", message: str(err.message) ?? "上游出错" }];
				}
				default:
					return [];
			}
		},
	};
}

function usageOut(u: IrUsage) {
	return {
		input_tokens: u.inputTokens ?? 0,
		output_tokens: u.outputTokens ?? 0,
		cache_read_input_tokens: u.cacheReadTokens ?? 0,
		cache_creation_input_tokens: u.cacheWriteTokens ?? 0,
	};
}

function emitter(meta: { id: string; model: string }) {
	const ev = (type: string, data: Record<string, unknown>) =>
		sseLine({ type, ...data }, type);
	let next = 0;
	let textBlock: number | null = null;
	let thinkingBlock: number | null = null;
	const toolBlocks = new Map<number, number>();
	const open: number[] = [];
	const close = (index: number) => {
		const at = open.indexOf(index);
		if (at < 0) return "";
		open.splice(at, 1);
		return ev("content_block_stop", { index });
	};
	const closeAll = () => [...open].map(close).join("");
	return {
		start: () =>
			ev("message_start", {
				message: {
					id: meta.id,
					type: "message",
					role: "assistant",
					model: meta.model,
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 0, output_tokens: 0 },
				},
			}),
		event(e: IrEvent): string {
			if (e.type === "reasoning") {
				let out = "";
				if (thinkingBlock === null) {
					out += closeAll();
					textBlock = null;
					thinkingBlock = next++;
					open.push(thinkingBlock);
					out += ev("content_block_start", {
						index: thinkingBlock,
						content_block: { type: "thinking", thinking: "" },
					});
				}
				return (
					out +
					ev("content_block_delta", {
						index: thinkingBlock,
						delta: { type: "thinking_delta", thinking: e.delta },
					})
				);
			}
			if (e.type === "text") {
				let out = "";
				if (textBlock === null) {
					out += closeAll();
					thinkingBlock = null;
					textBlock = next++;
					open.push(textBlock);
					out += ev("content_block_start", {
						index: textBlock,
						content_block: { type: "text", text: "" },
					});
				}
				return (
					out +
					ev("content_block_delta", {
						index: textBlock,
						delta: { type: "text_delta", text: e.delta },
					})
				);
			}
			if (e.type === "tool_start") {
				let out = "";
				for (const b of [textBlock, thinkingBlock])
					if (b !== null) out += close(b);
				textBlock = null;
				thinkingBlock = null;
				const index = next++;
				toolBlocks.set(e.index, index);
				open.push(index);
				return (
					out +
					ev("content_block_start", {
						index,
						content_block: {
							type: "tool_use",
							id: e.id,
							name: e.name,
							input: {},
						},
					})
				);
			}
			if (e.type === "tool_args") {
				const index = toolBlocks.get(e.index);
				return index === undefined
					? ""
					: ev("content_block_delta", {
							index,
							delta: { type: "input_json_delta", partial_json: e.delta },
						});
			}
			return "";
		},
		end(stop: IrStop, usage: IrUsage): string {
			return (
				closeAll() +
				ev("message_delta", {
					delta: { stop_reason: STOP_OUT[stop], stop_sequence: null },
					usage: usageOut(usage),
				}) +
				ev("message_stop", {})
			);
		},
		error: (message: string) =>
			ev("error", { error: { type: "api_error", message } }),
	};
}

function errorType(status: number): string {
	if (status === 401) return "authentication_error";
	if (status === 403) return "permission_error";
	if (status === 404) return "not_found_error";
	if (status === 429) return "rate_limit_error";
	if (status >= 500) return "api_error";
	return "invalid_request_error";
}

export const anthropicMessages: ProtocolCodec = {
	protocol: "anthropic",
	toIr,
	fromIr,
	parser,
	emitter,
	result(res) {
		return {
			id: res.id,
			type: "message",
			role: "assistant",
			model: res.model,
			content: res.blocks.map((b) =>
				b.type === "text"
					? { type: "text", text: b.text }
					: b.type === "reasoning"
						? { type: "thinking", thinking: b.text }
						: {
								type: "tool_use",
								id: b.id,
								name: b.name,
								input: parseArgs(b.arguments),
							},
			),
			stop_reason: STOP_OUT[res.stop],
			stop_sequence: null,
			usage: usageOut(res.usage),
		};
	},
	errorBody: (status, message) => ({
		type: "error",
		error: { type: errorType(status), message },
	}),
	usageOf(text, streaming) {
		const bad = { v: false };
		if (!streaming) {
			const obj = jsonOf(text);
			return obj && isRecord(obj.usage)
				? {
						usage: mergeUsage(EMPTY_USAGE, usagePart(obj.usage, bad)),
						parseError: bad.v,
					}
				: { usage: EMPTY_USAGE, parseError: false };
		}
		let usage = EMPTY_USAGE;
		for (const ev of sseEvents(text)) {
			const obj = jsonOf(ev.data);
			if (!obj) continue;
			if (
				obj.type === "message_start" &&
				isRecord(obj.message) &&
				isRecord(obj.message.usage)
			)
				usage = mergeUsage(usage, usagePart(obj.message.usage, bad));
			else if (obj.type === "message_delta" && isRecord(obj.usage))
				usage = mergeUsage(usage, usagePart(obj.usage, bad));
		}
		return { usage, parseError: bad.v };
	},
};
