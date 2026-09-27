import {
	type AgentListResponse,
	type AgentResponse,
	CreateAgentRequestSchema,
	UpdateAgentRequestSchema,
	type UsageResponse,
} from "@orgos/protocol";
import type { Hono } from "hono";
import { badRequest } from "@/lib/errors";
import { parseJson } from "@/lib/http";
import { type AppEnv, requireAuth, requireMember } from "@/middleware/auth";
import {
	createSpecialist,
	listAgentsOf,
	requireOwnAgent,
	retireAgent,
	updateAgentProfile,
} from "@/services/agents";
import { usageByAgent } from "@/services/llm-requests";
import { requireOwnRunner } from "@/services/runners";

/**
 * 我的代理组与用量。只能管理自己的代理：别人的 403，跨租户或不存在 404。
 * 助手只能绑定本人未吊销的设备（别人的、不存在的 404）。
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
		const body: AgentResponse = {
			agent: await createSpecialist(c.get("scope"), c.get("principal"), req),
		};
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
		if (req.runnerId)
			await requireOwnRunner(s, c.get("principal"), req.runnerId);
		const body: AgentResponse = {
			agent: await updateAgentProfile(s, agent.principal.id, req),
		};
		return c.json(body);
	});

	app.delete("/api/agents/:id", async (c) => {
		await retireAgent(c.get("scope"), c.get("principal"), c.req.param("id"));
		return c.body(null, 204);
	});

	app.get("/api/usage", async (c) => {
		const body: UsageResponse = {
			byAgent: await usageByAgent(c.get("scope"), c.get("principal").id),
		};
		return c.json(body);
	});
}
