import { OnboardingRequestSchema } from "@orgos/protocol";
import type { Hono } from "hono";
import { parseJson } from "@/lib/http";
import { type AppEnv, requireAuth } from "@/middleware/auth";
import { onboard } from "@/services/onboarding";

export function registerOnboardingRoutes(app: Hono<AppEnv>): void {
	app.post("/api/onboarding", requireAuth, async (c) => {
		const req = await parseJson(c, OnboardingRequestSchema);
		return c.json(await onboard(c.get("user").id, req), 201);
	});
}
