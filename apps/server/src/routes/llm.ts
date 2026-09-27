/**
 * 网关的外部入口：`/llm/v1/chat/completions`、`/llm/v1/responses`、`/llm/v1/messages`、`/llm/v1/models`。
 *
 * 只接受任务令牌（`Authorization: Bearer` 或 `x-api-key`），不接受登录会话：令牌说明调用方是哪位外部助手、
 * 为谁、在哪个话题的外部会话里；这一次调用记在该会话当前这一轮的运行、与请求发生时话题当前的任务名下。
 * 错误体按入口协议的格式给出。
 */
import {
	GATEWAY_PATH,
	type GatewayProtocol,
	groupRefOf,
	modelRefOf,
} from "@orgos/protocol";
import type { Context, Hono } from "hono";
import { scoped } from "@/db/scope";
import { callGateway, gatewayError } from "@/gateway/core";
import { isRecord } from "@/gateway/ir";
import type { AppEnv } from "@/middleware/auth";
import { externalSessions } from "@/services/external-sessions";
import { verifyGatewayToken } from "@/services/gateway-tokens";
import { listGroups, listProviders } from "@/services/model-providers";

function tokenOf(headers: Headers): string | null {
	const auth = headers.get("authorization");
	const m = auth ? /^\s*Bearer\s+(.+?)\s*$/i.exec(auth) : null;
	return m?.[1] ?? headers.get("x-api-key")?.trim() ?? null;
}

const UNAUTHORIZED = "任务令牌无效或已失效";

async function authenticate(c: Context<AppEnv>) {
	const token = tokenOf(c.req.raw.headers);
	return token ? verifyGatewayToken(token) : null;
}

async function handle(c: Context<AppEnv>, protocol: GatewayProtocol) {
	const binding = await authenticate(c);
	if (!binding) return gatewayError(protocol, 401, UNAUTHORIZED);
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return gatewayError(protocol, 400, "请求体不是合法 JSON");
	}
	if (!isRecord(body))
		return gatewayError(protocol, 400, "请求体须是 JSON 对象");
	const s = scoped(binding.tenantId);
	const { runId, taskId } = await externalSessions.attributionOf(
		s,
		binding.topicId,
	);
	return callGateway({
		s,
		protocol,
		body,
		who: {
			tenantId: binding.tenantId,
			agentId: binding.agentId,
			onBehalfOfId: binding.onBehalfOfId,
			conversationId: binding.conversationId,
			runId,
			taskId,
		},
		headers: c.req.raw.headers,
		signal: c.req.raw.signal,
	});
}

export function registerLlmRoutes(app: Hono<AppEnv>): void {
	const v1 = `${GATEWAY_PATH}/v1`;
	app.post(`${v1}/chat/completions`, (c) => handle(c, "openai"));
	app.post(`${v1}/responses`, (c) => handle(c, "responses"));
	app.post(`${v1}/messages`, (c) => handle(c, "anthropic"));

	/** 本租户可用的模型（OpenAI 与 Anthropic 两种列表格式的字段都给）。 */
	app.get(`${v1}/models`, async (c) => {
		const binding = await authenticate(c);
		if (!binding) return gatewayError("openai", 401, UNAUTHORIZED);
		const s = scoped(binding.tenantId);
		const created = Math.floor(Date.now() / 1000);
		const data = [
			...(await listProviders(s)).flatMap((p) =>
				p.exposedModels.map((m) => ({
					id: modelRefOf(p.name, m),
					display_name: `${p.name} / ${m}`,
				})),
			),
			...(await listGroups(s)).map((g) => ({
				id: groupRefOf(g.id),
				display_name: `路由组：${g.name}`,
			})),
		].map((m) => ({
			...m,
			object: "model",
			type: "model",
			owned_by: "orgos",
			created,
			created_at: new Date(created * 1000).toISOString(),
		}));
		return c.json({
			object: "list",
			data,
			has_more: false,
			first_id: data[0]?.id ?? null,
			last_id: data.at(-1)?.id ?? null,
		});
	});

	app.all(`${GATEWAY_PATH}/*`, (c) =>
		gatewayError(
			c.req.path.includes("/messages") ? "anthropic" : "openai",
			404,
			`网关没有这个接口：${c.req.method} ${c.req.path}`,
		),
	);
}
