/**
 * 记忆的可见性：可见范围怎么由来源推导、谁能看到哪些条目与资料、替他人回答时怎么呈现。
 *
 * - 可见范围按来源自动决定（`scopeOfConversation`、`scopeOfNote`）；
 * - 过滤只在 `visibilityFilter` 一处：为本人时看 subject 或 scope 含本人的条目与本人全部资料；
 *   为他人 R 时，在此之上还须 scope 含 R（或全员可见），或〔subject 是本人且类别在本人的授权内〕；
 *   资料只看本人的，为他人时只看共享的（共享资料的可见范围是全员）；
 * - 第三人规则（`presentItem`）：为他人 R 回答时，条目若来自有 R 与本人以外的人在场的交流，
 *   只给出抹去第三人姓名的陈述，出处写"来自与同事的交流"，不给人名、原话与会话链接。
 */
import {
	DEFAULT_DISCLOSED_CATEGORIES,
	MEMORY_CATEGORIES,
	type MemoryCategory,
	type MemoryScope,
	type NOTE_VISIBILITIES,
} from "@orgos/protocol";
import { and, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import {
	conversationMembers,
	conversations,
	disclosureRules,
	memoryItems,
	notes,
	principals,
} from "@/db/schema";
import type { PrincipalRow, Scoped } from "@/db/scope";

export type MemoryItemRow = typeof memoryItems.$inferSelect;

/** 谁在看：代理的本人，以及（替他人回答时）提问的人。 */
export type Viewer = { ownerId: string; requesterId: string | null };

// ─────────────────────────── 可见范围的推导 ───────────────────────────

/**
 * 会话来源的可见范围：只有一个真人（本人与自己的代理）→ owner；
 * 两人私聊（含双方分身）、群聊、协商（双方本人为观察者）→ participants{当时的真人成员}。
 * 同时返回这些真人（提炼时 subject 只能是其中之一）。
 */
export async function scopeOfConversation(
	s: Scoped,
	conversationId: string,
): Promise<{ scope: MemoryScope; humans: PrincipalRow[] }> {
	const rows = await s.executor
		.select({ p: principals })
		.from(conversationMembers)
		.innerJoin(principals, eq(principals.id, conversationMembers.principalId))
		.where(
			and(
				s.where(
					conversationMembers,
					eq(conversationMembers.conversationId, conversationId),
				),
				s.where(principals, eq(principals.kind, "human")),
			),
		);
	const humans = rows.map((r) => r.p);
	const ids = humans.map((h) => h.id).sort();
	const conversation = await s.first(
		conversations,
		eq(conversations.id, conversationId),
	);
	const scope: MemoryScope =
		ids.length === 1 && conversation?.kind === "dm"
			? { kind: "owner", principalIds: ids }
			: { kind: "participants", principalIds: ids };
	return { scope, humans };
}

/** 资料的可见范围：私有 → 仅本人；共享 → 全员。 */
export function scopeOfNote(note: {
	ownerId: string;
	visibility: (typeof NOTE_VISIBILITIES)[number];
}): MemoryScope {
	return note.visibility === "shared"
		? { kind: "tenant" }
		: { kind: "owner", principalIds: [note.ownerId] };
}

export function scopeIncludes(
	scope: MemoryScope,
	principalId: string,
): boolean {
	return (
		scope.kind === "tenant" || (scope.principalIds ?? []).includes(principalId)
	);
}

// ─────────────────────────── 类别授权 ───────────────────────────

export async function disclosureOf(
	s: Scoped,
	ownerId: string,
): Promise<
	{ category: MemoryCategory; allowed: boolean; isDefault: boolean }[]
> {
	const rows = await s.select(
		disclosureRules,
		eq(disclosureRules.ownerId, ownerId),
	);
	const set = new Map(rows.map((r) => [r.category, r.allowed]));
	return MEMORY_CATEGORIES.map((category) => {
		const own = set.get(category);
		return {
			category,
			allowed: own ?? DEFAULT_DISCLOSED_CATEGORIES.has(category),
			isDefault: own === undefined,
		};
	});
}

export async function allowedCategories(
	s: Scoped,
	ownerId: string,
): Promise<MemoryCategory[]> {
	return (await disclosureOf(s, ownerId))
		.filter((r) => r.allowed)
		.map((r) => r.category);
}

export async function setDisclosure(
	s: Scoped,
	ownerId: string,
	category: MemoryCategory,
	allowed: boolean,
): Promise<void> {
	await s.executor
		.insert(disclosureRules)
		.values({ tenantId: s.tenantId, ownerId, category, allowed })
		.onConflictDoUpdate({
			target: [disclosureRules.ownerId, disclosureRules.category],
			set: { allowed },
		});
}

// ─────────────────────────── 过滤（唯一一处） ───────────────────────────

function scopeHas(principalId: string): SQL {
	return sql`(${memoryItems.scope}->>'kind' = 'tenant' or ${memoryItems.scope}->'principalIds' @> ${JSON.stringify([principalId])}::jsonb)`;
}

/**
 * 某位查看者能用的条目与资料的条件（已带租户条件）。条目只取 active。
 */
export async function visibilityFilter(
	s: Scoped,
	viewer: Viewer,
): Promise<{ items: SQL; notes: SQL }> {
	const { ownerId, requesterId } = viewer;
	const ownerSees = or(eq(memoryItems.subjectId, ownerId), scopeHas(ownerId));
	if (requesterId === null) {
		return {
			items: s.where(memoryItems, eq(memoryItems.status, "active"), ownerSees),
			notes: s.where(notes, eq(notes.ownerId, ownerId)),
		};
	}
	const allowed = await allowedCategories(s, ownerId);
	const disclosed =
		allowed.length > 0
			? and(
					eq(memoryItems.subjectId, ownerId),
					inArray(memoryItems.category, allowed),
				)
			: undefined;
	return {
		items: s.where(
			memoryItems,
			eq(memoryItems.status, "active"),
			ownerSees,
			or(scopeHas(requesterId), disclosed),
		),
		notes: s.where(
			notes,
			eq(notes.ownerId, ownerId),
			eq(notes.visibility, "shared"),
		),
	};
}

/** 在一批条目 id 里，查看者能看到的那些。 */
export async function visibleItems(
	s: Scoped,
	viewer: Viewer,
	ids: readonly string[],
): Promise<MemoryItemRow[]> {
	if (ids.length === 0) return [];
	const filter = await visibilityFilter(s, viewer);
	return s.executor
		.select()
		.from(memoryItems)
		.where(and(filter.items, inArray(memoryItems.id, [...ids])));
}

// ─────────────────────────── 呈现（第三人规则） ───────────────────────────

/** 替 requester 回答时，这条条目的来源里有没有第三人（requester 与本人以外的人）。 */
export function thirdParties(item: MemoryItemRow, viewer: Viewer): string[] {
	if (viewer.requesterId === null || item.scope.kind !== "participants")
		return [];
	return (item.scope.principalIds ?? []).filter(
		(id) => id !== viewer.requesterId && id !== viewer.ownerId,
	);
}

export const COLLEAGUE_SOURCE_LABEL = "来自与同事的交流";

export type PresentedItem = {
	id: string;
	content: string;
	category: MemoryCategory;
	/** 给模型与界面看的出处说明。 */
	source: string;
	/** 已按第三人规则处理（不给人名、原话与链接）。 */
	redacted: boolean;
};

function escapeRe(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 把第三人的姓名与 handle 从陈述里抹成"同事"。 */
export function withoutNames(
	content: string,
	people: readonly Pick<PrincipalRow, "displayName" | "handle">[],
): string {
	let out = content;
	const names = people
		.flatMap((p) => [p.displayName, `@${p.handle}`, p.handle])
		.filter((n) => n.trim().length > 0)
		.sort((a, b) => b.length - a.length);
	for (const name of names)
		out = out.replace(new RegExp(escapeRe(name), "gi"), "同事");
	return out;
}

/**
 * 条目给这位查看者的样子。`people` 需含条目 scope 里全部人（姓名用于出处说明与抹名）。
 */
export function presentItem(
	item: MemoryItemRow,
	viewer: Viewer,
	people: ReadonlyMap<string, PrincipalRow>,
): PresentedItem {
	const base = { id: item.id, category: item.category };
	const others = thirdParties(item, viewer);
	if (others.length > 0) {
		const named = others.flatMap((id) => {
			const p = people.get(id);
			return p ? [p] : [];
		});
		return {
			...base,
			content: withoutNames(item.content, named),
			source: COLLEAGUE_SOURCE_LABEL,
			redacted: true,
		};
	}
	const name = (id: string) => people.get(id)?.displayName ?? "同事";
	const ids = item.scope.principalIds ?? [];
	let source: string;
	if (item.scope.kind === "tenant") source = "全员可见的记录";
	else if (viewer.requesterId !== null)
		source = ids.includes(viewer.requesterId)
			? "来自与你的交流"
			: `来自${name(viewer.ownerId)}的记录`;
	else if (item.scope.kind === "owner") source = "来自你与代理的对话";
	else {
		const with_ = ids.filter((id) => id !== viewer.ownerId).map(name);
		source =
			with_.length > 0 ? `来自与${with_.join("、")}的交流` : "来自你的对话";
	}
	return { ...base, content: item.content, source, redacted: false };
}
