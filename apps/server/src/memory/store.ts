/**
 * 记忆条目的写入口：新增（写入前凭据清洗、同义去重）、取代（旧条目 superseded 并链到新条目，不删除）、
 * 撤回、本人编辑。提炼、答复与协商的直写、本人更正都经这里。
 */
import type {
	MemoryCategory,
	MemoryEntity,
	MemoryItem,
	MemoryKind,
	MemoryScope,
	MemorySource,
} from "@orgos/protocol";
import { and, eq, inArray } from "drizzle-orm";
import { memoryItems } from "@/db/schema";
import type { Scoped } from "@/db/scope";
import type { MemoryItemRow } from "@/memory/access";
import { normalize, scrubSecrets } from "@/memory/text";

export const MEMORY_CONTENT_CHARS = 300;

export type ItemDraft = {
	subjectId: string;
	kind: MemoryKind;
	category: MemoryCategory;
	content: string;
	entities: MemoryEntity[];
	scope: MemoryScope;
	sources: MemorySource[];
	confidence: number;
	ownerCorrected?: boolean;
	createdByRunId?: string | null;
	validFrom?: Date;
	/** 取代这些 active 条目。 */
	supersedes?: readonly string[];
};

export function toMemoryItem(row: MemoryItemRow): MemoryItem {
	return {
		id: row.id,
		subjectId: row.subjectId,
		kind: row.kind,
		content: row.content,
		category: row.category,
		entities: row.entities,
		scope: row.scope,
		sources: row.sources,
		confidence: row.confidence,
		status: row.status,
		supersededById: row.supersededById,
		ownerCorrected: row.ownerCorrected,
		validFrom: row.validFrom.toISOString(),
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

function clean(text: string): string {
	const chars = Array.from(scrubSecrets(text.replace(/\s+/g, " ").trim()));
	return chars.slice(0, MEMORY_CONTENT_CHARS).join("");
}

/**
 * 写一条条目；同一 subject、同一类别已有内容相同（去空白与标点后）的 active 条目时不重复写，返回 null。
 * 给了 supersedes 时，这些条目（须 active）置 superseded 并链到新条目。调用方负责事务。
 */
export async function writeItem(
	tx: Scoped,
	draft: ItemDraft,
): Promise<MemoryItemRow | null> {
	const content = clean(draft.content);
	if (!content) return null;
	const same = await tx.select(
		memoryItems,
		eq(memoryItems.subjectId, draft.subjectId),
		eq(memoryItems.category, draft.category),
		eq(memoryItems.status, "active"),
	);
	const key = normalize(content);
	if (!draft.ownerCorrected && same.some((r) => normalize(r.content) === key))
		return null;
	const row = await tx.insert(memoryItems, {
		subjectId: draft.subjectId,
		kind: draft.kind,
		category: draft.category,
		content,
		entities: draft.entities.map((e) => ({ ...e, name: scrubSecrets(e.name) })),
		scope: draft.scope,
		sources: draft.sources,
		confidence: Math.min(1, Math.max(0, draft.confidence)),
		status: "active",
		ownerCorrected: draft.ownerCorrected ?? false,
		createdByRunId: draft.createdByRunId ?? null,
		validFrom: draft.validFrom ?? new Date(),
	});
	if (draft.supersedes && draft.supersedes.length > 0)
		await tx.executor
			.update(memoryItems)
			.set({ status: "superseded", supersededById: row.id })
			.where(
				tx.where(
					memoryItems,
					and(
						inArray(memoryItems.id, [...draft.supersedes]),
						eq(memoryItems.status, "active"),
					),
				),
			);
	return row;
}

/** 本人的条目（subject 是本人）；不存在、跨租户或不是本人的 → undefined。 */
export async function ownItem(
	s: Scoped,
	ownerId: string,
	itemId: string,
): Promise<MemoryItemRow | undefined> {
	return s.first(
		memoryItems,
		eq(memoryItems.id, itemId),
		eq(memoryItems.subjectId, ownerId),
	);
}

/** 本人编辑：改内容或类别；改过内容的条目记为本人更正。 */
export async function editItem(
	s: Scoped,
	itemId: string,
	patch: { content?: string; category?: MemoryCategory },
): Promise<MemoryItemRow | undefined> {
	const content =
		patch.content === undefined ? undefined : clean(patch.content);
	const [row] = await s.executor
		.update(memoryItems)
		.set({
			...(content ? { content, ownerCorrected: true } : {}),
			...(patch.category ? { category: patch.category } : {}),
		})
		.where(s.where(memoryItems, eq(memoryItems.id, itemId)))
		.returning();
	return row;
}

/** 撤回：status=retracted（不删除），之后不再被检索，画像随之重建。 */
export async function retractItems(
	s: Scoped,
	itemIds: readonly string[],
): Promise<MemoryItemRow[]> {
	if (itemIds.length === 0) return [];
	return s.executor
		.update(memoryItems)
		.set({ status: "retracted" })
		.where(
			s.where(
				memoryItems,
				and(
					inArray(memoryItems.id, [...itemIds]),
					eq(memoryItems.status, "active"),
				),
			),
		)
		.returning();
}
