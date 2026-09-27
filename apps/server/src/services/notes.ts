/**
 * 资料与记忆（同表）：本人写的是资料，代理写的（authorId 为代理）是记忆。
 */
import type { NOTE_VISIBILITIES } from "@orgos/protocol";
import { notes } from "@/db/schema";
import type { Scoped } from "@/db/scope";

export type NoteRow = typeof notes.$inferSelect;

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
