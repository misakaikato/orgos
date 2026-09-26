import type { DirectoryResponse, MeResponse } from "@orgos/protocol";
import type { Hono } from "hono";
import { toPrincipal, toTenant } from "@/lib/serialize";
import { type AppEnv, requireAuth, requireMember } from "@/middleware/auth";
import { listAgentsOf, listDirectory } from "@/services/agents";

export function registerMeRoutes(app: Hono<AppEnv>): void {
	app.get("/api/me", requireAuth, requireMember, async (c) => {
		const s = c.get("scope");
		const principal = c.get("principal");
		const body: MeResponse = {
			user: c.get("user"),
			tenant: toTenant(c.get("tenant"), c.get("member").role === "owner"),
			principal: toPrincipal(principal),
			agents: await listAgentsOf(s, principal.id),
		};
		return c.json(body);
	});

	app.get("/api/directory", requireAuth, requireMember, async (c) => {
		const body: DirectoryResponse = {
			people: await listDirectory(c.get("scope")),
		};
		return c.json(body);
	});
}
