/**
 * 本人对记忆的控制：浏览、搜索、编辑、撤回自己的条目；看出处；代答记录（分身替本人对他人的回答）
 * 上的"不对"（本人更正并取代被引用的条目）与"不许对外说"（撤回或改成不对外的类别）。
 *
 * "自己的条目" = subject 是本人。别人的条目本人改不了：被引用的若不是本人的，更正照写，但不取代它。
 * "本人"也可以是单元：负责人经 `?unitId=` 以同一套函数管理单元的条目与单元分身的代答记录（路由层校验负责人）。
 */
import type {
	AnswerActionResponse,
	CorrectAnswerRequest,
	Event,
	MemoryItemsQuery,
	MemorySourceLink,
	MemoryStatus,
	TwinAnswer,
	UpdateMemoryItemRequest,
	WithholdAnswerRequest,
} from "@orgos/protocol";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getLlmClient } from "@/agent/llm";
import {
	conversationMembers,
	conversations,
	events,
	memoryItems,
	principals,
} from "@/db/schema";
import type { PrincipalRow, Scoped } from "@/db/scope";
import { badRequest, notFound } from "@/lib/errors";
import { toEvent } from "@/lib/serialize";
import { isUuid } from "@/lib/uuid";
import {
	allowedCategories,
	type MemoryItemRow,
	scopeOfOwn,
} from "@/memory/access";
import { rebuildProfile } from "@/memory/profiles";
import {
	editItem,
	ownItem,
	retractItems,
	toMemoryItem,
	writeItem,
} from "@/memory/store";
import { coverage, termSet } from "@/memory/text";

const OWN_LIST_LIMIT = 300;
const ANSWER_LIST_LIMIT = 100;

/** 条目变了：在后台重建此人的画像（失败只记日志）。 */
export function requestProfileRebuild(s: Scoped, subjectId: string): void {
	rebuildProfile(s, subjectId, getLlmClient(), new Date()).catch((e) =>
		console.error("[memory] 画像重建失败", e),
	);
}

export async function listOwnItems(
	s: Scoped,
	me: PrincipalRow,
	query: MemoryItemsQuery,
) {
	const rows = await s.executor
		.select()
		.from(memoryItems)
		.where(
			s.where(
				memoryItems,
				eq(memoryItems.subjectId, me.id),
				query.status ? eq(memoryItems.status, query.status) : undefined,
			),
		)
		.orderBy(desc(memoryItems.updatedAt))
		.limit(OWN_LIST_LIMIT);
	const q = query.q ? termSet(query.q) : null;
	const hits = q
		? rows
				.map((r) => ({ r, score: coverage(q, `${r.content} ${r.category}`) }))
				.filter((x) => x.score > 0)
				.sort((a, b) => b.score - a.score)
				.map((x) => x.r)
		: rows;
	return hits.map(toMemoryItem);
}

async function requireOwn(
	s: Scoped,
	me: PrincipalRow,
	itemId: string,
): Promise<MemoryItemRow> {
	const row = isUuid(itemId) ? await ownItem(s, me.id, itemId) : undefined;
	if (!row) throw notFound("记忆不存在");
	return row;
}

export async function updateOwnItem(
	s: Scoped,
	me: PrincipalRow,
	itemId: string,
	patch: UpdateMemoryItemRequest,
) {
	const row = await requireOwn(s, me, itemId);
	if (row.status !== "active") throw badRequest("只能编辑仍在用的记忆");
	const next = await editItem(s, row.id, patch);
	if (!next) throw notFound("记忆不存在");
	requestProfileRebuild(s, me.id);
	return toMemoryItem(next);
}

export async function retractOwnItem(
	s: Scoped,
	me: PrincipalRow,
	itemId: string,
) {
	const row = await requireOwn(s, me, itemId);
	const [next] = await retractItems(s, [row.id]);
	requestProfileRebuild(s, me.id);
	return toMemoryItem(next ?? row);
}

/** 会话的称呼（群名，或私聊里除我以外的人）。 */
async function conversationLabel(
	s: Scoped,
	conversationId: string,
	meId: string,
): Promise<string> {
	const conv = await s.first(
		conversations,
		eq(conversations.id, conversationId),
	);
	if (conv?.kind === "group") return `群聊“${conv.title ?? "群聊"}”`;
	if (conv?.kind === "negotiation") return "代理协商";
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
	const others = rows.map((r) => r.p).filter((p) => p.id !== meId);
	return others.length > 0
		? `与${others.map((p) => p.displayName).join("、")}的私聊`
		: "与代理的私聊";
}

/** 条目出处里我看得到的原消息：只列我是成员的会话里的事件。 */
export async function sourceLinks(
	s: Scoped,
	me: PrincipalRow,
	itemId: string,
): Promise<MemorySourceLink[]> {
	const item = isUuid(itemId)
		? await s.first(memoryItems, eq(memoryItems.id, itemId))
		: undefined;
	if (!item) throw notFound("记忆不存在");
	const ids = item.sources.flatMap((x) =>
		x.kind === "event" && /^\d+$/.test(x.id) ? [Number(x.id)] : [],
	);
	if (ids.length === 0) return [];
	const rows = await s.executor
		.select({ e: events })
		.from(events)
		.innerJoin(
			conversationMembers,
			and(
				eq(conversationMembers.conversationId, events.conversationId),
				eq(conversationMembers.principalId, me.id),
			),
		)
		.where(
			and(
				s.where(events, inArray(events.id, ids)),
				s.where(conversationMembers),
			),
		);
	const links: MemorySourceLink[] = [];
	for (const { e } of rows) {
		if (!e.conversationId || e.seq === null) continue;
		links.push({
			conversationId: e.conversationId,
			topicId: e.topicId,
			seq: e.seq,
			label: await conversationLabel(s, e.conversationId, me.id),
		});
	}
	return links;
}

// ─────────────────────────── 代答记录 ───────────────────────────

type AnswerEvent = Extract<Event, { type: "message.posted" }>;

async function myAgentIds(s: Scoped, me: PrincipalRow): Promise<string[]> {
	const rows = await s.select(
		principals,
		eq(principals.ownerId, me.id),
		eq(principals.kind, "agent"),
	);
	return rows.map((r) => r.id);
}

/** 本人已经"不对"过的回答（本人更正的条目以回答为出处）。 */
async function correctionsOf(
	s: Scoped,
	me: PrincipalRow,
): Promise<Set<number>> {
	const rows = await s.select(
		memoryItems,
		eq(memoryItems.subjectId, me.id),
		eq(memoryItems.ownerCorrected, true),
	);
	const out = new Set<number>();
	for (const r of rows)
		for (const src of r.sources)
			if (src.kind === "event") out.add(Number(src.id));
	return out;
}

/** 分身（与助手）替本人对他人的全部回答，最近的在前。 */
export async function listTwinAnswers(
	s: Scoped,
	me: PrincipalRow,
): Promise<TwinAnswer[]> {
	const agentIds = await myAgentIds(s, me);
	if (agentIds.length === 0) return [];
	const rows = await s.executor
		.select()
		.from(events)
		.where(
			s.where(
				events,
				inArray(events.actorId, agentIds),
				eq(events.type, "message.posted"),
				isNotNull(sql`${events.payload}->>'askedById'`),
			),
		)
		.orderBy(desc(events.id))
		.limit(ANSWER_LIST_LIMIT);
	const answers = rows
		.map(toEvent)
		.filter((e): e is AnswerEvent => e.type === "message.posted");
	const questionIds = answers.flatMap((a) =>
		a.payload.replyToEventId !== undefined ? [a.payload.replyToEventId] : [],
	);
	const questions = new Map(
		questionIds.length > 0
			? (await s.select(events, inArray(events.id, questionIds))).map((r) => [
					r.id,
					toEvent(r),
				])
			: [],
	);
	const citedIds = [
		...new Set(
			answers.flatMap((a) => (a.payload.citations ?? []).map((c) => c.id)),
		),
	];
	const cited = new Map(
		citedIds.length > 0
			? (await s.select(memoryItems, inArray(memoryItems.id, citedIds))).map(
					(r) => [r.id, r],
				)
			: [],
	);
	const corrected = await correctionsOf(s, me);
	const allowed = new Set(await allowedCategories(s, me.id));
	return answers.flatMap((a) => {
		if (!a.payload.askedById || !a.conversationId) return [];
		const citedStatus: Record<string, MemoryStatus> = {};
		const mine: MemoryItemRow[] = [];
		for (const c of a.payload.citations ?? []) {
			const row = cited.get(c.id);
			if (!row) continue;
			citedStatus[c.id] = row.status;
			if (row.subjectId === me.id) mine.push(row);
		}
		const withheld =
			mine.length > 0 &&
			mine.every((r) => r.status === "retracted" || !allowed.has(r.category));
		return [
			{
				answer: a,
				question:
					a.payload.replyToEventId !== undefined
						? (questions.get(a.payload.replyToEventId) ?? null)
						: null,
				askedById: a.payload.askedById,
				conversationId: a.conversationId,
				citedStatus,
				ownCited: mine.map((r) => r.id),
				handled: corrected.has(a.id)
					? "corrected"
					: withheld
						? "withheld"
						: null,
			},
		];
	});
}

async function requireAnswer(
	s: Scoped,
	me: PrincipalRow,
	eventId: string,
): Promise<{ answer: AnswerEvent; mine: MemoryItemRow[] }> {
	const id = Number(eventId);
	const row = Number.isSafeInteger(id)
		? await s.first(events, eq(events.id, id))
		: undefined;
	const event = row ? toEvent(row) : null;
	const agentIds = await myAgentIds(s, me);
	if (
		event?.type !== "message.posted" ||
		!event.payload.askedById ||
		!agentIds.includes(event.actorId)
	)
		throw notFound("代答记录不存在");
	const citedIds = (event.payload.citations ?? []).map((c) => c.id);
	const mine =
		citedIds.length > 0
			? await s.select(
					memoryItems,
					inArray(memoryItems.id, citedIds),
					eq(memoryItems.subjectId, me.id),
				)
			: [];
	return { answer: event, mine };
}

/**
 * "不对"：写一条本人更正的条目（subject 本人、仅本人可见范围、类别沿用被引用的本人条目），
 * 取代被引用的本人条目（给了 replaces 时只取代其中这些）；出处为这条回答。
 */
export async function correctAnswer(
	s: Scoped,
	me: PrincipalRow,
	eventId: string,
	req: CorrectAnswerRequest,
): Promise<AnswerActionResponse> {
	const { answer, mine } = await requireAnswer(s, me, eventId);
	if (req.replaces?.some((id) => !mine.some((r) => r.id === id)))
		throw badRequest("只能取代这次回答引用的你本人的记忆");
	const active = mine.filter(
		(r) =>
			r.status === "active" && (!req.replaces || req.replaces.includes(r.id)),
	);
	const category =
		req.category ?? active[0]?.category ?? mine[0]?.category ?? "决定与口径";
	const entities = new Map(
		active.flatMap((r) => r.entities).map((e) => [`${e.type}:${e.name}`, e]),
	);
	const written = await s.transaction((tx) =>
		writeItem(tx, {
			subjectId: me.id,
			kind: active[0]?.kind ?? "fact",
			category,
			content: req.text,
			entities: [...entities.values()],
			scope: scopeOfOwn(me),
			sources: [
				{
					kind: "event",
					id: String(answer.id),
					...(answer.conversationId
						? { conversationId: answer.conversationId }
						: {}),
					...(answer.topicId ? { topicId: answer.topicId } : {}),
				},
			],
			confidence: 1,
			ownerCorrected: true,
			supersedes: active.map((r) => r.id),
		}),
	);
	if (!written) throw badRequest("更正内容为空");
	requestProfileRebuild(s, me.id);
	const touched = await s.select(
		memoryItems,
		inArray(memoryItems.id, [written.id, ...active.map((r) => r.id)]),
	);
	const first = touched.find((r) => r.id === written.id) ?? written;
	return {
		items: [first, ...touched.filter((r) => r.id !== written.id)].map(
			toMemoryItem,
		),
	};
}

/** "不许对外说"：被引用的本人条目撤回，或改成一个本人不对外的类别。 */
export async function withholdAnswer(
	s: Scoped,
	me: PrincipalRow,
	eventId: string,
	req: WithholdAnswerRequest,
): Promise<AnswerActionResponse> {
	const { mine } = await requireAnswer(s, me, eventId);
	const active = mine.filter((r) => r.status === "active");
	if (active.length === 0)
		throw badRequest("这条回答没有引用你本人仍在用的记忆");
	let changed: MemoryItemRow[];
	if (req.mode === "retract")
		changed = await retractItems(
			s,
			active.map((r) => r.id),
		);
	else {
		if ((await allowedCategories(s, me.id)).includes(req.category))
			throw badRequest("这个类别目前允许对外，请选一个不对外的类别");
		changed = [];
		for (const r of active) {
			const next = await editItem(s, r.id, { category: req.category });
			if (next) changed.push(next);
		}
	}
	requestProfileRebuild(s, me.id);
	return { items: changed.map(toMemoryItem) };
}
