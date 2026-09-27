/**
 * 资料与记忆（同表）：本人写的是资料，代理写的（authorId 为代理）是记忆。
 * 本人只能读写 ownerId 为自己的条目；代理检索时按行事对象收窄（为他人只看 shared）。
 */
import type {
	NOTE_VISIBILITIES,
	Note,
	UpdateNoteRequest,
} from "@orgos/protocol";
import { desc, eq, ilike, or } from "drizzle-orm";
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

export const SEARCH_LIMIT = 8;
const MAX_TERMS = 8;

/** 关键词：按空白与中英文标点切分。 */
export function searchTerms(query: string): string[] {
	const terms = query
		.split(/[\s,.;:!?，。、；：！？（）()《》〈〉「」『』【】“”‘’"'|/\\-]+/u)
		.map((t) => t.trim())
		.filter(Boolean);
	return [...new Set(terms)].slice(0, MAX_TERMS);
}

function likePattern(term: string): string {
	return `%${term.replace(/[\\%_]/g, "\\$&")}%`;
}

/**
 * 在某人的资料与记忆里检索：ILIKE 命中的关键词数多者在前（同分按更新时间），取前 8 条。
 * `sharedOnly` 时只看共享的条目（代理为他人办事）。
 */
export async function searchNotes(
	s: Scoped,
	ownerId: string,
	query: string,
	opts: { sharedOnly: boolean },
): Promise<NoteRow[]> {
	const terms = searchTerms(query);
	if (terms.length === 0) return [];
	const rows = await s.select(
		notes,
		eq(notes.ownerId, ownerId),
		opts.sharedOnly ? eq(notes.visibility, "shared") : undefined,
		or(
			...terms.flatMap((t) => [
				ilike(notes.title, likePattern(t)),
				ilike(notes.body, likePattern(t)),
			]),
		),
	);
	const hits = (row: NoteRow) => {
		const text = `${row.title}\n${row.body}`.toLowerCase();
		return terms.filter((t) => text.includes(t.toLowerCase())).length;
	};
	return rows
		.map((row) => ({ row, score: hits(row) }))
		.sort(
			(a, b) =>
				b.score - a.score ||
				b.row.updatedAt.getTime() - a.row.updatedAt.getTime(),
		)
		.slice(0, SEARCH_LIMIT)
		.map((x) => x.row);
}
