/**
 * 集成：企业模型网关。假上游同时说 OpenAI 与 Anthropic（含流式与工具调用）。
 *
 * - 三种入口 × 两种上游：直通与翻译的文本、流式增量、工具调用名与参数、用量都对；
 * - 多轮工具调用的消息在两种协议之间互转；
 * - 路由组 order 在上游 500 时切下一个、rotate 轮换，每次尝试各一行账；
 * - 任务令牌：错误令牌 401；任务结束后令牌仍有效、调用随话题当前的任务记账；会话关闭（吊销）后 401；
 * - 厂商 key 不出现在任何接口响应与日志里；
 * - 代理引擎经网关调用，一次调用一行账且带 runId；
 * - 模型页接口只给租户 owner，代理只能选开放的模型。
 */
import {
	CreatePairingCodeResponseSchema,
	type Event,
	EventsResponseSchema,
	ModelAdminResponseSchema,
	ModelOptionsResponseSchema,
	ModelProviderResponseSchema,
	PairRunnerResponseSchema,
	ProviderModelsResponseSchema,
	ProviderTestResponseSchema,
	TaskResponseSchema,
	TopicListResponseSchema,
} from "@orgos/protocol";
import { and, eq } from "drizzle-orm";
import {
	afterAll,
	beforeAll,
	describe,
	expect,
	it,
	type MockInstance,
	vi,
} from "vitest";
import { llmRequests, modelProviders, runs } from "@/db/schema";
import { scoped } from "@/db/scope";
import { app } from "@/index";
import {
	issueGatewayToken,
	revokeTopicTokens,
} from "@/services/gateway-tokens";
import {
	ANTHROPIC_USAGE,
	FAKE_TEXT,
	FAKE_TOOL,
	type FakeUpstream,
	startFakeUpstream,
} from "./fake-upstream";
import { anonymous, createTeam, type TeamMember } from "./helpers";

const KEY_OA = "sk-fake-openai-7f3a9c2e1d";
const KEY_AN = "sk-fake-anthropic-5b8e4f6a0c";
const KEY_LEAKY = "sk-leaky-should-never-surface-91c4";
const TOOL_ARGS = JSON.parse(FAKE_TOOL.args.join("")) as unknown;

let upstream: FakeUpstream;
let alice: TeamMember;
let bob: TeamMember;
let opsId: string;
let dm: string;
let mainTopic: string;
let runnerId: string;
let token: string;
const logs: string[] = [];
const spies: MockInstance[] = [];

type Protocol = "openai" | "anthropic" | "responses";
const PATHS: Record<Protocol, string> = {
	openai: "/llm/v1/chat/completions",
	anthropic: "/llm/v1/messages",
	responses: "/llm/v1/responses",
};

function gw(
	protocol: Protocol,
	body: unknown,
	auth: Record<string, string> = { authorization: `Bearer ${token}` },
) {
	return app.request(PATHS[protocol], {
		method: "POST",
		headers: { "content-type": "application/json", ...auth },
		body: JSON.stringify(body),
	});
}

const SCHEMA = { type: "object", properties: { q: { type: "string" } } };

function requestBody(
	protocol: Protocol,
	model: string,
	opts: { stream: boolean; tool: boolean },
): Record<string, unknown> {
	const text = opts.tool ? "请用工具查一下" : "打个招呼";
	if (protocol === "openai")
		return {
			model,
			messages: [
				{ role: "system", content: "你是测试助手" },
				{ role: "user", content: text },
			],
			...(opts.tool
				? {
						tools: [
							{
								type: "function",
								function: {
									name: "lookup",
									description: "查",
									parameters: SCHEMA,
								},
							},
						],
					}
				: {}),
			stream: opts.stream,
			...(opts.stream ? { stream_options: { include_usage: true } } : {}),
		};
	if (protocol === "anthropic")
		return {
			model,
			max_tokens: 256,
			system: "你是测试助手",
			messages: [{ role: "user", content: text }],
			...(opts.tool
				? {
						tools: [
							{ name: "lookup", description: "查", input_schema: SCHEMA },
						],
					}
				: {}),
			stream: opts.stream,
		};
	return {
		model,
		instructions: "你是测试助手",
		input: text,
		...(opts.tool
			? {
					tools: [
						{
							type: "function",
							name: "lookup",
							description: "查",
							parameters: SCHEMA,
						},
					],
				}
			: {}),
		stream: opts.stream,
	};
}

type Reply = {
	deltas: string[];
	text: string;
	tool: { name: string; args: string } | null;
	input: number;
	output: number;
	stop: string;
};

function sseData(raw: string): Record<string, unknown>[] {
	return raw
		.split("\n\n")
		.flatMap((block) =>
			block
				.split("\n")
				.filter((l) => l.startsWith("data: "))
				.map((l) => l.slice(6)),
		)
		.filter((d) => d && d !== "[DONE]")
		.map((d) => JSON.parse(d) as Record<string, unknown>);
}

/** 按入口协议读出文字、工具调用与用量（非流式读响应体，流式读事件）。 */
function readReply(protocol: Protocol, raw: string, stream: boolean): Reply {
	const r: Reply = {
		deltas: [],
		text: "",
		tool: null,
		input: -1,
		output: -1,
		stop: "",
	};
	// biome-ignore lint/suspicious/noExplicitAny: 测试里按三种协议的已知形状取字段。
	const any = (v: unknown) => v as any;
	if (!stream) {
		const b = any(JSON.parse(raw));
		if (protocol === "openai") {
			const m = b.choices[0].message;
			r.text = m.content ?? "";
			const tc = m.tool_calls?.[0];
			if (tc) r.tool = { name: tc.function.name, args: tc.function.arguments };
			r.input = b.usage.prompt_tokens;
			r.output = b.usage.completion_tokens;
			r.stop = b.choices[0].finish_reason;
		} else if (protocol === "anthropic") {
			for (const c of b.content) {
				if (c.type === "text") r.text += c.text;
				if (c.type === "tool_use")
					r.tool = { name: c.name, args: JSON.stringify(c.input) };
			}
			r.input = b.usage.input_tokens;
			r.output = b.usage.output_tokens;
			r.stop = b.stop_reason;
		} else {
			for (const it of b.output) {
				if (it.type === "message") for (const c of it.content) r.text += c.text;
				if (it.type === "function_call")
					r.tool = { name: it.name, args: it.arguments };
			}
			r.input = b.usage.input_tokens;
			r.output = b.usage.output_tokens;
			r.stop = b.status;
		}
		return r;
	}
	let args = "";
	for (const e of sseData(raw).map(any)) {
		if (protocol === "openai") {
			if (e.usage) {
				r.input = e.usage.prompt_tokens;
				r.output = e.usage.completion_tokens;
			}
			const ch = e.choices?.[0];
			if (!ch) continue;
			if (ch.delta?.content) r.deltas.push(ch.delta.content);
			for (const tc of ch.delta?.tool_calls ?? []) {
				if (tc.function?.name) r.tool = { name: tc.function.name, args: "" };
				if (tc.function?.arguments) args += tc.function.arguments;
			}
			if (ch.finish_reason) r.stop = ch.finish_reason;
		} else if (protocol === "anthropic") {
			if (
				e.type === "content_block_start" &&
				e.content_block.type === "tool_use"
			)
				r.tool = { name: e.content_block.name, args: "" };
			if (e.type === "content_block_delta" && e.delta.type === "text_delta")
				r.deltas.push(e.delta.text);
			if (
				e.type === "content_block_delta" &&
				e.delta.type === "input_json_delta"
			)
				args += e.delta.partial_json;
			if (e.type === "message_start") r.input = e.message.usage.input_tokens;
			if (e.type === "message_delta") {
				r.stop = e.delta.stop_reason;
				r.output = e.usage.output_tokens;
				if (e.usage.input_tokens) r.input = e.usage.input_tokens;
			}
		} else {
			if (e.type === "response.output_text.delta") r.deltas.push(e.delta);
			if (
				e.type === "response.output_item.added" &&
				e.item.type === "function_call"
			)
				r.tool = { name: e.item.name, args: "" };
			if (e.type === "response.function_call_arguments.delta") args += e.delta;
			if (e.type === "response.completed") {
				r.input = e.response.usage.input_tokens;
				r.output = e.response.usage.output_tokens;
				r.stop = e.response.status;
			}
		}
	}
	r.text = r.deltas.join("");
	if (r.tool) r.tool.args = args;
	return r;
}

/** 用量换算成入口协议的口径：OpenAI 与 Responses 的输入含缓存命中，Anthropic 不含。 */
function expectedInput(protocol: Protocol): number {
	const nonCached = ANTHROPIC_USAGE.input_tokens;
	const cached = ANTHROPIC_USAGE.cache_read_input_tokens;
	return protocol === "anthropic" ? nonCached : nonCached + cached;
}

async function tenantRows() {
	const all = await scoped(alice.me.tenant.id).select(llmRequests);
	return all.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

async function rowsDuring(fn: () => Promise<unknown>) {
	const before = new Set((await tenantRows()).map((r) => r.id));
	await fn();
	// 直通的账在流读完时写入：给它一拍。
	await new Promise((r) => setTimeout(r, 20));
	return (await tenantRows()).filter((r) => !before.has(r.id));
}

async function until<T>(
	what: string,
	fn: () => Promise<T | null | undefined | false>,
	timeoutMs = 10_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

async function addProvider(body: Record<string, unknown>) {
	const res = await alice.client.request("POST", "/api/model-providers", body);
	expect(res.status).toBe(201);
	const text = await res.text();
	logs.push(text);
	return ModelProviderResponseSchema.parse(JSON.parse(text)).provider;
}

beforeAll(async () => {
	for (const method of ["log", "info", "warn", "error", "debug"] as const)
		spies.push(
			vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
				logs.push(
					args
						.map((a) =>
							a instanceof Error
								? `${a.message}${a.stack}`
								: typeof a === "string"
									? a
									: JSON.stringify(a),
						)
						.join(" "),
				);
			}),
		);
	upstream = await startFakeUpstream({ openai: KEY_OA, anthropic: KEY_AN });
	[alice, bob] = (await createTeam(["Alice", "Bob"])) as [
		TeamMember,
		TeamMember,
	];
	opsId =
		alice.me.agents.find((a) => a.role === "specialist")?.principal.id ?? "";
	await addProvider({
		name: "oa",
		endpoints: { openai: `${upstream.url}/openai` },
		apiKey: KEY_OA,
		exposedModels: ["m-large"],
	});
	await addProvider({
		name: "an",
		endpoints: { anthropic: `${upstream.url}/anthropic` },
		apiKey: KEY_AN,
		exposedModels: ["m-large"],
	});
	await addProvider({
		name: "flaky",
		endpoints: { openai: `${upstream.url}/flaky` },
		apiKey: KEY_OA,
		exposedModels: ["m-large"],
	});
	await addProvider({
		name: "leaky",
		endpoints: { openai: `${upstream.url}/openai` },
		apiKey: KEY_LEAKY,
		exposedModels: ["m-large"],
	});
	const code = CreatePairingCodeResponseSchema.parse(
		await (
			await alice.client.request("POST", "/api/runners/pairing-codes")
		).json(),
	).code;
	runnerId = PairRunnerResponseSchema.parse(
		await (
			await anonymous.request("POST", "/api/runners/pair", {
				code,
				name: "测试机",
				os: "macOS",
			})
		).json(),
	).runnerId;
	const conv = (await (
		await alice.client.request("POST", "/api/conversations", {
			kind: "dm",
			withPrincipalId: opsId,
		})
	).json()) as { conversation: { id: string } };
	dm = conv.conversation.id;
	const topics = TopicListResponseSchema.parse(
		await (
			await alice.client.request("GET", `/api/conversations/${dm}/topics`)
		).json(),
	);
	mainTopic = topics.items.find((t) => t.isMain)?.id ?? "";
	token = await issueGatewayToken(scoped(alice.me.tenant.id), {
		agentId: opsId,
		onBehalfOfId: alice.me.principal.id,
		conversationId: dm,
		topicId: mainTopic,
		runnerId,
	});
}, 30_000);

afterAll(async () => {
	for (const s of spies) s.mockRestore();
	await upstream.close();
});

describe("三种入口 × 两种上游", () => {
	const cases = (["openai", "anthropic", "responses"] as const).flatMap(
		(inbound) =>
			(["oa", "an"] as const).flatMap((provider) =>
				[false, true].flatMap((stream) =>
					[false, true].map((tool) => ({ inbound, provider, stream, tool })),
				),
			),
	);

	it.each(cases)(
		"$inbound → $provider（stream=$stream，tool=$tool）",
		async ({ inbound, provider, stream, tool }) => {
			let raw = "";
			let status = 0;
			const added = await rowsDuring(async () => {
				const res = await gw(
					inbound,
					requestBody(inbound, `${provider}/m-large`, { stream, tool }),
				);
				status = res.status;
				raw = await res.text();
			});
			logs.push(raw);
			expect(status, raw).toBe(200);
			const r = readReply(inbound, raw, stream);
			if (tool) {
				expect(r.tool?.name).toBe(FAKE_TOOL.name);
				expect(JSON.parse(r.tool?.args ?? "")).toEqual(TOOL_ARGS);
				expect(r.stop).toBe(
					{
						openai: "tool_calls",
						anthropic: "tool_use",
						responses: "completed",
					}[inbound],
				);
			} else {
				expect(r.text).toBe(FAKE_TEXT.join(""));
				if (stream) expect(r.deltas).toEqual([...FAKE_TEXT]);
				expect(r.tool).toBeNull();
			}
			expect(r.input).toBe(expectedInput(inbound));
			expect(r.output).toBe(ANTHROPIC_USAGE.output_tokens);
			const upstreamProtocol = provider === "oa" ? "openai" : "anthropic";
			expect(added).toHaveLength(1);
			expect(added[0]).toMatchObject({
				provider,
				model: "m-large",
				protocolIn: inbound,
				protocolOut: upstreamProtocol,
				agentId: opsId,
				onBehalfOfId: alice.me.principal.id,
				conversationId: dm,
				httpStatus: 200,
				inputTokens: ANTHROPIC_USAGE.input_tokens,
				outputTokens: ANTHROPIC_USAGE.output_tokens,
				cacheReadTokens: ANTHROPIC_USAGE.cache_read_input_tokens,
			});
			const sent = upstream.requests.at(-1);
			expect(sent?.body.model).toBe("m-large");
			if (upstreamProtocol === "anthropic") {
				expect(sent?.headers["x-api-key"]).toBe(KEY_AN);
				if (inbound !== "anthropic") {
					expect(sent?.body.system).toBe("你是测试助手");
					expect(sent?.body.max_tokens).toBeGreaterThan(0);
					if (tool)
						expect(sent?.body.tools).toEqual([
							{ name: "lookup", description: "查", input_schema: SCHEMA },
						]);
				}
			} else if (inbound !== "openai") {
				expect(sent?.headers.authorization).toBe(`Bearer ${KEY_OA}`);
				const messages = sent?.body.messages as { role: string }[];
				expect(messages[0]).toEqual({
					role: "system",
					content: "你是测试助手",
				});
				if (tool)
					expect(sent?.body.tools).toEqual([
						{
							type: "function",
							function: {
								name: "lookup",
								description: "查",
								parameters: SCHEMA,
							},
						},
					]);
			}
		},
	);

	it("OpenAI 的多轮工具调用翻译给 Anthropic 上游：tool_use / tool_result 成对", async () => {
		const res = await gw("openai", {
			model: "an/m-large",
			messages: [
				{ role: "user", content: "查预算" },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call_1",
							type: "function",
							function: { name: "lookup", arguments: '{"q":"预算"}' },
						},
					],
				},
				{ role: "tool", tool_call_id: "call_1", content: "不含税" },
			],
			tools: [
				{ type: "function", function: { name: "lookup", parameters: SCHEMA } },
			],
		});
		expect(res.status).toBe(200);
		expect(upstream.requests.at(-1)?.body.messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "查预算" }] },
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "call_1",
						name: "lookup",
						input: { q: "预算" },
					},
				],
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "call_1", content: "不含税" },
				],
			},
		]);
	});

	it("Anthropic 的多轮工具调用翻译给 OpenAI 上游：tool_calls / tool 消息成对", async () => {
		const res = await gw("anthropic", {
			model: "oa/m-large",
			max_tokens: 100,
			messages: [
				{ role: "user", content: "查预算" },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "我查一下" },
						{
							type: "tool_use",
							id: "toolu_1",
							name: "lookup",
							input: { q: "预算" },
						},
					],
				},
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "toolu_1", content: "不含税" },
						{ type: "text", text: "然后呢" },
					],
				},
			],
			tools: [{ name: "lookup", input_schema: SCHEMA }],
		});
		expect(res.status).toBe(200);
		expect(upstream.requests.at(-1)?.body.messages).toEqual([
			{ role: "user", content: "查预算" },
			{
				role: "assistant",
				content: "我查一下",
				tool_calls: [
					{
						id: "toolu_1",
						type: "function",
						function: { name: "lookup", arguments: '{"q":"预算"}' },
					},
				],
			},
			{ role: "tool", tool_call_id: "toolu_1", content: "不含税" },
			{ role: "user", content: "然后呢" },
		]);
	});

	it("/llm/v1/models 列出本租户开放的模型", async () => {
		const res = await app.request("/llm/v1/models", {
			headers: { authorization: `Bearer ${token}` },
		});
		const body = (await res.json()) as { data: { id: string }[] };
		expect(body.data.map((m) => m.id)).toEqual(
			expect.arrayContaining(["oa/m-large", "an/m-large"]),
		);
	});

	it("未开放的模型 400，不出网", async () => {
		const before = upstream.requests.length;
		const res = await gw(
			"openai",
			requestBody("openai", "oa/m-small", { stream: false, tool: false }),
		);
		expect(res.status).toBe(400);
		expect(upstream.requests.length).toBe(before);
	});
});

describe("路由组", () => {
	async function group(members: string[], routing: "order" | "rotate") {
		const res = await alice.client.request("POST", "/api/model-groups", {
			name: `组${routing}`,
			members,
			routing,
		});
		expect(res.status).toBe(201);
		return ((await res.json()) as { group: { id: string } }).group.id;
	}

	it("order：第一个上游 500 → 切到下一个，每次尝试各一行账", async () => {
		const id = await group(["flaky/m-large", "oa/m-large"], "order");
		upstream.script("/flaky/chat/completions", { status: 500 });
		let status = 0;
		const added = await rowsDuring(async () => {
			const res = await gw(
				"openai",
				requestBody("openai", `group/${id}`, { stream: false, tool: false }),
			);
			status = res.status;
			await res.text();
		});
		expect(status).toBe(200);
		expect(added.map((r) => [r.provider, r.httpStatus, r.groupId])).toEqual([
			["flaky", 500, id],
			["oa", 200, id],
		]);
	});

	it("rotate：每次从下一个成员起", async () => {
		const id = await group(["oa/m-large", "an/m-large"], "rotate");
		const added = await rowsDuring(async () => {
			for (let i = 0; i < 4; i++)
				await (
					await gw(
						"openai",
						requestBody("openai", `group/${id}`, {
							stream: false,
							tool: false,
						}),
					)
				).text();
		});
		const providers = added.map((r) => r.provider);
		expect(providers).toHaveLength(4);
		expect(providers[0]).not.toBe(providers[1]);
		expect(providers[1]).not.toBe(providers[2]);
		expect(providers[2]).not.toBe(providers[3]);
	});
});

describe("任务令牌", () => {
	it("没有令牌或令牌不对 → 401（Bearer 与 x-api-key 都认）", async () => {
		const body = requestBody("anthropic", "an/m-large", {
			stream: false,
			tool: false,
		});
		expect((await gw("anthropic", body, {})).status).toBe(401);
		expect(
			(await gw("anthropic", body, { authorization: "Bearer ogt_nope" }))
				.status,
		).toBe(401);
		expect(
			(await gw("anthropic", body, { "x-api-key": "ogt_nope" })).status,
		).toBe(401);
		const ok = await gw("anthropic", body, { "x-api-key": token });
		expect(ok.status).toBe(200);
		// 登录会话不是网关凭据。
		const cookie = await app.request(PATHS.openai, {
			method: "POST",
			headers: { "content-type": "application/json", ...alice.client.headers },
			body: JSON.stringify(
				requestBody("openai", "oa/m-large", { stream: false, tool: false }),
			),
		});
		expect(cookie.status).toBe(401);
	});

	it("任务结束不使令牌失效；调用记在请求发生时话题当前的任务名下", async () => {
		const res = await alice.client.request("POST", "/api/tasks", {
			conversationId: dm,
			goal: "整理周报",
		});
		expect(res.status).toBe(201);
		const { task } = TaskResponseSchema.parse(await res.json());
		const topicToken = await issueGatewayToken(scoped(alice.me.tenant.id), {
			agentId: opsId,
			onBehalfOfId: alice.me.principal.id,
			conversationId: dm,
			topicId: task.topicId ?? mainTopic,
			runnerId,
		});
		const body = requestBody("openai", "oa/m-large", {
			stream: false,
			tool: false,
		});
		const auth = { authorization: `Bearer ${topicToken}` };
		const during = await rowsDuring(async () => {
			expect((await gw("openai", body, auth)).status).toBe(200);
		});
		expect(during.find((r) => r.provider === "oa")?.taskId).toBe(task.id);
		await until("任务可完成", async () => {
			const r = await alice.client.request(
				"POST",
				`/api/tasks/${task.id}/complete`,
			);
			return r.status === 200;
		});
		const after = await rowsDuring(async () => {
			expect((await gw("openai", body, auth)).status).toBe(200);
		});
		expect(after.find((r) => r.provider === "oa")?.taskId).toBeNull();
	});

	it("外部会话关闭（吊销）后 401", async () => {
		const s = scoped(alice.me.tenant.id);
		const t = await issueGatewayToken(s, {
			agentId: opsId,
			onBehalfOfId: alice.me.principal.id,
			conversationId: dm,
			topicId: mainTopic,
			runnerId,
		});
		const body = requestBody("openai", "oa/m-large", {
			stream: false,
			tool: false,
		});
		expect(
			(await gw("openai", body, { authorization: `Bearer ${t}` })).status,
		).toBe(200);
		await revokeTopicTokens(s, mainTopic);
		expect(
			(await gw("openai", body, { authorization: `Bearer ${t}` })).status,
		).toBe(401);
		token = await issueGatewayToken(s, {
			agentId: opsId,
			onBehalfOfId: alice.me.principal.id,
			conversationId: dm,
			topicId: mainTopic,
			runnerId,
		});
	});
});

describe("模型页与代理选模型", () => {
	it("只有租户 owner 能管理；成员能读可选模型", async () => {
		expect((await bob.client.request("GET", "/api/model-admin")).status).toBe(
			403,
		);
		expect(
			(
				await bob.client.request("POST", "/api/model-providers", {
					name: "x",
					endpoints: { openai: "http://x.test/v1" },
				})
			).status,
		).toBe(403);
		const res = await bob.client.request("GET", "/api/models");
		const text = await res.text();
		logs.push(text);
		const { options } = ModelOptionsResponseSchema.parse(JSON.parse(text));
		expect(options.map((o) => o.ref)).toEqual(
			expect.arrayContaining(["oa/m-large", "an/m-large"]),
		);
	});

	it("拉厂商的模型列表、测试按钮", async () => {
		const admin = ModelAdminResponseSchema.parse(
			await (await alice.client.request("GET", "/api/model-admin")).json(),
		);
		const oa = admin.providers.find((p) => p.name === "oa");
		const an = admin.providers.find((p) => p.name === "an");
		expect(oa?.hasKey).toBe(true);
		const models = ProviderModelsResponseSchema.parse(
			await (
				await alice.client.request(
					"GET",
					`/api/model-providers/${oa?.id}/models`,
				)
			).json(),
		);
		expect(models.models).toEqual(["m-large", "m-small"]);
		for (const p of [oa, an]) {
			const res = await alice.client.request(
				"POST",
				`/api/model-providers/${p?.id}/test`,
				{},
			);
			const text = await res.text();
			logs.push(text);
			const { results } = ProviderTestResponseSchema.parse(JSON.parse(text));
			expect(results).toEqual([
				expect.objectContaining({
					protocol: p === oa ? "openai" : "anthropic",
					ok: true,
					message: FAKE_TEXT.join(""),
				}),
			]);
		}
	});

	it("代理只能选开放的模型；默认模型同理", async () => {
		const bad = await alice.client.request("PATCH", `/api/agents/${opsId}`, {
			model: "oa/m-small",
		});
		expect(bad.status).toBe(400);
		expect(((await bad.json()) as { error: { code: string } }).error.code).toBe(
			"MODEL_UNAVAILABLE",
		);
		const ok = await alice.client.request("PATCH", `/api/agents/${opsId}`, {
			model: "an/m-large",
		});
		expect(ok.status).toBe(200);
		expect(
			(
				await alice.client.request("PATCH", "/api/tenant/settings", {
					defaultModel: "nope/x",
				})
			).status,
		).toBe(400);
		expect(
			(
				await alice.client.request("PATCH", "/api/tenant/settings", {
					externalAgentMode: "personal",
				})
			).status,
		).toBe(400);
		const res = await alice.client.request("PATCH", "/api/tenant/settings", {
			defaultModel: "oa/m-large",
			allowPersonalExternal: true,
			externalAgentMode: "personal",
		});
		expect(await res.json()).toMatchObject({
			settings: { defaultModel: "oa/m-large", externalAgentMode: "personal" },
		});
		const off = await alice.client.request("PATCH", "/api/tenant/settings", {
			allowPersonalExternal: false,
		});
		expect(await off.json()).toMatchObject({
			settings: { externalAgentMode: "enterprise" },
		});
	});
});

describe("代理引擎经网关", () => {
	it("MOCK_LLM 关闭时：代理的回复来自上游，这次运行一行账且带 runId", async () => {
		vi.stubEnv("MOCK_LLM", "");
		try {
			expect(
				(
					await alice.client.request("PATCH", `/api/agents/${opsId}`, {
						model: "oa/m-large",
					})
				).status,
			).toBe(200);
			const posted = await alice.client.request(
				"POST",
				`/api/conversations/${dm}/messages`,
				{
					text: "你好",
				},
			);
			expect(posted.status).toBe(201);
			const reply = await until("代理回复", async () => {
				const res = await alice.client.request(
					"GET",
					`/api/conversations/${dm}/events?limit=200`,
				);
				const { items } = EventsResponseSchema.parse(await res.json());
				return items.find(
					(e: Event) =>
						e.type === "message.posted" &&
						e.actorId === opsId &&
						e.payload.text === FAKE_TEXT.join(""),
				);
			});
			expect(reply).toBeTruthy();
			const s = scoped(alice.me.tenant.id);
			const run = await until("运行结束", async () => {
				const [r] = await s.select(
					runs,
					and(
						eq(runs.agentId, opsId),
						eq(runs.state, "completed"),
						eq(runs.topicId, mainTopic),
					),
				);
				return r;
			});
			const rows = await s.select(llmRequests, eq(llmRequests.runId, run.id));
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				provider: "oa",
				protocolIn: "openai",
				protocolOut: "openai",
				httpStatus: 200,
			});
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

describe("厂商 key 不外泄", () => {
	it("上游回显 key 的错误：返回给调用方前抹掉", async () => {
		const res = await gw(
			"openai",
			requestBody("openai", "leaky/m-large", { stream: false, tool: false }),
		);
		const text = await res.text();
		logs.push(text);
		expect(res.status).toBe(401);
		expect(text).not.toContain(KEY_LEAKY);
		expect(text).toContain("***");
	});

	it("库里只有密文；任何接口响应与日志里都没有 key", async () => {
		const stored = await scoped(alice.me.tenant.id).select(modelProviders);
		for (const p of stored) {
			expect(p.keyCiphertext).toBeTruthy();
			for (const k of [KEY_OA, KEY_AN, KEY_LEAKY])
				expect(p.keyCiphertext).not.toContain(k);
		}
		logs.push(
			await (await alice.client.request("GET", "/api/model-admin")).text(),
		);
		const all = logs.join("\n");
		expect(all.length).toBeGreaterThan(1000);
		for (const k of [KEY_OA, KEY_AN, KEY_LEAKY]) expect(all).not.toContain(k);
	});
});
