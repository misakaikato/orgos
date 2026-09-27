/**
 * OpenAI Responses ⇄ IR。网关是无状态的：previous_response_id 与内置工具（web_search 等）不支持翻译。
 *
 * - 请求：instructions 与 system / developer 消息并入系统提示；function_call 挂到前一条 assistant 消息上，
 *   function_call_output 即工具结果；reasoning 项取其摘要文本为推理内容（加密内容无法跨厂商，发往
 *   Responses 上游时不带推理项）；
 * - 流：output_item.added（function_call 开始）、output_text.delta、function_call_arguments.delta、
 *   response.completed / incomplete / failed（结束原因与用量）；只在 output_item.done 里给出参数的实现也兼容；
 * - 出流：推理内容不输出（Responses 的推理项要求厂商签发的加密内容，跨厂商给不出）；
 * - 用量：input_tokens 含缓存命中（input_tokens_details.cached_tokens）。
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
		if (
			(p.type === "input_text" ||
				p.type === "output_text" ||
				p.type === "text") &&
			typeof p.text === "string"
		)
			return [{ type: "text", text: p.text }];
		if (p.type === "input_image" && typeof p.image_url === "string") {
			const m = /^data:([^;]+);base64,(.*)$/s.exec(p.image_url);
			return m
				? [{ type: "image", mediaType: m[1], data: m[2] }]
				: [{ type: "image", url: p.image_url }];
		}
		return [];
	});
}

const textOf = (parts: IrContentPart[]) =>
	parts.map((p) => (p.type === "text" ? p.text : "")).join("");

function outputText(v: unknown): string {
	return typeof v === "string" ? v : textOf(partsOf(v));
}

function toolChoiceOf(v: unknown): IrToolChoice | undefined {
	if (v === "auto" || v === "none" || v === "required") return { type: v };
	if (isRecord(v) && v.type === "function" && typeof v.name === "string")
		return { type: "tool", name: v.name };
	return undefined;
}

function toIr(body: Record<string, unknown>): IrRequest {
	if (body.previous_response_id)
		throw new CodecError("网关不保存会话状态，不支持 previous_response_id");
	const system: string[] = [];
	const instructions = str(body.instructions);
	if (instructions) system.push(instructions);
	const messages: IrMessage[] = [];
	const items =
		typeof body.input === "string"
			? [{ role: "user", content: body.input }]
			: arr(body.input);
	for (const it of items) {
		if (!isRecord(it)) continue;
		if (it.type === "function_call") {
			const call = {
				id: str(it.call_id) ?? `call_${randomUUID()}`,
				name: str(it.name) ?? "",
				arguments: str(it.arguments) ?? "",
			};
			const last = messages.at(-1);
			if (last?.role === "assistant") last.toolCalls.push(call);
			else messages.push({ role: "assistant", content: [], toolCalls: [call] });
		} else if (it.type === "function_call_output") {
			messages.push({
				role: "tool",
				callId: str(it.call_id) ?? "",
				content: outputText(it.output),
			});
		} else if (it.type === undefined || it.type === "message") {
			const parts = partsOf(it.content);
			if (it.role === "system" || it.role === "developer") {
				const t = textOf(parts);
				if (t) system.push(t);
			} else if (it.role === "user")
				messages.push({ role: "user", content: parts });
			else if (it.role === "assistant")
				messages.push({ role: "assistant", content: parts, toolCalls: [] });
		} else if (it.type === "reasoning") {
			const text = arr(it.summary)
				.map((x) => (isRecord(x) ? (str(x.text) ?? "") : ""))
				.join("");
			if (text)
				messages.push({
					role: "assistant",
					content: [{ type: "reasoning", text }],
					toolCalls: [],
				});
		}
	}
	return {
		model: str(body.model) ?? "",
		system,
		messages,
		tools: arr(body.tools).flatMap((t) =>
			isRecord(t) && t.type === "function"
				? [
						{
							name: str(t.name) ?? "",
							description: str(t.description),
							parameters: t.parameters ?? { type: "object", properties: {} },
						},
					]
				: [],
		),
		toolChoice: toolChoiceOf(body.tool_choice),
		maxTokens: num(body.max_output_tokens),
		temperature: num(body.temperature),
		topP: num(body.top_p),
		stream: body.stream === true,
	};
}

function fromIr(req: IrRequest): Record<string, unknown> {
	const input: unknown[] = [];
	for (const m of req.messages) {
		if (m.role === "user")
			input.push({
				role: "user",
				content: m.content.flatMap((p) =>
					p.type === "reasoning"
						? []
						: p.type === "text"
							? { type: "input_text", text: p.text }
							: {
									type: "input_image",
									image_url:
										p.url ??
										`data:${p.mediaType ?? "image/png"};base64,${p.data}`,
								},
				),
			});
		else if (m.role === "tool")
			input.push({
				type: "function_call_output",
				call_id: m.callId,
				output: m.content,
			});
		else {
			const text = textOf(m.content);
			if (text)
				input.push({
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text }],
				});
			for (const tc of m.toolCalls)
				input.push({
					type: "function_call",
					call_id: tc.id,
					name: tc.name,
					arguments: tc.arguments || "{}",
				});
		}
	}
	const choice = req.toolChoice;
	return {
		model: req.model,
		...(req.system.length > 0 ? { instructions: req.system.join("\n\n") } : {}),
		input,
		...(req.tools.length > 0
			? {
					tools: req.tools.map((t) => ({
						type: "function",
						name: t.name,
						...(t.description ? { description: t.description } : {}),
						parameters: t.parameters,
					})),
				}
			: {}),
		...(choice
			? {
					tool_choice:
						choice.type === "tool"
							? { type: "function", name: choice.name }
							: choice.type,
				}
			: {}),
		...(req.maxTokens !== undefined
			? { max_output_tokens: req.maxTokens }
			: {}),
		...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
		...(req.topP !== undefined ? { top_p: req.topP } : {}),
		stream: true,
		store: false,
	};
}

function usageFrom(u: Record<string, unknown>, bad: { v: boolean }): IrUsage {
	const input = usageNum(u.input_tokens, bad);
	const details = isRecord(u.input_tokens_details)
		? u.input_tokens_details
		: {};
	const cached = usageNum(details.cached_tokens, bad);
	return {
		inputTokens: input === null ? null : Math.max(0, input - (cached ?? 0)),
		outputTokens: usageNum(u.output_tokens, bad),
		cacheReadTokens: cached,
		cacheWriteTokens: null,
	};
}

function parser() {
	const tools = new Map<number, { index: number; argsSeen: boolean }>();
	const byItemId = new Map<string, number>();
	return {
		feed(ev: SseEvent): IrEvent[] {
			const obj = jsonOf(ev.data);
			if (!obj) return [];
			const outputIndex = num(obj.output_index);
			const bad = { v: false };
			switch (obj.type) {
				case "response.created": {
					const resp = isRecord(obj.response) ? obj.response : {};
					return [{ type: "start", id: str(resp.id), model: str(resp.model) }];
				}
				case "response.reasoning_summary_text.delta":
				case "response.reasoning_text.delta": {
					const d = str(obj.delta);
					return d ? [{ type: "reasoning", delta: d }] : [];
				}
				case "response.output_item.added": {
					const item = isRecord(obj.item) ? obj.item : {};
					if (item.type !== "function_call" || outputIndex === undefined)
						return [];
					const index = tools.size;
					const args = str(item.arguments);
					tools.set(outputIndex, { index, argsSeen: Boolean(args) });
					const itemId = str(item.id);
					if (itemId) byItemId.set(itemId, outputIndex);
					return [
						{
							type: "tool_start",
							index,
							id: str(item.call_id) ?? itemId ?? `call_${randomUUID()}`,
							name: str(item.name) ?? "",
						},
						...(args
							? [{ type: "tool_args" as const, index, delta: args }]
							: []),
					];
				}
				case "response.output_text.delta": {
					const d = str(obj.delta);
					return d ? [{ type: "text", delta: d }] : [];
				}
				case "response.function_call_arguments.delta": {
					const at =
						outputIndex ?? byItemId.get(str(obj.item_id) ?? "") ?? undefined;
					const tool = at === undefined ? undefined : tools.get(at);
					const d = str(obj.delta);
					if (!tool || !d) return [];
					tool.argsSeen = true;
					return [{ type: "tool_args", index: tool.index, delta: d }];
				}
				case "response.output_item.done": {
					const item = isRecord(obj.item) ? obj.item : {};
					const tool =
						outputIndex === undefined ? undefined : tools.get(outputIndex);
					const args = str(item.arguments);
					if (item.type !== "function_call" || !tool || tool.argsSeen || !args)
						return [];
					tool.argsSeen = true;
					return [{ type: "tool_args", index: tool.index, delta: args }];
				}
				case "response.completed":
				case "response.incomplete":
				case "response.failed": {
					const resp = isRecord(obj.response) ? obj.response : {};
					const out: IrEvent[] = [];
					if (isRecord(resp.usage))
						out.push({ type: "usage", usage: usageFrom(resp.usage, bad) });
					if (obj.type === "response.failed") {
						const err = isRecord(resp.error) ? resp.error : {};
						out.push({
							type: "error",
							message: str(err.message) ?? "上游出错",
						});
						return out;
					}
					const reason = isRecord(resp.incomplete_details)
						? str(resp.incomplete_details.reason)
						: undefined;
					const stop: IrStop =
						obj.type === "response.incomplete"
							? reason === "content_filter"
								? "content_filter"
								: "length"
							: tools.size > 0
								? "tool_calls"
								: "stop";
					out.push({ type: "finish", reason: stop });
					return out;
				}
				case "error":
					return [{ type: "error", message: str(obj.message) ?? "上游出错" }];
				default:
					return [];
			}
		},
	};
}

function usageOut(u: IrUsage) {
	const cached = u.cacheReadTokens ?? 0;
	const input = (u.inputTokens ?? 0) + cached + (u.cacheWriteTokens ?? 0);
	const output = u.outputTokens ?? 0;
	return {
		input_tokens: input,
		input_tokens_details: { cached_tokens: cached },
		output_tokens: output,
		output_tokens_details: { reasoning_tokens: 0 },
		total_tokens: input + output,
	};
}

type Item =
	| { kind: "message"; outputIndex: number; id: string; text: string }
	| {
			kind: "tool";
			outputIndex: number;
			id: string;
			callId: string;
			name: string;
			args: string;
	  };

function itemJson(it: Item, status: string) {
	return it.kind === "message"
		? {
				id: it.id,
				type: "message",
				status,
				role: "assistant",
				content:
					status === "in_progress"
						? []
						: [{ type: "output_text", text: it.text, annotations: [] }],
			}
		: {
				id: it.id,
				type: "function_call",
				status,
				call_id: it.callId,
				name: it.name,
				arguments: status === "in_progress" ? "" : it.args,
			};
}

function statusOf(stop: IrStop) {
	return stop === "length" || stop === "content_filter"
		? {
				status: "incomplete",
				incomplete_details: {
					reason: stop === "length" ? "max_output_tokens" : "content_filter",
				},
			}
		: { status: "completed", incomplete_details: null };
}

function responseJson(
	meta: { id: string; model: string },
	created: number,
	extra: Record<string, unknown>,
) {
	return {
		id: meta.id,
		object: "response",
		created_at: created,
		model: meta.model,
		output: [],
		...extra,
	};
}

function emitter(meta: { id: string; model: string }) {
	const created = Math.floor(Date.now() / 1000);
	let seq = 0;
	const ev = (type: string, data: Record<string, unknown>) =>
		sseLine({ type, sequence_number: seq++, ...data }, type);
	const items: Item[] = [];
	let message: Extract<Item, { kind: "message" }> | null = null;
	const tools = new Map<number, Extract<Item, { kind: "tool" }>>();
	const done = new Set<Item>();
	const finishItem = (it: Item): string => {
		if (done.has(it)) return "";
		done.add(it);
		const base = { item_id: it.id, output_index: it.outputIndex };
		const head =
			it.kind === "message"
				? ev("response.output_text.done", {
						...base,
						content_index: 0,
						text: it.text,
					}) +
					ev("response.content_part.done", {
						...base,
						content_index: 0,
						part: { type: "output_text", text: it.text, annotations: [] },
					})
				: ev("response.function_call_arguments.done", {
						...base,
						arguments: it.args,
					});
		return (
			head +
			ev("response.output_item.done", {
				output_index: it.outputIndex,
				item: itemJson(it, "completed"),
			})
		);
	};
	return {
		start: () =>
			ev("response.created", {
				response: responseJson(meta, created, { status: "in_progress" }),
			}) +
			ev("response.in_progress", {
				response: responseJson(meta, created, { status: "in_progress" }),
			}),
		event(e: IrEvent): string {
			if (e.type === "text") {
				let out = "";
				if (!message) {
					message = {
						kind: "message",
						outputIndex: items.length,
						id: `msg_${randomUUID().replaceAll("-", "")}`,
						text: "",
					};
					items.push(message);
					out +=
						ev("response.output_item.added", {
							output_index: message.outputIndex,
							item: itemJson(message, "in_progress"),
						}) +
						ev("response.content_part.added", {
							item_id: message.id,
							output_index: message.outputIndex,
							content_index: 0,
							part: { type: "output_text", text: "", annotations: [] },
						});
				}
				message.text += e.delta;
				return (
					out +
					ev("response.output_text.delta", {
						item_id: message.id,
						output_index: message.outputIndex,
						content_index: 0,
						delta: e.delta,
					})
				);
			}
			if (e.type === "tool_start") {
				let out = "";
				if (message) {
					out += finishItem(message);
					message = null;
				}
				const it: Extract<Item, { kind: "tool" }> = {
					kind: "tool",
					outputIndex: items.length,
					id: `fc_${randomUUID().replaceAll("-", "")}`,
					callId: e.id,
					name: e.name,
					args: "",
				};
				items.push(it);
				tools.set(e.index, it);
				return (
					out +
					ev("response.output_item.added", {
						output_index: it.outputIndex,
						item: itemJson(it, "in_progress"),
					})
				);
			}
			if (e.type === "tool_args") {
				const it = tools.get(e.index);
				if (!it) return "";
				it.args += e.delta;
				return ev("response.function_call_arguments.delta", {
					item_id: it.id,
					output_index: it.outputIndex,
					delta: e.delta,
				});
			}
			return "";
		},
		end(stop: IrStop, usage: IrUsage): string {
			const closing = items.map(finishItem).join("");
			const st = statusOf(stop);
			return (
				closing +
				ev(
					st.status === "completed"
						? "response.completed"
						: "response.incomplete",
					{
						response: responseJson(meta, created, {
							...st,
							output: items.map((it) => itemJson(it, "completed")),
							usage: usageOut(usage),
						}),
					},
				)
			);
		},
		error: (message: string) =>
			ev("error", { code: "api_error", message, param: null }),
	};
}

export const openaiResponses: ProtocolCodec = {
	protocol: "responses",
	toIr,
	fromIr,
	parser,
	emitter,
	result(res) {
		let text: Item | null = null;
		const items: Item[] = [];
		for (const b of res.blocks) {
			if (b.type === "text") {
				if (text?.kind === "message") text.text += b.text;
				else {
					text = {
						kind: "message",
						outputIndex: items.length,
						id: `msg_${randomUUID().replaceAll("-", "")}`,
						text: b.text,
					};
					items.push(text);
				}
			} else if (b.type === "tool") {
				text = null;
				items.push({
					kind: "tool",
					outputIndex: items.length,
					id: `fc_${randomUUID().replaceAll("-", "")}`,
					callId: b.id,
					name: b.name,
					args: b.arguments,
				});
			}
		}
		return responseJson(res, Math.floor(Date.now() / 1000), {
			...statusOf(res.stop),
			output: items.map((it) => itemJson(it, "completed")),
			usage: usageOut(res.usage),
		});
	},
	errorBody: (status, message) => ({
		error: {
			message,
			type: status >= 500 ? "server_error" : "invalid_request_error",
			code: null,
			param: null,
		},
	}),
	usageOf(text, streaming) {
		const bad = { v: false };
		if (!streaming) {
			const obj = jsonOf(text);
			return obj && isRecord(obj.usage)
				? { usage: usageFrom(obj.usage, bad), parseError: bad.v }
				: { usage: EMPTY_USAGE, parseError: false };
		}
		let usage = EMPTY_USAGE;
		for (const ev of sseEvents(text)) {
			const obj = jsonOf(ev.data);
			const resp = obj && isRecord(obj.response) ? obj.response : null;
			if (resp && isRecord(resp.usage)) usage = usageFrom(resp.usage, bad);
		}
		return { usage, parseError: bad.v };
	},
};
