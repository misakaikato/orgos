import {
	type AnswerActionResponse,
	CorrectAnswerRequestSchema,
	type DisclosureResponse,
	type MemoryItemListResponse,
	type MemoryItemResponse,
	MemoryItemsQuerySchema,
	type MemorySourcesResponse,
	MemoryUnitQuerySchema,
	type TwinAnswerListResponse,
	UpdateDisclosureRequestSchema,
	UpdateMemoryItemRequestSchema,
	WithholdAnswerRequestSchema,
} from "@orgos/protocol";
import type { Context, Hono } from "hono";
import type { PrincipalRow } from "@/db/scope";
import { parseJson, parseQuery } from "@/lib/http";
import { disclosureOf, setDisclosure } from "@/memory/access";
import {
	correctAnswer,
	listOwnItems,
	listTwinAnswers,
	retractOwnItem,
	sourceLinks,
	updateOwnItem,
	withholdAnswer,
} from "@/memory/owner";
import { type AppEnv, requireAuth, requireMember } from "@/middleware/auth";
import { requireUnitHead } from "@/services/org";

/**
 * 这次操作的"本人"：缺省是调用者；给了 `?unitId=` 时是该单元（调用者须是它的负责人，否则 403）。
 */
async function subjectOf(c: Context<AppEnv>): Promise<PrincipalRow> {
	const { unitId } = parseQuery(c, MemoryUnitQuerySchema);
	const me = c.get("principal");
	return unitId ? requireUnitHead(c.get("scope"), me, unitId) : me;
}

/**
 * 本人的记忆控制：自己的条目（浏览、搜索、编辑、撤回）、条目出处（只列我在的会话）、
 * 对外的类别授权、代答记录与其上的"不对""不许对外说"。别人的条目与回答一律 404。
 * 带 `?unitId=` 时，单元负责人以同样的接口管理单元的条目、类别授权与单元分身的代答记录。
 */
export function registerMemoryRoutes(app: Hono<AppEnv>): void {
	app.use("/api/memory/*", requireAuth, requireMember);

	app.get("/api/memory/items", async (c) => {
		const query = parseQuery(c, MemoryItemsQuerySchema);
		const body: MemoryItemListResponse = {
			items: await listOwnItems(c.get("scope"), await subjectOf(c), query),
		};
		return c.json(body);
	});

	app.patch("/api/memory/items/:id", async (c) => {
		const req = await parseJson(c, UpdateMemoryItemRequestSchema);
		const body: MemoryItemResponse = {
			item: await updateOwnItem(
				c.get("scope"),
				await subjectOf(c),
				c.req.param("id"),
				req,
			),
		};
		return c.json(body);
	});

	app.post("/api/memory/items/:id/retract", async (c) => {
		const body: MemoryItemResponse = {
			item: await retractOwnItem(
				c.get("scope"),
				await subjectOf(c),
				c.req.param("id"),
			),
		};
		return c.json(body);
	});

	app.get("/api/memory/items/:id/sources", async (c) => {
		const body: MemorySourcesResponse = {
			links: await sourceLinks(
				c.get("scope"),
				c.get("principal"),
				c.req.param("id"),
			),
		};
		return c.json(body);
	});

	app.get("/api/memory/disclosure", async (c) => {
		const body: DisclosureResponse = {
			rules: await disclosureOf(c.get("scope"), (await subjectOf(c)).id),
		};
		return c.json(body);
	});

	app.put("/api/memory/disclosure", async (c) => {
		const req = await parseJson(c, UpdateDisclosureRequestSchema);
		const s = c.get("scope");
		const subject = await subjectOf(c);
		await setDisclosure(s, subject.id, req.category, req.allowed);
		const body: DisclosureResponse = {
			rules: await disclosureOf(s, subject.id),
		};
		return c.json(body);
	});

	app.get("/api/memory/answers", async (c) => {
		const body: TwinAnswerListResponse = {
			items: await listTwinAnswers(c.get("scope"), await subjectOf(c)),
		};
		return c.json(body);
	});

	app.post("/api/memory/answers/:eventId/correct", async (c) => {
		const req = await parseJson(c, CorrectAnswerRequestSchema);
		const body: AnswerActionResponse = await correctAnswer(
			c.get("scope"),
			await subjectOf(c),
			c.req.param("eventId"),
			req,
		);
		return c.json(body, 201);
	});

	app.post("/api/memory/answers/:eventId/withhold", async (c) => {
		const req = await parseJson(c, WithholdAnswerRequestSchema);
		const body: AnswerActionResponse = await withholdAnswer(
			c.get("scope"),
			await subjectOf(c),
			c.req.param("eventId"),
			req,
		);
		return c.json(body);
	});
}
