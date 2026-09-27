import { ERROR_CODES } from "@orgos/protocol";
import { Hono } from "hono";
import { auth } from "@/auth";
import { AppError, errorBody } from "@/lib/errors";
import { wsProxyEvents } from "@/lib/ws-proxy";
import { upgradeWs } from "@/lib/ws-upgrade";
import type { AppEnv } from "@/middleware/auth";
import { nextWsTarget, proxyToNext } from "@/proxy";
import { registerAgentRoutes } from "@/routes/agents";
import { registerConversationRoutes } from "@/routes/conversations";
import { registerDevRoutes } from "@/routes/dev";
import { registerLlmRoutes } from "@/routes/llm";
import { registerMeRoutes } from "@/routes/me";
import { registerMemoryRoutes } from "@/routes/memory";
import { registerModelRoutes } from "@/routes/models";
import { registerNoteRoutes } from "@/routes/notes";
import { registerOnboardingRoutes } from "@/routes/onboarding";
import { registerRunnerRoutes } from "@/routes/runners";
import { registerRunRoutes } from "@/routes/runs";
import { registerTaskRoutes } from "@/routes/tasks";
import { registerTenantRoutes } from "@/routes/tenant";
import { registerTopicRoutes } from "@/routes/topics";
import { registerWorkItemRoutes } from "@/routes/work-items";
import { registerWsRoutes } from "@/routes/ws";

export function createApp(): Hono<AppEnv> {
	const app = new Hono<AppEnv>();

	app.get("/healthz", (c) => c.text("ok"));
	app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

	registerOnboardingRoutes(app);
	registerMeRoutes(app);
	registerConversationRoutes(app);
	registerWorkItemRoutes(app);
	registerAgentRoutes(app);
	registerNoteRoutes(app);
	registerMemoryRoutes(app);
	registerRunnerRoutes(app);
	registerTaskRoutes(app);
	registerTopicRoutes(app);
	registerRunRoutes(app);
	registerTenantRoutes(app);
	registerModelRoutes(app);
	registerLlmRoutes(app);
	registerWsRoutes(app);
	registerDevRoutes(app);

	// 具体路由在前；未命中的 /api 返回统一错误体，其余全部反代给内部 Next（含 HMR 的 WS 升级）。
	app.all("/api/*", (c) =>
		c.json(errorBody(ERROR_CODES.NOT_FOUND, "not found"), 404),
	);
	app.all("*", (c) => {
		if (c.req.header("upgrade")?.toLowerCase() === "websocket") {
			return upgradeWs(c, wsProxyEvents(nextWsTarget(new URL(c.req.url))));
		}
		return proxyToNext(c.req.raw);
	});
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
