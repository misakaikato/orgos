import {
	CreateNoteRequestSchema,
	type NoteListResponse,
	type NoteResponse,
	UpdateNoteRequestSchema,
} from "@orgos/protocol";
import type { Hono } from "hono";
import { parseJson } from "@/lib/http";
import { type AppEnv, requireAuth, requireMember } from "@/middleware/auth";
import {
	createNote,
	deleteNote,
	listNotes,
	toNote,
	updateNote,
} from "@/services/notes";

/** 本人的资料与代理记下的记忆：只能读写 ownerId 为自己的条目（别人的一律 404）。 */
export function registerNoteRoutes(app: Hono<AppEnv>): void {
	app.use("/api/notes", requireAuth, requireMember);
	app.use("/api/notes/*", requireAuth, requireMember);

	app.get("/api/notes", async (c) => {
		const body: NoteListResponse = {
			items: await listNotes(c.get("scope"), c.get("principal").id),
		};
		return c.json(body);
	});

	app.post("/api/notes", async (c) => {
		const req = await parseJson(c, CreateNoteRequestSchema);
		const me = c.get("principal");
		const row = await createNote(c.get("scope"), {
			ownerId: me.id,
			authorId: me.id,
			...req,
		});
		const body: NoteResponse = { note: toNote(row) };
		return c.json(body, 201);
	});

	app.patch("/api/notes/:id", async (c) => {
		const req = await parseJson(c, UpdateNoteRequestSchema);
		const body: NoteResponse = {
			note: await updateNote(
				c.get("scope"),
				c.get("principal").id,
				c.req.param("id"),
				req,
			),
		};
		return c.json(body);
	});

	app.delete("/api/notes/:id", async (c) => {
		await deleteNote(c.get("scope"), c.get("principal").id, c.req.param("id"));
		return c.body(null, 204);
	});
}
