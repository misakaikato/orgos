/**
 * 测试用的假上游（node:http）：同时说 OpenAI Chat Completions（`/openai/...`）与 Anthropic Messages
 * （`/anthropic/v1/...`），含流式与工具调用。每个请求留档供断言。
 *
 * 默认行为：最后一条 user 消息里有"用工具"且带了工具 → 调第一个工具，参数 `{"q":"预算"}`（分两片流出）；
 * 否则回"你好，世界"（分两片）。鉴权头与构造时给的 key 不符 → 401，错误信息里回显收到的 key
 * （检验网关会把 key 抹掉）。`script(path, …)` 可排入一次性的响应（按顺序消费）。
 */
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_TEXT = ["你好，", "世界"] as const;
export const FAKE_TOOL = {
	name: "lookup",
	args: ['{"q":', '"预算"}'],
} as const;
export const OPENAI_USAGE = {
	prompt_tokens: 100,
	completion_tokens: 7,
	prompt_tokens_details: { cached_tokens: 20 },
};
export const ANTHROPIC_USAGE = {
	input_tokens: 80,
	cache_read_input_tokens: 20,
	output_tokens: 7,
};

export type Scripted = {
	status?: number;
	body?: string;
	contentType?: string;
	/** 晚这么久才回（测中止与超时）。 */
	delayMs?: number;
};

export type Recorded = {
	path: string;
	headers: IncomingHttpHeaders;
	body: Record<string, unknown>;
};

export type FakeUpstream = {
	url: string;
	requests: Recorded[];
	script(path: string, ...responses: Scripted[]): void;
	close(): Promise<void>;
};

export function sse(events: unknown[], named = false): string {
	return events
		.map((e) =>
			named
				? `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`
				: `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`,
		)
		.join("");
}

function lastUserText(body: Record<string, unknown>): string {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const last = [...messages]
		.reverse()
		.find((m) => (m as { role?: string }).role === "user") as
		| { content?: unknown }
		| undefined;
	const c = last?.content;
	if (typeof c === "string") return c;
	return Array.isArray(c)
		? c.map((p) => (p as { text?: string }).text ?? "").join("")
		: "";
}

function wantsTool(body: Record<string, unknown>): boolean {
	return (
		Array.isArray(body.tools) &&
		body.tools.length > 0 &&
		lastUserText(body).includes("用工具")
	);
}

function openaiReply(body: Record<string, unknown>): Scripted {
	const tool = wantsTool(body);
	const model = String(body.model);
	if (body.stream !== true) {
		return {
			body: JSON.stringify({
				id: "chatcmpl-fake",
				object: "chat.completion",
				model,
				choices: [
					{
						index: 0,
						message: tool
							? {
									role: "assistant",
									content: null,
									tool_calls: [
										{
											id: "call_fake",
											type: "function",
											function: {
												name: FAKE_TOOL.name,
												arguments: FAKE_TOOL.args.join(""),
											},
										},
									],
								}
							: { role: "assistant", content: FAKE_TEXT.join("") },
						finish_reason: tool ? "tool_calls" : "stop",
					},
				],
				usage: OPENAI_USAGE,
			}),
			contentType: "application/json",
		};
	}
	const chunk = (delta: unknown, finish: string | null = null) => ({
		id: "chatcmpl-fake",
		object: "chat.completion.chunk",
		model,
		choices: [{ index: 0, delta, finish_reason: finish }],
	});
	const events: unknown[] = tool
		? [
				chunk({
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id: "call_fake",
							type: "function",
							function: { name: FAKE_TOOL.name, arguments: FAKE_TOOL.args[0] },
						},
					],
				}),
				chunk({
					tool_calls: [
						{ index: 0, function: { arguments: FAKE_TOOL.args[1] } },
					],
				}),
				chunk({}, "tool_calls"),
			]
		: [
				chunk({ role: "assistant", content: FAKE_TEXT[0] }),
				chunk({ content: FAKE_TEXT[1] }),
				chunk({}, "stop"),
			];
	const includeUsage =
		(body.stream_options as { include_usage?: boolean } | undefined)
			?.include_usage === true;
	if (includeUsage)
		events.push({ ...chunk({}), choices: [], usage: OPENAI_USAGE });
	events.push("[DONE]");
	return { body: sse(events), contentType: "text/event-stream" };
}

function anthropicReply(body: Record<string, unknown>): Scripted {
	const tool = wantsTool(body);
	const model = String(body.model);
	if (body.stream !== true)
		return {
			body: JSON.stringify({
				id: "msg_fake",
				type: "message",
				role: "assistant",
				model,
				content: tool
					? [
							{
								type: "tool_use",
								id: "toolu_fake",
								name: FAKE_TOOL.name,
								input: JSON.parse(FAKE_TOOL.args.join("")),
							},
						]
					: [{ type: "text", text: FAKE_TEXT.join("") }],
				stop_reason: tool ? "tool_use" : "end_turn",
				usage: ANTHROPIC_USAGE,
			}),
			contentType: "application/json",
		};
	const events: unknown[] = [
		{
			type: "message_start",
			message: {
				id: "msg_fake",
				type: "message",
				role: "assistant",
				model,
				content: [],
				usage: {
					input_tokens: ANTHROPIC_USAGE.input_tokens,
					cache_read_input_tokens: ANTHROPIC_USAGE.cache_read_input_tokens,
					output_tokens: 1,
				},
			},
		},
		{ type: "ping" },
	];
	if (tool)
		events.push(
			{
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: "toolu_fake",
					name: FAKE_TOOL.name,
					input: {},
				},
			},
			...FAKE_TOOL.args.map((partial_json) => ({
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json },
			})),
			{ type: "content_block_stop", index: 0 },
		);
	else
		events.push(
			{
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			},
			...FAKE_TEXT.map((text) => ({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text },
			})),
			{ type: "content_block_stop", index: 0 },
		);
	events.push(
		{
			type: "message_delta",
			delta: { stop_reason: tool ? "tool_use" : "end_turn" },
			usage: { output_tokens: ANTHROPIC_USAGE.output_tokens },
		},
		{ type: "message_stop" },
	);
	return { body: sse(events, true), contentType: "text/event-stream" };
}

export async function startFakeUpstream(keys: {
	openai: string;
	anthropic: string;
}): Promise<FakeUpstream> {
	const requests: Recorded[] = [];
	const scripts = new Map<string, Scripted[]>();
	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", (d: Buffer) => {
			raw += d.toString();
		});
		req.on("end", () => {
			const path = (req.url ?? "").split("?")[0] ?? "";
			let body: Record<string, unknown> = {};
			try {
				body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
			} catch {}
			requests.push({ path, headers: req.headers, body });
			const send = (r: Scripted) => {
				const write = () => {
					if (res.destroyed) return;
					res.writeHead(r.status ?? 200, {
						"content-type": r.contentType ?? "application/json",
					});
					res.end(r.body ?? "");
				};
				if (r.delayMs) setTimeout(write, r.delayMs);
				else write();
			};
			const queued = scripts.get(path)?.shift();
			if (queued) return send(queued);
			const isAnthropic = path.startsWith("/anthropic/");
			const got = isAnthropic
				? req.headers["x-api-key"]
				: String(req.headers.authorization ?? "").replace(/^Bearer /, "");
			const expected = isAnthropic ? keys.anthropic : keys.openai;
			if (got !== expected)
				return send({
					status: 401,
					body: JSON.stringify({
						error: { message: `Incorrect API key provided: ${got}` },
					}),
				});
			if (path.endsWith("/models"))
				return send({
					body: JSON.stringify({
						data: [{ id: "m-large" }, { id: "m-small" }],
					}),
				});
			if (path === "/openai/chat/completions") return send(openaiReply(body));
			if (path === "/anthropic/v1/messages") return send(anthropicReply(body));
			send({ status: 404, body: "{}" });
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		script(path, ...responses) {
			scripts.set(path, [...(scripts.get(path) ?? []), ...responses]);
		},
		close: () =>
			new Promise<void>((r) => {
				server.closeAllConnections();
				server.close(() => r());
			}),
	};
}
