/**
 * OpenAI Chat Completions ⇄ IR。
 *
 * - 请求：system / developer 并入系统提示；tool 消息即工具结果；图片取 image_url；
 *   max_completion_tokens 优先于 max_tokens；
 * - 流：choices[0].delta 的 content、reasoning_content（DeepSeek 等的推理内容）与 tool_calls
 *   （按 index 拼参数）、finish_reason、末尾的 usage；assistant 消息的 reasoning_content 即推理内容片段；
 * - 用量：prompt_tokens 含缓存命中，IR 的 inputTokens 记非缓存部分。
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
	num,
	type ProtocolCodec,
	type SseEvent,
	sseEvents,
	sseLine,
	str,
	usageNum,
} from "@/gateway/ir";

function partsOf(content: unknown): IrContentPart[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return arr(content).flatMap((p): IrContentPart[] => {
		if (!isRecord(p)) return [];
		if (p.type === "text" && typeof p.text === "string")
			return [{ type: "text", text: p.text }];
		if (p.type === "image_url") {
			const url = isRecord(p.image_url)
				? str(p.image_url.url)
				: str(p.image_url);
			if (!url) return [];
			const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
			return m
				? [{ type: "image", mediaType: m[1], data: m[2] }]
				: [{ type: "image", url }];
		}
		return [];
	});
}

export function textOf(content: unknown): string {
	return partsOf(content)
		.map((p) => (p.type === "text" ? p.text : ""))
		.join("");
}

function toolChoiceOf(v: unknown): IrToolChoice | undefined {
	if (v === "auto" || v === "none" || v === "required") return { type: v };
	if (
		isRecord(v) &&
		isRecord(v.function) &&
		typeof v.function.name === "string"
	)
		return { type: "tool", name: v.function.name };
	return undefined;
}

function toIr(body: Record<string, unknown>): IrRequest {
	if (!Array.isArray(body.messages))
		throw new CodecError("messages 必须是数组");
	const system: string[] = [];
	const messages: IrMessage[] = [];
	for (const m of body.messages) {
		if (!isRecord(m)) continue;
		if (m.role === "system" || m.role === "developer") {
			const t = textOf(m.content);
			if (t) system.push(t);
		} else if (m.role === "user") {
			messages.push({ role: "user", content: partsOf(m.content) });
		} else if (m.role === "assistant") {
			const reasoning = str(m.reasoning_content);
			messages.push({
				role: "assistant",
				content: [
					...(reasoning
						? [{ type: "reasoning" as const, text: reasoning }]
						: []),
					...partsOf(m.content ?? ""),
				],
				toolCalls: arr(m.tool_calls).flatMap((tc) => {
					if (!isRecord(tc) || !isRecord(tc.function)) return [];
					return [
						{
							id: str(tc.id) ?? randomUUID(),
							name: str(tc.function.name) ?? "",
							arguments: str(tc.function.arguments) ?? "",
						},
					];
				}),
			});
		} else if (m.role === "tool") {
			messages.push({
				role: "tool",
				callId: str(m.tool_call_id) ?? "",
				content: textOf(m.content),
			});
		}
	}
	const stop =
		typeof body.stop === "string"
			? [body.stop]
			: arr(body.stop).filter((x): x is string => typeof x === "string");
	return {
		model: str(body.model) ?? "",
		system,
		messages,
		tools: arr(body.tools).flatMap((t) =>
			isRecord(t) && t.type === "function" && isRecord(t.function)
				? [
						{
							name: str(t.function.name) ?? "",
							description: str(t.function.description),
							parameters: t.function.parameters ?? {
								type: "object",
								properties: {},
							},
						},
					]
				: [],
		),
		toolChoice: toolChoiceOf(body.tool_choice),
		maxTokens: num(body.max_completion_tokens) ?? num(body.max_tokens),
		temperature: num(body.temperature),
		topP: num(body.top_p),
		stop: stop.length > 0 ? stop : undefined,
		stream: body.stream === true,
	};
}

function partsOut(all: IrContentPart[]): unknown {
	const parts = all.filter((p) => p.type !== "reasoning");
	if (parts.every((p) => p.type === "text"))
		return parts.map((p) => (p.type === "text" ? p.text : "")).join("");
	return parts.map((p) =>
		p.type !== "image"
			? { type: "text", text: p.type === "text" ? p.text : "" }
			: {
					type: "image_url",
					image_url: {
						url: p.url ?? `data:${p.mediaType ?? "image/png"};base64,${p.data}`,
					},
				},
	);
}

function fromIr(req: IrRequest): Record<string, unknown> {
	const messages: unknown[] = [];
	if (req.system.length > 0)
		messages.push({ role: "system", content: req.system.join("\n\n") });
	for (const m of req.messages) {
		if (m.role === "user")
			messages.push({ role: "user", content: partsOut(m.content) });
		else if (m.role === "tool")
			messages.push({
				role: "tool",
				tool_call_id: m.callId,
				content: m.content,
			});
		else {
			const text = m.content
				.map((p) => (p.type === "text" ? p.text : ""))
				.join("");
			const reasoning = m.content
				.map((p) => (p.type === "reasoning" ? p.text : ""))
				.join("");
			messages.push({
				role: "assistant",
				content: text || null,
				...(reasoning ? { reasoning_content: reasoning } : {}),
				...(m.toolCalls.length > 0
					? {
							tool_calls: m.toolCalls.map((tc) => ({
								id: tc.id,
								type: "function",
								function: { name: tc.name, arguments: tc.arguments || "{}" },
							})),
						}
					: {}),
			});
		}
	}
	const choice = req.toolChoice;
	return {
		model: req.model,
		messages,
		...(req.tools.length > 0
			? {
					tools: req.tools.map((t) => ({
						type: "function",
						function: {
							name: t.name,
							...(t.description ? { description: t.description } : {}),
							parameters: t.parameters,
						},
					})),
				}
			: {}),
		...(choice
			? {
					tool_choice:
						choice.type === "tool"
							? { type: "function", function: { name: choice.name } }
							: choice.type,
				}
			: {}),
		...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
		...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
		...(req.topP !== undefined ? { top_p: req.topP } : {}),
		...(req.stop ? { stop: req.stop } : {}),
		stream: true,
		stream_options: { include_usage: true },
	};
}

const FINISH_IN: Record<string, IrStop> = {
	stop: "stop",
	length: "length",
	tool_calls: "tool_calls",
	function_call: "tool_calls",
	content_filter: "content_filter",
};

const FINISH_OUT: Record<IrStop, string> = {
	stop: "stop",
	length: "length",
	tool_calls: "tool_calls",
	content_filter: "content_filter",
};

function usageFrom(u: Record<string, unknown>): {
	usage: IrUsage;
	parseError: boolean;
} {
	const bad = { v: false };
	const prompt = usageNum(u.prompt_tokens, bad);
	const details = isRecord(u.prompt_tokens_details)
		? u.prompt_tokens_details
		: {};
	const cached = usageNum(details.cached_tokens, bad);
	return {
		usage: {
			inputTokens: prompt === null ? null : Math.max(0, prompt - (cached ?? 0)),
			outputTokens: usageNum(u.completion_tokens, bad),
			cacheReadTokens: cached,
			cacheWriteTokens: null,
		},
		parseError: bad.v,
	};
}

function parser() {
	const indexOf = new Map<number, number>();
	let started = false;
	return {
		feed(ev: SseEvent): IrEvent[] {
			const obj = jsonOf(ev.data);
			if (!obj) return [];
			if (isRecord(obj.error))
				return [
					{ type: "error", message: str(obj.error.message) ?? "上游出错" },
				];
			const out: IrEvent[] = [];
			if (!started) {
				started = true;
				out.push({ type: "start", id: str(obj.id), model: str(obj.model) });
			}
			const choice = arr(obj.choices)[0];
			if (isRecord(choice)) {
				const delta = isRecord(choice.delta) ? choice.delta : {};
				if (
					typeof delta.reasoning_content === "string" &&
					delta.reasoning_content
				)
					out.push({ type: "reasoning", delta: delta.reasoning_content });
				if (typeof delta.content === "string" && delta.content)
					out.push({ type: "text", delta: delta.content });
				for (const tc of arr(delta.tool_calls)) {
					if (!isRecord(tc)) continue;
					const upstream = num(tc.index) ?? 0;
					const fn = isRecord(tc.function) ? tc.function : {};
					let index = indexOf.get(upstream);
					if (index === undefined) {
						index = indexOf.size;
						indexOf.set(upstream, index);
						out.push({
							type: "tool_start",
							index,
							id: str(tc.id) || `call_${randomUUID()}`,
							name: str(fn.name) ?? "",
						});
					}
					const args = str(fn.arguments);
					if (args) out.push({ type: "tool_args", index, delta: args });
				}
				const finish = str(choice.finish_reason);
				if (finish)
					out.push({ type: "finish", reason: FINISH_IN[finish] ?? "stop" });
			}
			if (isRecord(obj.usage))
				out.push({ type: "usage", usage: usageFrom(obj.usage).usage });
			return out;
		},
	};
}

function usageOut(u: IrUsage) {
	const cached = u.cacheReadTokens ?? 0;
	const prompt = (u.inputTokens ?? 0) + cached + (u.cacheWriteTokens ?? 0);
	const completion = u.outputTokens ?? 0;
	return {
		prompt_tokens: prompt,
		completion_tokens: completion,
		total_tokens: prompt + completion,
		prompt_tokens_details: { cached_tokens: cached },
	};
}

function emitter(meta: {
	id: string;
	model: string;
	request: Record<string, unknown>;
}) {
	const created = Math.floor(Date.now() / 1000);
	const includeUsage =
		isRecord(meta.request.stream_options) &&
		meta.request.stream_options.include_usage === true;
	const chunk = (delta: unknown, finish: string | null = null) =>
		sseLine({
			id: meta.id,
			object: "chat.completion.chunk",
			created,
			model: meta.model,
			choices: [{ index: 0, delta, finish_reason: finish }],
		});
	return {
		start: () => chunk({ role: "assistant", content: "" }),
		event(ev: IrEvent): string {
			if (ev.type === "text") return chunk({ content: ev.delta });
			if (ev.type === "reasoning")
				return chunk({ reasoning_content: ev.delta });
			if (ev.type === "tool_start")
				return chunk({
					tool_calls: [
						{
							index: ev.index,
							id: ev.id,
							type: "function",
							function: { name: ev.name, arguments: "" },
						},
					],
				});
			if (ev.type === "tool_args")
				return chunk({
					tool_calls: [{ index: ev.index, function: { arguments: ev.delta } }],
				});
			return "";
		},
		end(stop: IrStop, usage: IrUsage): string {
			return (
				chunk({}, FINISH_OUT[stop]) +
				(includeUsage
					? sseLine({
							id: meta.id,
							object: "chat.completion.chunk",
							created,
							model: meta.model,
							choices: [],
							usage: usageOut(usage),
						})
					: "") +
				sseLine("[DONE]")
			);
		},
		error: (message: string) =>
			sseLine({ error: { message, type: "api_error", code: null } }) +
			sseLine("[DONE]"),
	};
}

export const openaiChat: ProtocolCodec = {
	protocol: "openai",
	toIr,
	fromIr,
	parser,
	emitter,
	result(res) {
		const text = res.blocks
			.map((b) => (b.type === "text" ? b.text : ""))
			.join("");
		const reasoning = res.blocks
			.map((b) => (b.type === "reasoning" ? b.text : ""))
			.join("");
		const calls = res.blocks.flatMap((b) =>
			b.type === "tool"
				? [
						{
							id: b.id,
							type: "function",
							function: { name: b.name, arguments: b.arguments || "{}" },
						},
					]
				: [],
		);
		return {
			id: res.id,
			object: "chat.completion",
			created: Math.floor(Date.now() / 1000),
			model: res.model,
			choices: [
				{
					index: 0,
					message: {
						role: "assistant",
						content: text || null,
						...(reasoning ? { reasoning_content: reasoning } : {}),
						...(calls.length > 0 ? { tool_calls: calls } : {}),
					},
					finish_reason: FINISH_OUT[res.stop],
				},
			],
			usage: usageOut(res.usage),
		};
	},
	errorBody: (status, message) => ({
		error: {
			message,
			type: status >= 500 ? "api_error" : "invalid_request_error",
			code: null,
		},
	}),
	usageOf(text, streaming) {
		if (streaming) {
			let last: Record<string, unknown> | null = null;
			for (const ev of sseEvents(text)) {
				const obj = jsonOf(ev.data);
				if (obj && isRecord(obj.usage)) last = obj.usage;
			}
			return last ? usageFrom(last) : { usage: EMPTY_USAGE, parseError: false };
		}
		const obj = jsonOf(text);
		return obj && isRecord(obj.usage)
			? usageFrom(obj.usage)
			: { usage: EMPTY_USAGE, parseError: false };
	},
};
