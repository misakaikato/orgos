/**
 * 记忆的可见性：可见范围怎么由来源推导、谁能看到哪些条目与资料、替他人回答时怎么呈现。
 *
 * - 可见范围按来源自动决定（`scopeOfConversation`、`scopeOfNote`）；
 * - 过滤只在 `visibilityFilter` 一处：为本人时看 subject 或 scope 含本人的条目与本人全部资料；
 *   为他人 R 时，在此之上还须 scope 含 R（或全员可见），或〔subject 是本人且类别在本人的授权内〕；
 *   资料只看本人的，为他人时只看共享的（共享资料的可见范围是全员）；
 * - 第三人规则（`presentItem`）：为他人 R 回答时，条目若来自有 R 与本人以外的人在场的交流，
 *   只给出抹去第三人姓名的陈述，出处写"来自与同事的交流"，不给人名、原话与会话链接；
 * - unit 范围（单元群、单元资料、单元的决定）在这里解释为"该单元当前成员与该单元本身"：
 *   过滤时成员与单元都算在范围内；呈现给非成员时一律按第三人规则处理（抹去单元成员姓名）。
 *   "本人"可以是单元（单元分身的本人），此时它的类别授权由负责人管理。
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
	orgUnits,
	principals,
	unitMemberships,
} from "@/db/schema";
import type { PrincipalRow, Scoped } from "@/db/scope";

export type MemoryItemRow = typeof memoryItems.$inferSelect;

/** 谁在看：代理的本人，以及（替他人回答时）提问的人。 */
export type Viewer = { ownerId: string; requesterId: string | null };

// ─────────────────────────── 可见范围的推导 ───────────────────────────

/**
 * 会话来源的可见范围：只有一个真人（本人与自己的代理）→ owner；单元群 → unit{该单元}；
 * 两人私聊（含双方分身）、群聊 → participants{当时的真人成员}；与单元分身的私聊 → participants{提问人, 单元}；
 * 协商 → participants{双方分身各自的本人（人或单元）}。
 * 同时返回这些真人与单元（提炼时 subject 只能是其中之一）。
 */
export async function scopeOfConversation(
	s: Scoped,
	conversationId: string,
): Promise<{
	scope: MemoryScope;
	humans: PrincipalRow[];
	/** 参与这段交流的单元（单元群、与单元分身的私聊、单元参与的协商）：也可以作条目的 subject。 */
	units: PrincipalRow[];
}> {
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
				s.where(principals),
			),
		);
	const members = rows.map((r) => r.p);
	const humans = members.filter((p) => p.kind === "human");
	const conversation = await s.first(
		conversations,
		eq(conversations.id, conversationId),
	);
	const group = await s.first(
		orgUnits,
		eq(orgUnits.groupConversationId, conversationId),
	);
	if (group)
		return {
			scope: { kind: "unit", unitId: group.principalId },
			humans,
			units: await principalsIn(s, [group.principalId]),
		};
	// 代理所属的单元（与单元分身的私聊、单元参与的协商）；协商里的"本人"是两个代理各自所属的一方。
	const owners = await principalsIn(
		s,
		members.flatMap((p) =>
			p.kind === "agent" && p.ownerId ? [p.ownerId] : [],
		),
	);
	const units = owners.filter((p) => p.kind === "unit");
	const sides =
		conversation?.kind === "negotiation"
			? owners.map((p) => p.id)
			: [...humans.map((h) => h.id), ...units.map((u) => u.id)];
	const ids = [...new Set(sides)].sort();
	const scope: MemoryScope =
		ids.length === 1 && conversation?.kind === "dm"
			? { kind: "owner", principalIds: ids }
			: { kind: "participants", principalIds: ids };
	return { scope, humans, units };
}

async function principalsIn(
	s: Scoped,
	ids: readonly string[],
): Promise<PrincipalRow[]> {
	if (ids.length === 0) return [];
	return s.select(principals, inArray(principals.id, [...new Set(ids)]));
}

/** 资料的可见范围：私有 → 仅本人；共享 → 全员；单元资料 → 该单元。 */
export function scopeOfNote(note: {
	ownerId: string;
	visibility: (typeof NOTE_VISIBILITIES)[number];
}): MemoryScope {
	if (note.visibility === "shared") return { kind: "tenant" };
	if (note.visibility === "unit") return { kind: "unit", unitId: note.ownerId };
	return { kind: "owner", principalIds: [note.ownerId] };
}

/** 本人（或负责人替单元）更正时写的条目：人 → 仅本人；单元 → 该单元。 */
export function scopeOfOwn(subject: PrincipalRow): MemoryScope {
	return subject.kind === "unit"
		? { kind: "unit", unitId: subject.id }
		: { kind: "owner", principalIds: [subject.id] };
}

/** 各单元当前的成员（unit 范围解释为"该单元当前成员与该单元本身"）。 */
export type UnitMembers = ReadonlyMap<string, readonly string[]>;

export async function unitMembersOf(
	s: Scoped,
	unitIds: readonly string[],
): Promise<Map<string, string[]>> {
	const out = new Map<string, string[]>();
	if (unitIds.length === 0) return out;
	const rows = await s.select(
		unitMemberships,
		inArray(unitMemberships.unitId, [...new Set(unitIds)]),
	);
	for (const r of rows)
		out.set(r.unitId, [...(out.get(r.unitId) ?? []), r.principalId]);
	return out;
}

export function scopeIncludes(
	scope: MemoryScope,
	principalId: string,
	units: UnitMembers = new Map(),
): boolean {
	if (scope.kind === "tenant") return true;
	if (scope.kind === "unit")
		return (
			scope.unitId === principalId ||
			(units.get(scope.unitId ?? "") ?? []).includes(principalId)
		);
	return (scope.principalIds ?? []).includes(principalId);
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

/** 条目的可见范围含某主体（unit 范围：该单元本身与它当前的成员）。 */
function scopeHas(s: Scoped, principalId: string): SQL {
	const member = s.where(
		unitMemberships,
		sql`${unitMemberships.unitId}::text = ${memoryItems.scope}->>'unitId'`,
		eq(unitMemberships.principalId, principalId),
	);
	return sql`(${memoryItems.scope}->>'kind' = 'tenant'
		or ${memoryItems.scope}->'principalIds' @> ${JSON.stringify([principalId])}::jsonb
		or (${memoryItems.scope}->>'kind' = 'unit' and (
			${memoryItems.scope}->>'unitId' = ${principalId}
			or exists (select 1 from ${unitMemberships} where ${member}))))`;
}

/** 单元资料对某人可见：他是该单元（资料的 ownerId）的成员。 */
function unitNoteVisibleTo(s: Scoped, principalId: string): SQL {
	const member = s.where(
		unitMemberships,
		eq(unitMemberships.unitId, notes.ownerId),
		eq(unitMemberships.principalId, principalId),
	);
	return sql`(${notes.visibility} = 'unit' and exists (select 1 from ${unitMemberships} where ${member}))`;
}

/**
 * 某位查看者能用的条目与资料的条件（已带租户条件）。条目只取 active。
 * 单元分身的"本人"是单元：为本单元时看单元的全部资料；为成员办事时看 unit 与 shared 单元资料，为非成员只看 shared。
 */
export async function visibilityFilter(
	s: Scoped,
	viewer: Viewer,
): Promise<{ items: SQL; notes: SQL }> {
	const { ownerId, requesterId } = viewer;
	const ownerSees = or(
		eq(memoryItems.subjectId, ownerId),
		scopeHas(s, ownerId),
	);
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
			or(scopeHas(s, requesterId), disclosed),
		),
		notes: s.where(
			notes,
			eq(notes.ownerId, ownerId),
			or(eq(notes.visibility, "shared"), unitNoteVisibleTo(s, requesterId)),
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

/**
 * 替 requester 回答时，这条条目要不要按第三人规则处理；要的话给出须抹去姓名的人。
 * - participants：来源里有 requester 与本人以外的人；
 * - unit：requester 不是该单元成员时一律处理，抹去单元成员（本人除外）的姓名。
 */
export function redactionOf(
	item: MemoryItemRow,
	viewer: Viewer,
	units: UnitMembers,
): { people: string[] } | null {
	const { requesterId, ownerId } = viewer;
	if (requesterId === null) return null;
	if (item.scope.kind === "unit") {
		const members = units.get(item.scope.unitId ?? "") ?? [];
		return members.includes(requesterId)
			? null
			: { people: members.filter((id) => id !== ownerId) };
	}
	if (item.scope.kind !== "participants") return null;
	const others = (item.scope.principalIds ?? []).filter(
		(id) => id !== requesterId && id !== ownerId,
	);
	return others.length > 0 ? { people: others } : null;
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
	units: UnitMembers = new Map(),
): PresentedItem {
	const base = { id: item.id, category: item.category };
	const redaction = redactionOf(item, viewer, units);
	if (redaction) {
		const named = redaction.people.flatMap((id) => {
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
	else if (item.scope.kind === "unit")
		source = `${name(item.scope.unitId ?? "")}内部的记录`;
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
