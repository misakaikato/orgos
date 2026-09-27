/**
 * 资料与记忆（同表）：本人写的是资料，代理写的（authorId 为代理）是记忆。
 * 本人只能读写 ownerId 为自己的条目。代理经 `memory_search`（`@/memory/search`）检索它们，
 * 可见性与记忆条目同在 `@/memory/access` 的过滤里（为他人只看 shared）。
 */
import type {
	NOTE_VISIBILITIES,
	Note,
	UpdateNoteRequest,
} from "@orgos/protocol";
import { desc, eq } from "drizzle-orm";
import { notes } from "@/db/schema";
import type { Scoped } from "@/db/scope";
import { notFound } from "@/lib/errors";
import { isUuid } from "@/lib/uuid";

export type NoteRow = typeof notes.$inferSelect;

export function toNote(row: NoteRow): Note {
	return {
		id: row.id,
		ownerId: row.ownerId,
		authorId: row.authorId,
		title: row.title,
		body: row.body,
		visibility: row.visibility,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

export async function createNote(
	s: Scoped,
	input: {
		ownerId: string;
		authorId: string;
		title: string;
		body: string;
		visibility: (typeof NOTE_VISIBILITIES)[number];
	},
): Promise<NoteRow> {
	return s.insert(notes, input);
}

/** 某人的全部资料与记忆，最近更新的在前。 */
export async function listNotes(s: Scoped, ownerId: string): Promise<Note[]> {
	const rows = await s.executor
		.select()
		.from(notes)
		.where(s.where(notes, eq(notes.ownerId, ownerId)))
		.orderBy(desc(notes.updatedAt));
	return rows.map(toNote);
}

/** 只能改自己名下的条目；不存在、跨租户或属于别人一律 404。 */
export async function updateNote(
	s: Scoped,
	ownerId: string,
	noteId: string,
	patch: UpdateNoteRequest,
): Promise<Note> {
	if (!isUuid(noteId)) throw notFound("资料不存在");
	const [row] =
		Object.keys(patch).length === 0
			? await s.select(notes, eq(notes.id, noteId), eq(notes.ownerId, ownerId))
			: await s.executor
					.update(notes)
					.set(patch)
					.where(
						s.where(notes, eq(notes.id, noteId), eq(notes.ownerId, ownerId)),
					)
					.returning();
	if (!row) throw notFound("资料不存在");
	return toNote(row);
}

export async function deleteNote(
	s: Scoped,
	ownerId: string,
	noteId: string,
): Promise<void> {
	if (!isUuid(noteId)) throw notFound("资料不存在");
	const rows = await s.executor
		.delete(notes)
		.where(s.where(notes, eq(notes.id, noteId), eq(notes.ownerId, ownerId)))
		.returning({ id: notes.id });
	if (rows.length === 0) throw notFound("资料不存在");
}
