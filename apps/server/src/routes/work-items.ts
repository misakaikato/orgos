import {
	ResolveWorkItemRequestSchema,
	type WorkItemListResponse,
	type WorkItemResponse,
	WorkItemsQuerySchema,
} from "@orgos/protocol";
import type { Hono } from "hono";
import { scheduler } from "@/agent/scheduler";
import { parseJson, parseQuery } from "@/lib/http";
import { type AppEnv, requireAuth, requireMember } from "@/middleware/auth";
import { listWorkItems, resolveWorkItem } from "@/services/work-items";

export function registerWorkItemRoutes(app: Hono<AppEnv>): void {
	app.use("/api/work-items", requireAuth, requireMember);
	app.use("/api/work-items/*", requireAuth, requireMember);

	app.get("/api/work-items", async (c) => {
		const { status } = parseQuery(c, WorkItemsQuerySchema);
		const body: WorkItemListResponse = {
			items: await listWorkItems(c.get("scope"), c.get("principal").id, status),
		};
		return c.json(body);
	});

	app.post("/api/work-items/:id/resolve", async (c) => {
		const req = await parseJson(c, ResolveWorkItemRequestSchema);
		const s = c.get("scope");
		const workItem = await resolveWorkItem(
			s,
			c.get("principal"),
			c.req.param("id"),
			req,
		);
		if (workItem.kind === "decision")
			await scheduler.onEscalationResolved(s, workItem);
		const body: WorkItemResponse = { workItem };
		return c.json(body);
	});
}
