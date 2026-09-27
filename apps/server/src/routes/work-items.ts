import {
	type WorkItemListResponse,
	WorkItemsQuerySchema,
} from "@orgos/protocol";
import type { Hono } from "hono";
import { parseQuery } from "@/lib/http";
import { type AppEnv, requireAuth, requireMember } from "@/middleware/auth";
import { listWorkItems } from "@/services/work-items";

export function registerWorkItemRoutes(app: Hono<AppEnv>): void {
	app.get("/api/work-items", requireAuth, requireMember, async (c) => {
		const { status } = parseQuery(c, WorkItemsQuerySchema);
		const body: WorkItemListResponse = {
			items: await listWorkItems(c.get("scope"), c.get("principal").id, status),
		};
		return c.json(body);
	});
}
