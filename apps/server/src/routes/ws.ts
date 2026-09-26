import type { Hono } from "hono";
import { upgradeWs } from "@/lib/ws-upgrade";
import type { AppEnv } from "@/middleware/auth";
import { browserWsEvents } from "@/realtime/browser-ws";

export function registerWsRoutes(app: Hono<AppEnv>): void {
	app.get("/ws", async (c) => upgradeWs(c, await browserWsEvents(c.req.raw)));
}
