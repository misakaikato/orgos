/**
 * 单元资料与单元页：资料的 ownerId 是单元，visibility 为 unit（仅成员可见）或 shared（全员可见）。
 *
 * - 成员可以新增单元资料；负责人管理（改、删）全部单元资料；
 * - 单元分身按章程做的决定经 `recordUnitDecision` 写成一条单元资料，同时写一条
 *   subject = 单元、可见范围为该单元的 decision 记忆，出处指向这条资料；单元页的"最近决定"即这些资料。
 */
import {
	type CreateUnitNoteRequest,
	ERROR_CODES,
	type Note,
	type UnitDetailResponse,
	type UpdateUnitNoteRequest,
} from "@orgos/protocol";
import { desc, eq, sql } from "drizzle-orm";
import { memoryItems, notes } from "@/db/schema";
import type { Scoped } from "@/db/scope";
import { AppError, notFound } from "@/lib/errors";
import { isUuid } from "@/lib/uuid";
import { writeItem } from "@/memory/store";
import { clipChars } from "@/memory/text";
import { createNote, toNote } from "@/services/notes";
import { getOrgUnit, type OrgActor, requireUnit } from "@/services/org";
import { isUnitMember } from "@/services/units";

const DECISIONS_SHOWN = 20;

/** 某人看得到的单元资料条件：成员看全部，非成员只看 shared。 */
function visibleUnitNotes(s: Scoped, unitId: string, member: boolean) {
	return s.where(
		notes,
		eq(notes.ownerId, unitId),
		member ? undefined : eq(notes.visibility, "shared"),
	);
}

/** 单元页：单元、我的身份、我看得到的单元资料与单元分身的最近决定。 */
export async function unitDetail(
	s: Scoped,
	actor: OrgActor,
	unitId: string,
): Promise<UnitDetailResponse> {
	const unit = await getOrgUnit(s, unitId);
	const mine = unit.members.find((m) => m.principal.id === actor.me.id);
	const rows = await s.executor
		.select()
		.from(notes)
		.where(visibleUnitNotes(s, unit.unit.id, mine !== undefined))
		.orderBy(desc(notes.updatedAt));
	const decisionNoteIds = new Set(
		(
			await s.select(
				memoryItems,
				eq(memoryItems.subjectId, unit.unit.id),
				eq(memoryItems.kind, "decision"),
				sql`${memoryItems.sources} @> '[{"kind":"note"}]'::jsonb`,
			)
		).flatMap((i) =>
			i.sources.filter((x) => x.kind === "note").map((x) => x.id),
		),
	);
	const all = rows.map(toNote);
	return {
		unit,
		myRole: mine?.role ?? null,
		canAdminister: actor.tenantRole === "owner",
		notes: all.filter((n) => !decisionNoteIds.has(n.id)),
		decisions: all
			.filter((n) => decisionNoteIds.has(n.id))
			.slice(0, DECISIONS_SHOWN),
	};
}

/** 新增单元资料（仅成员）。 */
export async function createUnitNote(
	s: Scoped,
	actor: OrgActor,
	unitId: string,
	req: CreateUnitNoteRequest,
): Promise<Note> {
	const { unit } = await requireUnit(s, unitId);
	if (!(await isUnitMember(s, unit.principalId, actor.me.id)))
		throw new AppError(
			403,
			ERROR_CODES.FORBIDDEN,
			"只有部门成员可以新增部门资料",
		);
	const row = await createNote(s, {
		ownerId: unit.principalId,
		authorId: actor.me.id,
		title: req.title,
		body: req.body,
		visibility: req.visibility ?? "unit",
	});
	return toNote(row);
}

/** 负责人才能改、删单元资料；资料不存在或不属于该单元 → 404。 */
async function requireManagedNote(
	s: Scoped,
	actor: OrgActor,
	unitId: string,
	noteId: string,
): Promise<string> {
	const { unit } = await requireUnit(s, unitId);
	if (unit.headId !== actor.me.id)
		throw new AppError(
			403,
			ERROR_CODES.FORBIDDEN,
			"只有部门负责人可以管理部门资料",
		);
	const row = isUuid(noteId)
		? await s.first(
				notes,
				eq(notes.id, noteId),
				eq(notes.ownerId, unit.principalId),
			)
		: undefined;
	if (!row) throw notFound("资料不存在");
	return row.id;
}

export async function updateUnitNote(
	s: Scoped,
	actor: OrgActor,
	unitId: string,
	noteId: string,
	patch: UpdateUnitNoteRequest,
): Promise<Note> {
	const id = await requireManagedNote(s, actor, unitId, noteId);
	const [row] =
		Object.keys(patch).length === 0
			? await s.select(notes, eq(notes.id, id))
			: await s.executor
					.update(notes)
					.set(patch)
					.where(s.where(notes, eq(notes.id, id)))
					.returning();
	if (!row) throw notFound("资料不存在");
	return toNote(row);
}

export async function deleteUnitNote(
	s: Scoped,
	actor: OrgActor,
	unitId: string,
	noteId: string,
): Promise<void> {
	const id = await requireManagedNote(s, actor, unitId, noteId);
	await s.executor.delete(notes).where(s.where(notes, eq(notes.id, id)));
}

/**
 * 单元分身按章程做了一个决定：一个事务里写单元资料（visibility=unit，作者为分身）与
 * subject = 单元、scope = unit 的 decision 记忆，出处指向这条资料。
 */
export async function recordUnitDecision(
	s: Scoped,
	input: {
		unitId: string;
		authorId: string;
		title: string;
		body: string;
		runId?: string | null;
		at?: Date;
	},
): Promise<{ note: Note }> {
	return s.transaction(async (tx) => {
		const note = await createNote(tx, {
			ownerId: input.unitId,
			authorId: input.authorId,
			title: input.title,
			body: input.body,
			visibility: "unit",
		});
		await writeItem(tx, {
			subjectId: input.unitId,
			kind: "decision",
			category: "决定与口径",
			content: `${input.title}：${clipChars(input.body, 200)}`,
			entities: [],
			scope: { kind: "unit", unitId: input.unitId },
			sources: [{ kind: "note", id: note.id }],
			confidence: 1,
			createdByRunId: input.runId ?? null,
			...(input.at ? { validFrom: input.at } : {}),
		});
		return { note: toNote(note) };
	});
}
