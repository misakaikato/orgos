/**
 * 模拟台接口，仅 ORGOS_DEV=1 时存在；否则与未知路由一样返回 404。
 */
import {
	DEFAULT_AGENT_MODEL,
	type DemoPeopleResponse,
	type DevInfoResponse,
	DevSessionRequestSchema,
	type DevSessionResponse,
	type ResetDemoResponse,
} from "@orgos/protocol";
import type { Hono, MiddlewareHandler } from "hono";
import { demoPeople, resetDemo, signInDemo } from "@/demo/seed";
import { isDevMode, modelMode } from "@/env";
import { notFound } from "@/lib/errors";
import { parseJson } from "@/lib/http";
import type { AppEnv } from "@/middleware/auth";

/** ORGOS_DEV 未开启时一律 404（每次请求时判断）。 */
export const requireDevMode: MiddlewareHandler<AppEnv> = async (_c, next) => {
	if (!isDevMode()) throw notFound();
	await next();
};

export function registerDevRoutes(app: Hono<AppEnv>): void {
	app.use("/api/dev/*", requireDevMode);
	app.use("/sim", requireDevMode);
	app.use("/sim/*", requireDevMode);

	app.get("/api/dev/info", (c) => {
		const mode = modelMode();
		const body: DevInfoResponse = {
			modelMode: mode,
			model: mode === "real" ? DEFAULT_AGENT_MODEL : "mock",
		};
		return c.json(body);
	});

	app.get("/api/dev/people", (c) => {
		const body: DemoPeopleResponse = { people: demoPeople() };
		return c.json(body);
	});

	app.post("/api/dev/sessions", async (c) => {
		const { handle } = await parseJson(c, DevSessionRequestSchema);
		const body: DevSessionResponse = await signInDemo(handle);
		return c.json(body, 201);
	});

	app.post("/api/dev/reset-demo", async (c) => {
		const body: ResetDemoResponse = { counts: await resetDemo() };
		return c.json(body);
	});
}
