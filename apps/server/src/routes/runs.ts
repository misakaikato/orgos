import {
	type RunListResponse,
	type RunResponse,
	RunsQuerySchema,
} from "@orgos/protocol";
import type { Hono } from "hono";
import { parseQuery } from "@/lib/http";
import { type AppEnv, requireAuth, requireMember } from "@/middleware/auth";
import { listRuns, requireVisibleRun, runUsage } from "@/services/runs";
import { listRunLogs } from "@/services/tasks";
import { requireTopic } from "@/services/topics";

/**
 * 运行记录：我的代理的全部运行，或我所在会话里某个话题的运行；单次运行带过程记录与用量。
 * 别人的代理 403；看不到的话题与运行 404。
 */
export function registerRunRoutes(app: Hono<AppEnv>): void {
	app.use("/api/runs", requireAuth, requireMember);
	app.use("/api/runs/*", requireAuth, requireMember);

	app.get("/api/runs", async (c) => {
		const query = parseQuery(c, RunsQuerySchema);
		const s = c.get("scope");
		const me = c.get("principal");
		const body: RunListResponse = {
			items: await listRuns(s, me, query, async (topicId) => {
				await requireTopic(s, me, topicId);
			}),
		};
		return c.json(body);
	});

	app.get("/api/runs/:id", async (c) => {
		const s = c.get("scope");
		const run = await requireVisibleRun(
			s,
			c.get("principal"),
			c.req.param("id"),
		);
		const body: RunResponse = {
			run,
			logs: await listRunLogs(s, run.id),
			usage: await runUsage(s, run.id),
		};
		return c.json(body);
	});
}
