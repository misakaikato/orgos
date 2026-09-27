import {
	type DirectoryResponse,
	type MeResponse,
	UpdateStatusRequestSchema,
	type UpdateStatusResponse,
} from "@orgos/protocol";
import type { Hono } from "hono";
import { parseJson } from "@/lib/http";
import { toPrincipal, toTenant } from "@/lib/serialize";
import { type AppEnv, requireAuth, requireMember } from "@/middleware/auth";
import { listAgentsOf, listDirectory } from "@/services/agents";
import { setStatus } from "@/services/presence";

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

	app.patch("/api/me/status", requireAuth, requireMember, async (c) => {
		const { status } = await parseJson(c, UpdateStatusRequestSchema);
		const body: UpdateStatusResponse = {
			principal: await setStatus(c.get("scope"), c.get("principal"), status),
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
