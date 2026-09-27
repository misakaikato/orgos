import {
	AddUnitMemberRequestSchema,
	CreateUnitNoteRequestSchema,
	CreateUnitRequestSchema,
	type NoteResponse,
	type OrgResponse,
	type OrgUnitResponse,
	type UnitDetailResponse,
	UpdateUnitNoteRequestSchema,
	UpdateUnitRequestSchema,
} from "@orgos/protocol";
import type { Context, Hono } from "hono";
import { parseJson } from "@/lib/http";
import { type AppEnv, requireAuth, requireMember } from "@/middleware/auth";
import {
	addUnitMember,
	createUnit,
	listOrg,
	type OrgActor,
	removeUnitMember,
	updateUnit,
} from "@/services/org";
import {
	createUnitNote,
	deleteUnitNote,
	unitDetail,
	updateUnitNote,
} from "@/services/unit-notes";

function actorOf(c: Context<AppEnv>): OrgActor {
	return { me: c.get("principal"), tenantRole: c.get("member").role };
}

/**
 * 组织结构：单元树（本租户所有人可读）、建与改单元（租户 owner；章程负责人也可改）、
 * 成员（owner 或负责人）、单元页与单元资料（成员可新增，负责人管理）。
 */
export function registerOrgRoutes(app: Hono<AppEnv>): void {
	app.use("/api/org", requireAuth, requireMember);
	app.use("/api/org/*", requireAuth, requireMember);

	app.get("/api/org", async (c) => {
		const body: OrgResponse = { units: await listOrg(c.get("scope")) };
		return c.json(body);
	});

	app.post("/api/org/units", async (c) => {
		const req = await parseJson(c, CreateUnitRequestSchema);
		const body: OrgUnitResponse = {
			unit: await createUnit(c.get("scope"), actorOf(c), req),
		};
		return c.json(body, 201);
	});

	app.get("/api/org/units/:id", async (c) => {
		const body: UnitDetailResponse = await unitDetail(
			c.get("scope"),
			actorOf(c),
			c.req.param("id"),
		);
		return c.json(body);
	});

	app.patch("/api/org/units/:id", async (c) => {
		const req = await parseJson(c, UpdateUnitRequestSchema);
		const body: OrgUnitResponse = {
			unit: await updateUnit(
				c.get("scope"),
				actorOf(c),
				c.req.param("id"),
				req,
			),
		};
		return c.json(body);
	});

	app.post("/api/org/units/:id/members", async (c) => {
		const req = await parseJson(c, AddUnitMemberRequestSchema);
		const body: OrgUnitResponse = {
			unit: await addUnitMember(
				c.get("scope"),
				actorOf(c),
				c.req.param("id"),
				req,
			),
		};
		return c.json(body, 201);
	});

	app.delete("/api/org/units/:id/members/:principalId", async (c) => {
		await removeUnitMember(
			c.get("scope"),
			actorOf(c),
			c.req.param("id"),
			c.req.param("principalId"),
		);
		return c.body(null, 204);
	});

	app.post("/api/org/units/:id/notes", async (c) => {
		const req = await parseJson(c, CreateUnitNoteRequestSchema);
		const body: NoteResponse = {
			note: await createUnitNote(
				c.get("scope"),
				actorOf(c),
				c.req.param("id"),
				req,
			),
		};
		return c.json(body, 201);
	});

	app.patch("/api/org/units/:id/notes/:noteId", async (c) => {
		const req = await parseJson(c, UpdateUnitNoteRequestSchema);
		const body: NoteResponse = {
			note: await updateUnitNote(
				c.get("scope"),
				actorOf(c),
				c.req.param("id"),
				c.req.param("noteId"),
				req,
			),
		};
		return c.json(body);
	});

	app.delete("/api/org/units/:id/notes/:noteId", async (c) => {
		await deleteUnitNote(
			c.get("scope"),
			actorOf(c),
			c.req.param("id"),
			c.req.param("noteId"),
		);
		return c.body(null, 204);
	});
}
