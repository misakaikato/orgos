import {
	CreateModelGroupRequestSchema,
	CreateModelProviderRequestSchema,
	type ModelAdminResponse,
	type ModelGroupResponse,
	type ModelOptionsResponse,
	type ModelProviderResponse,
	type ProviderModelsResponse,
	ProviderTestRequestSchema,
	type ProviderTestResponse,
	UpdateModelGroupRequestSchema,
	UpdateModelProviderRequestSchema,
} from "@orgos/protocol";
import type { Hono, MiddlewareHandler } from "hono";
import { probeProvider } from "@/gateway/probe";
import { fetchProviderModels } from "@/gateway/upstream";
import { badRequest } from "@/lib/errors";
import { parseJson } from "@/lib/http";
import { type AppEnv, requireAuth, requireMember } from "@/middleware/auth";
import {
	createGroup,
	createProvider,
	deleteGroup,
	deleteProvider,
	listGroups,
	listProviders,
	modelOptions,
	requireProvider,
	requireTenantOwner,
	toModelGroup,
	toModelProvider,
	updateGroup,
	updateProvider,
	upstreamOf,
} from "@/services/model-providers";
import { getTenantSettings } from "@/services/tenant-settings";

const ownerOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
	requireTenantOwner(c.get("member"));
	await next();
};

/**
 * 模型：厂商、路由组的管理只给租户 owner（否则 403）；厂商 key 只写不读，任何响应里都没有它。
 * 可选模型列表（代理选模型用）所有成员可读。
 */
export function registerModelRoutes(app: Hono<AppEnv>): void {
	app.use("/api/models", requireAuth, requireMember);
	app.use("/api/model-admin", requireAuth, requireMember, ownerOnly);
	for (const path of [
		"/api/model-providers",
		"/api/model-providers/*",
		"/api/model-groups",
		"/api/model-groups/*",
	])
		app.use(path, requireAuth, requireMember, ownerOnly);

	app.get("/api/models", async (c) => {
		const s = c.get("scope");
		const body: ModelOptionsResponse = {
			options: await modelOptions(s),
			defaultModel: (await getTenantSettings(s)).defaultModel,
		};
		return c.json(body);
	});

	app.get("/api/model-admin", async (c) => {
		const s = c.get("scope");
		const body: ModelAdminResponse = {
			providers: (await listProviders(s)).map(toModelProvider),
			groups: (await listGroups(s)).map(toModelGroup),
			settings: await getTenantSettings(s),
		};
		return c.json(body);
	});

	app.post("/api/model-providers", async (c) => {
		const req = await parseJson(c, CreateModelProviderRequestSchema);
		const body: ModelProviderResponse = {
			provider: toModelProvider(await createProvider(c.get("scope"), req)),
		};
		return c.json(body, 201);
	});

	app.patch("/api/model-providers/:id", async (c) => {
		const req = await parseJson(c, UpdateModelProviderRequestSchema);
		const body: ModelProviderResponse = {
			provider: toModelProvider(
				await updateProvider(c.get("scope"), c.req.param("id"), req),
			),
		};
		return c.json(body);
	});

	app.delete("/api/model-providers/:id", async (c) => {
		await deleteProvider(c.get("scope"), c.req.param("id"));
		return c.body(null, 204);
	});

	app.get("/api/model-providers/:id/models", async (c) => {
		const row = await requireProvider(c.get("scope"), c.req.param("id"));
		let body: ProviderModelsResponse;
		try {
			body = { models: await fetchProviderModels(upstreamOf(row)) };
		} catch (e) {
			body = {
				models: [],
				error: e instanceof Error ? e.message : "拉取模型列表失败",
			};
		}
		return c.json(body);
	});

	app.post("/api/model-providers/:id/test", async (c) => {
		const req = await parseJson(c, ProviderTestRequestSchema);
		const row = await requireProvider(c.get("scope"), c.req.param("id"));
		const up = upstreamOf(row);
		const model =
			req.model ?? row.exposedModels[0] ?? up.preset?.models[0]?.id ?? null;
		if (!model) throw badRequest("先勾选或填写一个模型再测试");
		const body: ProviderTestResponse = {
			results: await probeProvider(up, model),
		};
		return c.json(body);
	});

	app.post("/api/model-groups", async (c) => {
		const req = await parseJson(c, CreateModelGroupRequestSchema);
		const body: ModelGroupResponse = {
			group: toModelGroup(await createGroup(c.get("scope"), req)),
		};
		return c.json(body, 201);
	});

	app.patch("/api/model-groups/:id", async (c) => {
		const req = await parseJson(c, UpdateModelGroupRequestSchema);
		const body: ModelGroupResponse = {
			group: toModelGroup(
				await updateGroup(c.get("scope"), c.req.param("id"), req),
			),
		};
		return c.json(body);
	});

	app.delete("/api/model-groups/:id", async (c) => {
		await deleteGroup(c.get("scope"), c.req.param("id"));
		return c.body(null, 204);
	});
}
