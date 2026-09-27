/**
 * 集成：代理引擎的模型客户端经网关调用（上游是假的 DeepSeek，OpenAI 协议）——请求体、流式解析、
 * 重试、中止与 llm_requests 记账（计量在网关，每次上游尝试一行）。
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGatewayClient } from "@/agent/llm";
import {
	LlmAbortedError,
	type LlmRequest,
	LlmUnavailableError,
} from "@/agent/llm-types";
import { llmRequests } from "@/db/schema";
import { scoped } from "@/db/scope";
import { createProvider } from "@/services/model-providers";
import {
	FAKE_TEXT,
	type FakeUpstream,
	sse,
	startFakeUpstream,
} from "./fake-upstream";
import { createTeam, type TeamMember } from "./helpers";

const KEY = "sk-fake-deepseek-0123456789";
const PATH = "/openai/chat/completions";

let upstream: FakeUpstream;
let alice: TeamMember;
let agentId: string;

beforeAll(async () => {
	upstream = await startFakeUpstream({ openai: KEY, anthropic: "unused-key" });
	[alice] = (await createTeam(["Alice"])) as [TeamMember];
	agentId = alice.me.agents[0]?.principal.id ?? "";
	await createProvider(scoped(alice.me.tenant.id), {
		name: "deepseek",
		preset: "deepseek",
		endpoints: { openai: `${upstream.url}/openai` },
		apiKey: KEY,
		exposedModels: ["deepseek-v4-flash"],
	});
});

afterAll(async () => {
	await upstream.close();
});

const client = createGatewayClient({ retryDelaysMs: [1, 1] });

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
			taskId: null,
			model: "deepseek/deepseek-v4-flash",
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
	const all = await scoped(alice.me.tenant.id).select(
		llmRequests,
		eq(llmRequests.agentId, agentId),
	);
	return all.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

async function newRows<T>(fn: () => Promise<T>) {
	const before = (await rows()).length;
	const out = await fn().catch((e: unknown) => e);
	return { out, rows: (await rows()).slice(before) };
}

const TOOL_SPEC = {
	type: "function" as const,
	function: {
		name: "lookup",
		description: "查资料",
		parameters: { type: "object", properties: { q: { type: "string" } } },
	},
};

describe("代理引擎经网关调用模型", () => {
	it("请求体关思考、带 include_usage 与 max_tokens，换成上游模型 id；流式拼文本；记一行账含成本", async () => {
		const deltas: string[] = [];
		const { out, rows: added } = await newRows(() =>
			client.complete(request({ onDelta: (d) => deltas.push(d) })),
		);
		expect(out).toMatchObject({ text: FAKE_TEXT.join(""), toolCalls: [] });
		expect(deltas).toEqual([...FAKE_TEXT]);
		const sent = upstream.requests.at(-1);
		expect(sent?.headers.authorization).toBe(`Bearer ${KEY}`);
		expect(sent?.body).toMatchObject({
			model: "deepseek-v4-flash",
			stream: true,
			stream_options: { include_usage: true },
			max_tokens: 4000,
			thinking: { type: "disabled" },
		});
		expect(added).toHaveLength(1);
		expect(added[0]).toMatchObject({
			provider: "deepseek",
			model: "deepseek-v4-flash",
			protocolIn: "openai",
			protocolOut: "openai",
			httpStatus: 200,
			inputTokens: 80,
			outputTokens: 7,
			cacheReadTokens: 20,
			// round(80×0.139 + 7×0.278 + 20×0.0028)
			costMicroUsd: 13,
			parseError: false,
		});
	});

	it("工具调用分片拼接成完整参数", async () => {
		const res = await client.complete(
			request({
				messages: [{ role: "user", content: "请用工具查一下" }],
				tools: [TOOL_SPEC],
			}),
		);
		expect(res.toolCalls).toEqual([
			{ id: "call_fake", name: "lookup", arguments: '{"q":"预算"}' },
		]);
	});

	it("5xx 与 429 重试后成功：每次上游尝试各记一行", async () => {
		upstream.script(PATH, { status: 500 }, { status: 429 });
		const { out, rows: added } = await newRows(() =>
			client.complete(request()),
		);
		expect(out).toMatchObject({ text: FAKE_TEXT.join("") });
		expect(added.map((r) => r.httpStatus)).toEqual([500, 429, 200]);
	});

	it("重试 2 次仍失败 → LlmUnavailableError，三行失败记录", async () => {
		upstream.script(PATH, { status: 503 }, { status: 503 }, { status: 503 });
		const { out, rows: added } = await newRows(() =>
			client.complete(request()),
		);
		expect(out).toBeInstanceOf(LlmUnavailableError);
		expect(added.map((r) => r.httpStatus)).toEqual([503, 503, 503]);
	});

	it("4xx（非 429）不重试", async () => {
		upstream.script(PATH, { status: 400, body: '{"error":{"message":"bad"}}' });
		const { out, rows: added } = await newRows(() =>
			client.complete(request()),
		);
		expect(out).toBeInstanceOf(LlmUnavailableError);
		expect(added.map((r) => r.httpStatus)).toEqual([400]);
	});

	it("中止：抛 LlmAbortedError，记一行 499", async () => {
		upstream.script(PATH, { delayMs: 2_000 });
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 50);
		const { out, rows: added } = await newRows(() =>
			client.complete(request({ signal: controller.signal })),
		);
		expect(out).toBeInstanceOf(LlmAbortedError);
		expect(added.map((r) => r.httpStatus)).toEqual([499]);
	});

	it("计量字段损坏：parseError=true、成本为空，回复照常", async () => {
		upstream.script(PATH, {
			contentType: "text/event-stream",
			body: sse([
				{ choices: [{ delta: { content: "好" } }] },
				{ choices: [], usage: { prompt_tokens: "很多", completion_tokens: 1 } },
				"[DONE]",
			]),
		});
		const { out, rows: added } = await newRows(() =>
			client.complete(request()),
		);
		expect(out).toMatchObject({ text: "好" });
		expect(added[0]).toMatchObject({ parseError: true, costMicroUsd: null });
	});

	it("响应里出现推理内容时如实标出", async () => {
		upstream.script(PATH, {
			contentType: "text/event-stream",
			body: sse([
				{ choices: [{ delta: { reasoning_content: "想一想" } }] },
				{ choices: [{ delta: { content: "答" }, finish_reason: "stop" }] },
				"[DONE]",
			]),
		});
		const res = await client.complete(request());
		expect(res).toMatchObject({ text: "答", reasoning: true });
	});

	it("模型未在本组织开放：不出网，LlmUnavailableError(400)", async () => {
		const before = upstream.requests.length;
		const out = await client
			.complete(
				request({
					meta: { ...request().meta, model: "deepseek/deepseek-v4-pro" },
				}),
			)
			.catch((e: unknown) => e);
		expect(out).toBeInstanceOf(LlmUnavailableError);
		expect((out as LlmUnavailableError).httpStatus).toBe(400);
		expect(upstream.requests.length).toBe(before);
	});
});
