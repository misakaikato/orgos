/**
 * 画像（第 2 层）：把某人的 active 条目整理成"当前状态"页——负责什么 / 在推进什么 / 最近定了什么 / 协作偏好。
 *
 * 按段生成，每段记下所依据的条目：检索时一段只有在查看者看得到它的全部条目时才拼接（`visibleSections`），
 * 条目撤回或被取代后，含它的段落自然不再给出。
 *
 * 何时重建：还没有画像且 active 条目 ≥10；或自上次整理以来新增或变更 ≥10 条；或有条目被撤回；
 * 或距上次整理超过一天且其间有变化。
 */
import { and, desc, eq, sql } from "drizzle-orm";
import type { LlmClient } from "@/agent/llm-types";
import {
	type MemoryProfileSection,
	memoryItems,
	memoryProfiles,
	principals,
} from "@/db/schema";
import type { Scoped } from "@/db/scope";
import { thirdParties, type Viewer, visibleItems } from "@/memory/access";
import { callSystemModel } from "@/memory/model";
import { clipChars, parseJsonObject, scrubSecrets } from "@/memory/text";

export const PROFILE_HEADINGS = [
	"负责什么",
	"在推进什么",
	"最近定了什么",
	"协作偏好",
] as const;
export const PROFILE_REBUILD_CHANGES = 10;
export const PROFILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PROFILE_ITEMS = 60;
const SECTION_CHARS = 200;

export type ProfileRow = typeof memoryProfiles.$inferSelect;

type Stat = {
	subjectId: string;
	active: number;
	changed: number;
	retracted: number;
	builtAt: Date | null;
};

async function subjectStats(s: Scoped): Promise<Stat[]> {
	const rows = await s.executor
		.select({
			subjectId: memoryItems.subjectId,
			active: sql<string>`count(*) filter (where ${memoryItems.status} = 'active')`,
			changed: sql<string>`count(*) filter (where ${memoryProfiles.builtAt} is null or ${memoryItems.updatedAt} > ${memoryProfiles.builtAt})`,
			retracted: sql<string>`count(*) filter (where ${memoryItems.status} = 'retracted' and ${memoryItems.updatedAt} > ${memoryProfiles.builtAt})`,
			builtAt: sql<Date | null>`max(${memoryProfiles.builtAt})`,
		})
		.from(memoryItems)
		.leftJoin(
			memoryProfiles,
			and(
				eq(memoryProfiles.subjectId, memoryItems.subjectId),
				eq(memoryProfiles.subjectKind, "person"),
			),
		)
		.where(s.where(memoryItems))
		.groupBy(memoryItems.subjectId);
	return rows.map((r) => ({
		subjectId: r.subjectId,
		active: Number(r.active),
		changed: Number(r.changed),
		retracted: Number(r.retracted),
		builtAt: r.builtAt ? new Date(r.builtAt) : null,
	}));
}

export function profileDue(stat: Stat, now: Date): boolean {
	if (!stat.builtAt) return stat.active >= PROFILE_REBUILD_CHANGES;
	return (
		stat.changed >= PROFILE_REBUILD_CHANGES ||
		stat.retracted > 0 ||
		(now.getTime() - stat.builtAt.getTime() >= PROFILE_MAX_AGE_MS &&
			stat.changed > 0)
	);
}

export const PROFILE_SYSTEM_PROMPT = [
	"你在为一个办公系统整理某位同事的“当前状态”画像，材料是关于他/她的记忆条目。",
	`按这四个小标题组织：${PROFILE_HEADINGS.join("、")}。每个小标题下写一到多段，每段一两句，只用材料里有的内容，不要编造。`,
	"每段必须列出它依据的条目编号（[M:ab12cd34] 写 ab12cd34）；一段只概括少数几条相关的条目，便于按条目裁剪。",
	'只输出一个 JSON 对象：{"sections":[{"heading":"在推进什么","text":"……","itemIds":["ab12cd34"]}]}',
].join("\n");

function validSections(
	raw: unknown,
	ids: ReadonlyMap<string, string>,
): MemoryProfileSection[] {
	const list =
		raw && typeof raw === "object"
			? (raw as { sections?: unknown }).sections
			: undefined;
	if (!Array.isArray(list)) return [];
	const out: MemoryProfileSection[] = [];
	for (const x of list) {
		if (!x || typeof x !== "object") continue;
		const o = x as Record<string, unknown>;
		// 小标题与编号容忍常见写法（"## 在推进什么："、"[M:ab12cd34]"）。
		const heading = PROFILE_HEADINGS.find(
			(h) => typeof o.heading === "string" && o.heading.includes(h),
		);
		const text =
			typeof o.text === "string"
				? clipChars(scrubSecrets(o.text), SECTION_CHARS)
				: "";
		if (!heading || !text) continue;
		const itemIds = (Array.isArray(o.itemIds) ? o.itemIds : []).flatMap((v) => {
			const short =
				typeof v === "string" ? /[0-9a-f]{8}/.exec(v)?.[0] : undefined;
			const full = short ? ids.get(short) : undefined;
			return full ? [full] : [];
		});
		if (itemIds.length > 0)
			out.push({ heading, text, itemIds: [...new Set(itemIds)] });
	}
	return out;
}

export function profileMarkdown(sections: readonly MemoryProfileSection[]) {
	return PROFILE_HEADINGS.flatMap((h) => {
		const parts = sections.filter((x) => x.heading === h);
		return parts.length > 0 ? [`## ${h}`, ...parts.map((p) => p.text), ""] : [];
	})
		.join("\n")
		.trim();
}

/** 重建某人的画像（没有可整理的条目时画像为空）。 */
export async function rebuildProfile(
	s: Scoped,
	subjectId: string,
	llm: LlmClient,
	now: Date,
): Promise<ProfileRow | null> {
	const person = await s.first(principals, eq(principals.id, subjectId));
	const items = await s.executor
		.select()
		.from(memoryItems)
		.where(
			s.where(
				memoryItems,
				eq(memoryItems.subjectId, subjectId),
				eq(memoryItems.status, "active"),
			),
		)
		.orderBy(desc(memoryItems.updatedAt))
		.limit(PROFILE_ITEMS);
	let sections: MemoryProfileSection[] = [];
	if (items.length > 0) {
		const { text } = await callSystemModel({
			s,
			llm,
			purpose: "profile",
			trigger: `memory_profile:${subjectId}`,
			system: PROFILE_SYSTEM_PROMPT,
			user: [
				`画像对象：${person?.displayName ?? "同事"}`,
				"记忆条目：",
				...items.map(
					(i) =>
						`[M:${i.id.slice(0, 8)}] (${i.kind}｜${i.category}) ${i.content}`,
				),
			].join("\n"),
		});
		sections = validSections(
			parseJsonObject(text),
			new Map(items.map((i) => [i.id.slice(0, 8), i.id])),
		);
	}
	const values = {
		content: profileMarkdown(sections),
		itemIds: [...new Set(sections.flatMap((x) => x.itemIds))],
		sections,
		builtAt: now,
	};
	const existing = await s.first(
		memoryProfiles,
		eq(memoryProfiles.subjectId, subjectId),
		eq(memoryProfiles.subjectKind, "person"),
	);
	if (existing) {
		const [row] = await s.executor
			.update(memoryProfiles)
			.set(values)
			.where(s.where(memoryProfiles, eq(memoryProfiles.id, existing.id)))
			.returning();
		return row ?? null;
	}
	return s.insert(memoryProfiles, {
		subjectId,
		subjectKind: "person",
		...values,
	});
}

/** 该重建的画像逐个重建（单租户串行）；返回重建的个数。 */
export async function rebuildDueProfiles(
	s: Scoped,
	llm: LlmClient,
	now: Date,
): Promise<number> {
	let n = 0;
	for (const stat of await subjectStats(s))
		if (profileDue(stat, now)) {
			await rebuildProfile(s, stat.subjectId, llm, now);
			n += 1;
		}
	return n;
}

/**
 * 某人画像里查看者看得到的段落：段落依据的条目须全部可见（且仍 active），
 * 并且没有一条需要按第三人规则处理（段落文字可能带着第三人）。
 */
export async function visibleSections(
	s: Scoped,
	subjectId: string,
	viewer: Viewer,
): Promise<MemoryProfileSection[]> {
	const profile = await s.first(
		memoryProfiles,
		eq(memoryProfiles.subjectId, subjectId),
		eq(memoryProfiles.subjectKind, "person"),
	);
	if (!profile) return [];
	const usable = new Set(
		(await visibleItems(s, viewer, profile.itemIds))
			.filter((i) => thirdParties(i, viewer).length === 0)
			.map((i) => i.id),
	);
	return profile.sections.filter((x) =>
		x.itemIds.every((id) => usable.has(id)),
	);
}
