import {
	type CreatePairingCodeResponse,
	ERROR_CODES,
	PairRunnerRequestSchema,
	type PairRunnerResponse,
	type RunnerListResponse,
} from "@orgos/protocol";
import type { Hono } from "hono";
import { errorBody } from "@/lib/errors";
import { parseJson } from "@/lib/http";
import { upgradeWs } from "@/lib/ws-upgrade";
import { type AppEnv, requireAuth, requireMember } from "@/middleware/auth";
import { authenticateRunner, runnerWsEvents } from "@/realtime/runner-ws";
import { externalTasks } from "@/services/external-tasks";
import {
	createPairingCode,
	listRunners,
	pairRunner,
	revokeRunner,
} from "@/services/runners";

/**
 * 设备：配对码、配对（凭码，无需登录）、我的设备、吊销，以及 Runner 的 WS 入口。
 * 别人的设备与跨租户一律 404。
 */
export function registerRunnerRoutes(app: Hono<AppEnv>): void {
	app.post("/api/runners/pair", async (c) => {
		const req = await parseJson(c, PairRunnerRequestSchema);
		const body: PairRunnerResponse = await pairRunner(req);
		return c.json(body, 201);
	});

	// 配对路由注册在鉴权中间件之前：它先匹配并直接返回，不经过下面的登录检查。
	app.use("/api/runners", requireAuth, requireMember);
	app.use("/api/runners/*", requireAuth, requireMember);

	app.post("/api/runners/pairing-codes", async (c) => {
		const body: CreatePairingCodeResponse = await createPairingCode(
			c.get("scope"),
			c.get("principal").id,
		);
		return c.json(body, 201);
	});

	app.get("/api/runners", async (c) => {
		const body: RunnerListResponse = {
			items: await listRunners(c.get("scope"), c.get("principal").id),
		};
		return c.json(body);
	});

	app.delete("/api/runners/:id", async (c) => {
		const s = c.get("scope");
		const runnerId = c.req.param("id");
		await revokeRunner(s, c.get("principal"), runnerId);
		await externalTasks.onRunnerRevoked(s, runnerId);
		return c.body(null, 204);
	});

	app.get("/runner/ws", async (c) => {
		const runner = await authenticateRunner(c.req.query("token"));
		if (!runner)
			return c.json(
				errorBody(ERROR_CODES.UNAUTHORIZED, "设备凭据无效或已吊销"),
				401,
			);
		return upgradeWs(c, runnerWsEvents(runner));
	});
}
