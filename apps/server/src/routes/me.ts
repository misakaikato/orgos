import type { DirectoryResponse, MeResponse } from "@orgos/protocol";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { principals } from "@/db/schema";
import { notFound } from "@/lib/errors";
import { toPrincipal, toTenant } from "@/lib/serialize";
import { type AppEnv, requireAuth, requireMember } from "@/middleware/auth";
import { listAgentsOf, listDirectory } from "@/services/agents";

export function registerMeRoutes(app: Hono<AppEnv>): void {
	app.get("/api/me", requireAuth, requireMember, async (c) => {
		const s = c.get("scope");
		const user = c.get("user");
		const principal = await s.first(
			principals,
			eq(principals.userId, user.id),
			eq(principals.kind, "human"),
		);
		if (!principal) throw notFound("找不到本人主体");
		const body: MeResponse = {
			user,
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
