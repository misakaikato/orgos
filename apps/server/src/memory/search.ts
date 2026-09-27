/**
 * 统一检索（`memory_search` 工具的实现）：先过滤、再打分。
 *
 * - 过滤只经 `visibilityFilter`：条目（第 1 层）与本人的资料（第 0 层）一起参与；
 * - 打分 = 关键词覆盖（中文按字二元组、英文按词）+ 实体命中 + 时间衰减，本人更正过的条目加权；
 * - 先给相关的画像段落（只含查看者看得到的段落），再给条目与资料，合计最多 8 条；
 * - 条目按第三人规则呈现，并带 `[M:<短编号>]` 供回复引用。
 */
import type { MessageCitation } from "@orgos/protocol";
import { citationMark } from "@orgos/protocol";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { memoryItems, notes, principals } from "@/db/schema";
import type { PrincipalRow, Scoped } from "@/db/scope";
import {
	type MemoryItemRow,
	presentItem,
	type Viewer,
	visibilityFilter,
} from "@/memory/access";
import { visibleSections } from "@/memory/profiles";
import { clipChars, coverage, termSet } from "@/memory/text";

export const MEMORY_SEARCH_LIMIT = 8;
export const PROFILE_SECTIONS_SHOWN = 2;
const ITEM_POOL = 500;
const NOTE_POOL = 200;
const NOTE_CHARS = 300;
const DECAY_DAYS = 30;
const ENTITY_BONUS = 0.3;
const CORRECTED_WEIGHT = 1.5;

export type MemorySearchResult = {
	/** 交给模型的结果行；为空即无结果。 */
	lines: string[];
	/** 本次给出、回复里可以引用的条目（引用标记 → 依据）。 */
	citable: Map<string, MessageCitation>;
	/** 给人看的一句话（agent.action）。 */
	summary: string;
};

type Scored =
	| { kind: "item"; row: MemoryItemRow; score: number }
	| { kind: "note"; row: typeof notes.$inferSelect; score: number };

const dateLabel = (d: Date) =>
	new Intl.DateTimeFormat("zh-CN", {
		timeZone: "Asia/Shanghai",
		month: "numeric",
		day: "numeric",
	}).format(d);

/** about：handle（可带 @）或显示名 → 本租户的一个人。 */
async function resolveAbout(
	s: Scoped,
	about: string | undefined,
): Promise<PrincipalRow | undefined> {
	const key = about?.trim().replace(/^@/, "");
	if (!key) return undefined;
	return s.first(
		principals,
		eq(principals.kind, "human"),
		or(eq(principals.handle, key), eq(principals.displayName, key)),
	);
}

function itemScore(
	row: MemoryItemRow,
	q: ReadonlySet<string>,
	query: string,
	now: Date,
): number {
	const text = [row.content, row.category, ...row.entities.map((e) => e.name)];
	const cov = coverage(q, text.join(" "));
	const entityHit = row.entities.some(
		(e) =>
			e.name.length >= 2 && query.toLowerCase().includes(e.name.toLowerCase()),
	);
	if (cov === 0 && !entityHit) return 0;
	const ageDays =
		Math.max(0, now.getTime() - row.validFrom.getTime()) / 86_400_000;
	const decay = Math.exp(-ageDays / DECAY_DAYS);
	const score = cov * (0.7 + 0.3 * decay) + (entityHit ? ENTITY_BONUS : 0);
	return row.ownerCorrected ? score * CORRECTED_WEIGHT : score;
}

export async function searchMemory(
	s: Scoped,
	viewer: Viewer,
	input: { query: string; about?: string; now?: Date },
): Promise<MemorySearchResult> {
	const now = input.now ?? new Date();
	const q = termSet(input.query);
	const citable = new Map<string, MessageCitation>();
	const none = {
		lines: [],
		citable,
		summary: `查记忆“${clipChars(input.query, 20)}”：无结果`,
	};
	if (q.size === 0) return none;
	const about = await resolveAbout(s, input.about);
	const filter = await visibilityFilter(s, viewer);

	const itemRows = await s.executor
		.select()
		.from(memoryItems)
		.where(
			and(
				filter.items,
				about
					? or(
							eq(memoryItems.subjectId, about.id),
							sql`${memoryItems.entities} @> ${JSON.stringify([{ principalId: about.id }])}::jsonb`,
						)
					: undefined,
			),
		)
		.orderBy(desc(memoryItems.updatedAt))
		.limit(ITEM_POOL);
	const noteRows =
		!about || about.id === viewer.ownerId
			? await s.executor
					.select()
					.from(notes)
					.where(filter.notes)
					.orderBy(desc(notes.updatedAt))
					.limit(NOTE_POOL)
			: [];
	const scored: Scored[] = [
		...itemRows.map((row) => ({
			kind: "item" as const,
			row,
			score: itemScore(row, q, input.query, now),
		})),
		...noteRows.map((row) => ({
			kind: "note" as const,
			row,
			score: coverage(q, `${row.title} ${row.title} ${row.body}`),
		})),
	]
		.filter((x) => x.score > 0)
		.sort(
			(a, b) =>
				b.score - a.score ||
				b.row.updatedAt.getTime() - a.row.updatedAt.getTime(),
		);

	const sections = (
		await visibleSections(s, about?.id ?? viewer.ownerId, viewer)
	)
		.map((x) => ({ x, score: coverage(q, `${x.heading} ${x.text}`) }))
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, PROFILE_SECTIONS_SHOWN)
		.map((x) => x.x);

	const picked = scored.slice(0, MEMORY_SEARCH_LIMIT - sections.length);
	if (sections.length === 0 && picked.length === 0) return none;

	const scopeIds = picked.flatMap((p) =>
		p.kind === "item" ? (p.row.scope.principalIds ?? []) : [],
	);
	const people = new Map(
		(
			await s.select(
				principals,
				inArray(principals.id, [...new Set([...scopeIds, viewer.ownerId])]),
			)
		).map((p) => [p.id, p]),
	);

	const lines: string[] = [];
	for (const sec of sections) {
		for (const id of sec.itemIds)
			citable.set(citationMark(id), { id, content: sec.text });
		const marks = sec.itemIds.map(citationMark).join("");
		lines.push(`[画像·${sec.heading}] ${sec.text} ${marks}`);
	}
	let itemCount = 0;
	const noteTitles: string[] = [];
	for (const p of picked) {
		if (p.kind === "note") {
			noteTitles.push(`《${p.row.title}》`);
			lines.push(
				`[资料]《${p.row.title}》${clipChars(p.row.body, NOTE_CHARS)}`,
			);
			continue;
		}
		itemCount += 1;
		const shown = presentItem(p.row, viewer, people);
		const mark = citationMark(p.row.id);
		citable.set(mark, { id: p.row.id, content: shown.content });
		const corrected = p.row.ownerCorrected ? "本人更正，以此为准；" : "";
		lines.push(
			`${mark} ${shown.content}（${corrected}${shown.category}；${shown.source}；${dateLabel(p.row.validFrom)}）`,
		);
	}
	const parts = [
		...(sections.length > 0 ? [`${sections.length} 段画像`] : []),
		...(itemCount > 0 ? [`${itemCount} 条记忆`] : []),
		...noteTitles,
	];
	return { lines, citable, summary: `查阅了${parts.join("、")}` };
}
