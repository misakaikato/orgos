import { ERROR_CODES } from "@orgos/protocol";
import { Hono } from "hono";
import { auth } from "@/auth";
import { AppError, errorBody } from "@/lib/errors";
import type { AppEnv } from "@/middleware/auth";
import { registerMeRoutes } from "@/routes/me";
import { registerOnboardingRoutes } from "@/routes/onboarding";

export function createApp(): Hono<AppEnv> {
	const app = new Hono<AppEnv>();

	app.get("/healthz", (c) => c.text("ok"));
	app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

	registerOnboardingRoutes(app);
	registerMeRoutes(app);

	app.notFound((c) =>
		c.json(errorBody(ERROR_CODES.NOT_FOUND, "not found"), 404),
	);
	app.onError((err, c) => {
		if (err instanceof AppError) {
			return c.json(errorBody(err.code, err.message), err.status);
		}
		console.error(err);
		return c.json(errorBody(ERROR_CODES.INTERNAL, "服务器内部错误"), 500);
	});

	return app;
}

export const app = createApp();
