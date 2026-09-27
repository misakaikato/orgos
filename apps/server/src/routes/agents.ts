import {
	type AgentListResponse,
	type AgentResponse,
	CreateAgentRequestSchema,
	isExternalAgent,
	UpdateAgentRequestSchema,
	type UsageResponse,
} from "@orgos/protocol";
import type { Hono } from "hono";
import { isDevMode } from "@/env";
import { badRequest } from "@/lib/errors";
import { parseJson } from "@/lib/http";
import { type AppEnv, requireAuth, requireMember } from "@/middleware/auth";
import {
	createExternalAgent,
	createSpecialist,
	listAgentsOf,
	requireOwnAgent,
	retireAgent,
	updateAgentProfile,
} from "@/services/agents";
import { openDm } from "@/services/conversations";
import { externalSessions } from "@/services/external-sessions";
import { usageByAgent } from "@/services/llm-requests";
import { requireOwnRunner, toRunner } from "@/services/runners";
import { openTasksOfAssignee } from "@/services/tasks";
import { getTenantSettings } from "@/services/tenant-settings";

/**
 * 我的代理组与用量。只能管理自己的代理：别人的 403，跨租户或不存在 404。
 * 助手只能绑定本人未吊销的设备（别人的、不存在的 404）。
 * 外部助手（kind=external）同样只能用本人未吊销的设备，适配器须是该设备上报可用的；
 * 不经审批、不限工作目录的适配器（pi、Hermes）须租户开启且本人勾选确认；
 * 建好后随即建立本人与它的私聊，使它出现在会话列表里。
 */
export function registerAgentRoutes(app: Hono<AppEnv>): void {
	app.use("/api/agents", requireAuth, requireMember);
	app.use("/api/agents/*", requireAuth, requireMember);
	app.use("/api/usage", requireAuth, requireMember);

	app.get("/api/agents", async (c) => {
		const body: AgentListResponse = {
			items: await listAgentsOf(c.get("scope"), c.get("principal").id),
		};
		return c.json(body);
	});

	app.post("/api/agents", async (c) => {
		const req = await parseJson(c, CreateAgentRequestSchema);
		const s = c.get("scope");
		const me = c.get("principal");
		if (req.kind !== "external") {
			const body: AgentResponse = {
				agent: await createSpecialist(s, me, req),
			};
			return c.json(body, 201);
		}
		const runner = await requireOwnRunner(s, me, req.runnerId);
		const agent = await createExternalAgent(s, me, runner, req, {
			devMode: isDevMode(),
			capabilities: toRunner(runner).capabilities,
			settings: await getTenantSettings(s),
		});
		await openDm(s, me, agent.principal.id);
		const body: AgentResponse = { agent };
		return c.json(body, 201);
	});

	app.patch("/api/agents/:id", async (c) => {
		const req = await parseJson(c, UpdateAgentRequestSchema);
		const s = c.get("scope");
		const agent = await requireOwnAgent(
			s,
			c.get("principal"),
			c.req.param("id"),
		);
		if (req.delegationPolicy !== undefined && agent.role !== "front") {
			throw badRequest("只有分身有对外政策");
		}
		if (req.runnerId !== undefined && agent.role === "front") {
			throw badRequest("分身不操作设备，请把设备绑给助手");
		}
		if (req.runnerId !== undefined && isExternalAgent(agent)) {
			throw badRequest("外部助手的设备在接入时确定，不能改绑");
		}
		if (req.runnerId)
			await requireOwnRunner(s, c.get("principal"), req.runnerId);
		const body: AgentResponse = {
			agent: await updateAgentProfile(s, agent.principal.id, req),
		};
		return c.json(body);
	});

	app.delete("/api/agents/:id", async (c) => {
		const s = c.get("scope");
		const me = c.get("principal");
		const agent = await requireOwnAgent(s, me, c.req.param("id"));
		await retireAgent(s, me, agent.principal.id);
		if (isExternalAgent(agent))
			await externalSessions.onAgentRetired(
				s,
				agent.principal.id,
				await openTasksOfAssignee(s, agent.principal.id),
			);
		return c.body(null, 204);
	});

	app.get("/api/usage", async (c) => {
		const body: UsageResponse = {
			byAgent: await usageByAgent(c.get("scope"), c.get("principal").id),
		};
		return c.json(body);
	});
}
