/**
 * 集成：DeepSeek 客户端（假 fetch 回放 SSE）——请求体、流式解析、重试、中止与 llm_requests 记账。
 */
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createDeepSeekClient } from "@/agent/llm";
import {
	LlmAbortedError,
	type LlmRequest,
	LlmUnavailableError,
} from "@/agent/llm-types";
import { llmRequests } from "@/db/schema";
import { scoped } from "@/db/scope";
import { createTeam, type TeamMember } from "./helpers";

function sse(chunks: unknown[]): string {
	return `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
}

const OK_STREAM = sse([
	{ choices: [{ delta: { role: "assistant", content: "你好，" } }] },
	{ choices: [{ delta: { content: "我是分身。" } }] },
	{ choices: [{ delta: {}, finish_reason: "stop" }] },
	{
		choices: [],
		usage: {
			prompt_tokens: 1200,
			completion_tokens: 30,
			prompt_tokens_details: { cached_tokens: 200 },
		},
	},
]);

const TOOL_STREAM = sse([
	{
		choices: [
			{
				delta: {
					tool_calls: [
						{
							index: 0,
							id: "call_1",
							type: "function",
							function: { name: "knowledge_search", arguments: '{"que' },
						},
					],
				},
			},
		],
	},
	{
		choices: [
			{
				delta: {
					tool_calls: [{ index: 0, function: { arguments: 'ry":"预算"}' } }],
				},
			},
		],
	},
	{ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
]);

type Call = { url: string; body: Record<string, unknown> };

function fakeFetch(responses: (() => Response | Promise<Response>)[]) {
	const calls: Call[] = [];
	const impl = (async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({
			url: String(url),
			body: JSON.parse(String(init?.body)),
		});
		const next = responses.shift();
		if (!next) throw new Error("没有更多响应");
		return next();
	}) as typeof fetch;
	return { impl, calls };
}

let alice: TeamMember;
let agentId: string;

beforeAll(async () => {
	[alice] = (await createTeam(["Alice"])) as [TeamMember];
	agentId = alice.me.agents[0]?.principal.id ?? "";
});

function request(extra: Partial<LlmRequest> = {}): LlmRequest {
	return {
		messages: [
			{ role: "system", content: "系统提示" },
			{ role: "user", content: "【Bob】你好" },
		],
		tools: [],
		meta: {
			tenantId: alice.me.tenant.id,
			agentId,
			onBehalfOfId: alice.me.principal.id,
			conversationId: null,
			runId: null,
			model: "deepseek-v4-flash",
		},
		trigger: {
			text: "你好",
			mentions: [],
			agent: { id: agentId, handle: "x" },
			conversationKind: "dm",
		},
		...extra,
	};
}

async function rows() {
	return scoped(alice.me.tenant.id).select(
		llmRequests,
		eq(llmRequests.agentId, agentId),
	);
}

describe("createDeepSeekClient", () => {
	it("成功：请求体带关思考 / include_usage / max_tokens，流式拼文本，记账含成本", async () => {
		const before = (await rows()).length;
		const { impl, calls } = fakeFetch([
			() => new Response(OK_STREAM, { status: 200 }),
		]);
		const deltas: string[] = [];
		const res = await createDeepSeekClient({
			apiKey: "test-key",
			fetch: impl,
		}).complete(request({ onDelta: (d) => deltas.push(d) }));
		expect(res).toEqual({
			text: "你好，我是分身。",
			toolCalls: [],
			reasoning: false,
		});
		expect(deltas).toEqual(["你好，", "我是分身。"]);
		expect(calls[0]?.url).toBe("https://api.deepseek.com/v1/chat/completions");
		expect(calls[0]?.body).toMatchObject({
			model: "deepseek-v4-flash",
			stream: true,
			stream_options: { include_usage: true },
			max_tokens: 4000,
			thinking: { type: "disabled" },
		});
		expect(calls[0]?.body).not.toHaveProperty("tools");
		const all = await rows();
		expect(all).toHaveLength(before + 1);
		expect(all.at(-1)).toMatchObject({
			provider: "deepseek",
			model: "deepseek-v4-flash",
			httpStatus: 200,
			inputTokens: 1000,
			cacheReadTokens: 200,
			outputTokens: 30,
			// 1000×0.139 + 30×0.278 + 200×0.0028 = 147.9
			costMicroUsd: 148,
			parseError: false,
		});
	});

	it("工具调用分片拼接成完整参数", async () => {
		const { impl } = fakeFetch([
			() => new Response(TOOL_STREAM, { status: 200 }),
		]);
		const res = await createDeepSeekClient({
			apiKey: "k",
			fetch: impl,
		}).complete(request());
		expect(res.toolCalls).toEqual([
			{
				id: "call_1",
				name: "knowledge_search",
				arguments: '{"query":"预算"}',
			},
		]);
	});

	it("5xx 与 429 重试后成功：每次 HTTP 调用各记一行", async () => {
		const before = (await rows()).length;
		const { impl, calls } = fakeFetch([
			() => new Response("busy", { status: 503 }),
			() => new Response("slow down", { status: 429 }),
			() => new Response(OK_STREAM, { status: 200 }),
		]);
		const res = await createDeepSeekClient({
			apiKey: "k",
			fetch: impl,
			retryDelaysMs: [1, 1],
		}).complete(request());
		expect(res.text).toBe("你好，我是分身。");
		expect(calls).toHaveLength(3);
		const statuses = (await rows()).slice(before).map((r) => r.httpStatus);
		expect(statuses).toEqual([503, 429, 200]);
	});

	it("重试 2 次仍失败 → LlmUnavailableError，三行失败记录", async () => {
		const before = (await rows()).length;
		const { impl } = fakeFetch([
			() => new Response("x", { status: 500 }),
			() => Promise.reject(new TypeError("network down")),
			() => new Response("x", { status: 502 }),
		]);
		await expect(
			createDeepSeekClient({
				apiKey: "k",
				fetch: impl,
				retryDelaysMs: [1, 1],
			}).complete(request()),
		).rejects.toBeInstanceOf(LlmUnavailableError);
		const failed = (await rows()).slice(before);
		expect(failed.map((r) => r.httpStatus)).toEqual([500, 0, 502]);
		expect(failed.every((r) => r.inputTokens === null)).toBe(true);
	});

	it("4xx（非 429）不重试", async () => {
		const { impl, calls } = fakeFetch([
			() => new Response("bad", { status: 400 }),
		]);
		await expect(
			createDeepSeekClient({ apiKey: "k", fetch: impl }).complete(request()),
		).rejects.toBeInstanceOf(LlmUnavailableError);
		expect(calls).toHaveLength(1);
	});

	it("中止：抛 LlmAbortedError，记一行 499", async () => {
		const before = (await rows()).length;
		const controller = new AbortController();
		const { impl } = fakeFetch([
			() =>
				new Promise<Response>((_, reject) => {
					controller.signal.addEventListener("abort", () =>
						reject(new DOMException("aborted", "AbortError")),
					);
					setTimeout(() => controller.abort(), 5);
				}),
		]);
		await expect(
			createDeepSeekClient({ apiKey: "k", fetch: impl }).complete(
				request({ signal: controller.signal }),
			),
		).rejects.toBeInstanceOf(LlmAbortedError);
		const aborted = (await rows()).slice(before);
		expect(aborted.map((r) => r.httpStatus)).toEqual([499]);
	});

	it("计量字段损坏：parseError=true、成本为空，回复照常", async () => {
		const before = (await rows()).length;
		const broken = sse([
			{ choices: [{ delta: { content: "好" } }] },
			{ choices: [], usage: { prompt_tokens: "很多", completion_tokens: 1 } },
		]);
		const { impl } = fakeFetch([() => new Response(broken, { status: 200 })]);
		const res = await createDeepSeekClient({
			apiKey: "k",
			fetch: impl,
		}).complete(request());
		expect(res.text).toBe("好");
		expect((await rows()).slice(before)[0]).toMatchObject({
			parseError: true,
			costMicroUsd: null,
		});
	});

	it("写账失败只记日志，不影响回复", async () => {
		const { impl } = fakeFetch([
			() => new Response(OK_STREAM, { status: 200 }),
		]);
		const res = await createDeepSeekClient({
			apiKey: "k",
			fetch: impl,
			record: async () => {
				throw new Error("db down");
			},
		}).complete(request());
		expect(res.text).toBe("你好，我是分身。");
	});

	it("响应里出现推理内容时如实标出", async () => {
		const { impl } = fakeFetch([
			() =>
				new Response(
					sse([
						{ choices: [{ delta: { reasoning_content: "想一想" } }] },
						{ choices: [{ delta: { content: "好" } }] },
					]),
					{ status: 200 },
				),
		]);
		const res = await createDeepSeekClient({
			apiKey: "k",
			fetch: impl,
		}).complete(request());
		expect(res.reasoning).toBe(true);
	});
});
