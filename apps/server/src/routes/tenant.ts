import {
	type TenantSettingsResponse,
	UpdateTenantSettingsRequestSchema,
} from "@orgos/protocol";
import type { Hono } from "hono";
import { parseJson } from "@/lib/http";
import { type AppEnv, requireAuth, requireMember } from "@/middleware/auth";
import {
	getTenantSettings,
	updateTenantSettings,
} from "@/services/tenant-settings";

/** 租户设置：成员都能读（界面据此决定哪些选项可选），只有 owner 能改（否则 403）。 */
export function registerTenantRoutes(app: Hono<AppEnv>): void {
	app.use("/api/tenant/*", requireAuth, requireMember);

	app.get("/api/tenant/settings", async (c) => {
		const body: TenantSettingsResponse = {
			settings: await getTenantSettings(c.get("scope")),
		};
		return c.json(body);
	});

	app.patch("/api/tenant/settings", async (c) => {
		const req = await parseJson(c, UpdateTenantSettingsRequestSchema);
		const body: TenantSettingsResponse = {
			settings: await updateTenantSettings(
				c.get("scope"),
				c.get("member"),
				req,
			),
		};
		return c.json(body);
	});
}
