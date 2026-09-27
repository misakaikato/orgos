/**
 * 执行一个提炼作业。
 *
 * - idle / compaction / task_end：取该话题自上次提炼以来的事件（消息、上报与答复、任务的开始与结果）
 *   作材料，连同同一可见范围里可能重复的已有条目交给模型；输出逐条校验后写入，可见范围按来源推导；
 * - resolution：不调模型，按答复或协商结束的事件直接写 kind=decision 条目，出处指向该事件。
 *
 * 返回写入或取代了条目的 subject（画像是否需要重建据此判断）与本次提炼到的最后一条事件。
 */
import { type Event, NegotiationStateSchema } from "@orgos/protocol";
import { asc, desc, eq, gt, inArray, isNotNull, max, sql } from "drizzle-orm";
import type { LlmClient } from "@/agent/llm-types";
import { formatNow } from "@/agent/prompt";
import {
	conversations,
	events,
	memoryItems,
	memoryJobs,
	principals,
	tasks,
	workItems,
} from "@/db/schema";
import type { PrincipalRow, Scoped } from "@/db/scope";
import { toEvent, toWorkItem } from "@/lib/serialize";
import { scopeOfConversation } from "@/memory/access";
import {
	candidateText,
	EXTRACTION_SYSTEM_PROMPT,
	extractionUserPrompt,
	type MaterialLine,
	materialText,
	validateExtraction,
} from "@/memory/extract-prompt";
import { callSystemModel } from "@/memory/model";
import type { MemoryJobRow } from "@/memory/queue";
import { writeItem } from "@/memory/store";
import { clipChars, parseJsonObject, similarity } from "@/memory/text";
import { describeProposal } from "@/services/negotiations";
import { findTopic } from "@/services/topics";
import { cardEventOf } from "@/services/work-items";

/** 一次提炼最多带多少条事件；更多的由续作业接着提炼。 */
export const EXTRACT_BATCH_EVENTS = 150;
const CANDIDATE_POOL = 200;
const CANDIDATES_SHOWN = 30;
const LINE_CHARS = 600;

export type JobOutcome = {
	subjects: string[];
	throughEventId: number | null;
	/** 还有没提炼完的事件（续作业）。 */
	more: boolean;
};

const DONE_NOTHING: JobOutcome = {
	subjects: [],
	throughEventId: null,
	more: false,
};

/** 话题的提炼进度：已完成的提炼作业到过的最后一条事件。 */
async function cursorOf(s: Scoped, topicId: string): Promise<number> {
	const [row] = await s.executor
		.select({ at: max(memoryJobs.throughEventId) })
		.from(memoryJobs)
		.where(
			s.where(
				memoryJobs,
				eq(memoryJobs.topicId, topicId),
				eq(memoryJobs.status, "done"),
				isNotNull(memoryJobs.throughEventId),
			),
		);
	return Number(row?.at ?? 0);
}

type Names = Map<string, PrincipalRow>;

async function principalsById(
	s: Scoped,
	ids: readonly string[],
): Promise<Names> {
	const rows =
		ids.length > 0
			? await s.select(principals, inArray(principals.id, [...new Set(ids)]))
			: [];
	return new Map(rows.map((r) => [r.id, r]));
}

/** 事件写成材料行；不进材料的返回 null。 */
function lineOf(
	e: Event,
	who: Names,
	goals: ReadonlyMap<string, string>,
): string | null {
	const actor = who.get(e.actorId);
	const owner = actor?.ownerId ? who.get(actor.ownerId) : undefined;
	const speaker = !actor
		? "某人"
		: actor.kind === "human"
			? `@${actor.handle} ${actor.displayName}`
			: `@${owner?.handle ?? "?"} 的代理「${actor.displayName}」`;
	const clip = (t: string) => clipChars(t, LINE_CHARS);
	switch (e.type) {
		case "message.posted":
			return `${speaker}：${clip(e.payload.text)}`;
		case "escalation.created":
			return `${speaker}把问题转给了本人：${clip(e.payload.question)}`;
		case "escalation.resolved":
			return e.payload.action === "answer"
				? `${speaker}答复了转来的问题：${clip(e.payload.text ?? "")}`
				: `${speaker}暂不答复转来的问题`;
		case "task.created":
			return `任务开始：${e.payload.title}（目标：${clip(goals.get(e.payload.taskId) ?? e.payload.title)}）`;
		case "task.ended":
			return `任务结束（${e.payload.state}）：${clip(e.payload.summary)}`;
		default:
			return null;
	}
}

export async function extractTopic(
	s: Scoped,
	job: MemoryJobRow,
	llm: LlmClient,
	now: Date,
): Promise<JobOutcome> {
	const topic = await findTopic(s, job.topicId);
	if (!topic) return DONE_NOTHING;
	const conversation = await s.first(
		conversations,
		eq(conversations.id, topic.conversationId),
	);
	if (!conversation || conversation.kind === "negotiation") return DONE_NOTHING;
	const cursor = await cursorOf(s, topic.id);
	const rows = await s.executor
		.select()
		.from(events)
		.where(s.where(events, eq(events.topicId, topic.id), gt(events.id, cursor)))
		.orderBy(asc(events.id))
		.limit(EXTRACT_BATCH_EVENTS + 1);
	const more = rows.length > EXTRACT_BATCH_EVENTS;
	const batch = rows.slice(0, EXTRACT_BATCH_EVENTS).map(toEvent);
	const last = batch.at(-1);
	if (!last) return DONE_NOTHING;

	const who = await principalsById(
		s,
		batch.map((e) => e.actorId),
	);
	for (const p of [...who.values()])
		if (p.ownerId && !who.has(p.ownerId))
			for (const [k, v] of await principalsById(s, [p.ownerId])) who.set(k, v);
	const taskIds = batch.flatMap((e) =>
		e.type === "task.created" ? [e.payload.taskId] : [],
	);
	const goals = new Map(
		taskIds.length > 0
			? (await s.select(tasks, inArray(tasks.id, taskIds))).map((t) => [
					t.id,
					t.goal,
				])
			: [],
	);
	const lines: MaterialLine[] = batch.flatMap((e) => {
		const text = lineOf(e, who, goals);
		return text
			? [
					{
						eventId: e.id,
						conversationId: conversation.id,
						topicId: topic.id,
						at: new Date(e.createdAt),
						text,
					},
				]
			: [];
	});
	const base = { subjects: [], throughEventId: last.id, more };
	if (
		!batch.some((e) => e.type === "message.posted" || e.type === "task.ended")
	)
		return base;

	const { scope, humans, units } = await scopeOfConversation(
		s,
		conversation.id,
	);
	if (humans.length === 0) return base;
	const subjectPool = [...humans, ...units];
	const material = materialText(lines);
	const pool = await s.executor
		.select()
		.from(memoryItems)
		.where(
			s.where(
				memoryItems,
				eq(memoryItems.status, "active"),
				// 只拿同一可见范围的条目作候选：别处的记忆不能借提炼流进这段交流。
				sql`${memoryItems.scope} = ${JSON.stringify(scope)}::jsonb`,
			),
		)
		.orderBy(desc(memoryItems.updatedAt))
		.limit(CANDIDATE_POOL);
	const candidates = pool
		.map((c) => ({ c, score: similarity(c.content, material) }))
		.sort((a, b) => b.score - a.score)
		.slice(0, CANDIDATES_SHOWN)
		.map((x) => x.c);
	const handleOf = (id: string) =>
		subjectPool.find((h) => h.id === id)?.handle ?? "?";
	const dmSide =
		units.length > 0 ? `与${units.map((u) => u.displayName).join("、")}` : "";
	const where =
		conversation.kind === "group"
			? `群聊“${conversation.title ?? "群聊"}”${topic.isMain ? "" : `的话题“${topic.title}”`}`
			: `${humans.map((h) => h.displayName).join("与")}${dmSide || (humans.length === 1 ? "与自己代理" : "")}的私聊${topic.isMain ? "" : `里的话题“${topic.title}”`}`;
	const { text, runId } = await callSystemModel({
		s,
		llm,
		purpose: "extract",
		trigger: `memory_job:${job.id}`,
		place: { conversationId: conversation.id, topicId: topic.id },
		system: EXTRACTION_SYSTEM_PROMPT,
		user: extractionUserPrompt({
			today: formatNow(now),
			where,
			participants: humans,
			units,
			material,
			candidates: candidateText(candidates, handleOf),
		}),
	});
	const drafts = validateExtraction(parseJsonObject(text), {
		events: new Map(
			lines.map((l) => [
				l.eventId,
				{ conversationId: l.conversationId, topicId: l.topicId },
			]),
		),
		subjects: new Map(subjectPool.map((h) => [h.handle, h])),
		candidates: new Map(candidates.map((c) => [c.id.slice(0, 8), c])),
	});
	const at = new Map(lines.map((l) => [String(l.eventId), l.at.getTime()]));
	const subjects = new Set<string>();
	await s.transaction(async (tx) => {
		for (const d of drafts) {
			// 记忆从它所依据的最后一条消息起成立。
			const latest = Math.max(...d.sources.map((x) => at.get(x.id) ?? 0));
			const row = await writeItem(tx, {
				...d,
				scope,
				createdByRunId: runId,
				validFrom: latest > 0 ? new Date(latest) : now,
			});
			if (row) subjects.add(row.subjectId);
		}
	});
	return { ...base, subjects: [...subjects] };
}

// ─────────────────────────── 答复与协商结束：直写 decision ───────────────────────────

type Decision = { subjectId: string; content: string };

async function decisionsOf(s: Scoped, event: Event): Promise<Decision[]> {
	if (event.type === "escalation.resolved") {
		if (event.payload.action !== "answer" || !event.payload.text) return [];
		const row = await s.first(
			workItems,
			eq(workItems.id, event.payload.workItemId),
		);
		if (!row) return [];
		const item = toWorkItem(row);
		const who = await s.first(principals, eq(principals.id, event.actorId));
		// 答复是替上报的那个代理的"本人"做的决定：单元分身上报的，subject 是单元。
		const card = await cardEventOf(s, item);
		const agent = card
			? await s.first(principals, eq(principals.id, card.actorId))
			: undefined;
		const subject = agent?.ownerId
			? await s.first(principals, eq(principals.id, agent.ownerId))
			: undefined;
		const forUnit = subject?.kind === "unit";
		const question =
			item.kind === "decision" ? item.payload.question : item.title;
		const answerer = `${forUnit ? `${subject.displayName}负责人` : ""}${who?.displayName ?? "本人"}`;
		return [
			{
				subjectId: forUnit ? subject.id : event.actorId,
				content: `关于“${clipChars(question, 80)}”，${answerer}的答复是：${clipChars(event.payload.text, 200)}`,
			},
		];
	}
	if (event.type === "negotiation.ended") {
		if (event.payload.outcome === "exhausted" || !event.conversationId)
			return [];
		const conv = await s.first(
			conversations,
			eq(conversations.id, event.conversationId),
		);
		const state = NegotiationStateSchema.safeParse(conv?.negotiation);
		if (!state.success) return [];
		// 协商的双方是两个分身各自的本人（人或单元）。
		const agentsOf = await s.select(
			principals,
			inArray(principals.id, [
				state.data.initiatorAgentId,
				state.data.responderAgentId,
			]),
		);
		const sideIds = agentsOf.flatMap((a) => (a.ownerId ? [a.ownerId] : []));
		const sides =
			sideIds.length > 0
				? await s.select(principals, inArray(principals.id, sideIds))
				: [];
		const goal = state.data.goal;
		const names = sides.map((p) => p.displayName).join("与");
		const content =
			event.payload.outcome === "agreed"
				? `${names}经代理协商约定：${describeProposal(event.payload.proposal)}（事由：${clipChars(goal, 60)}）`
				: `${names}关于“${clipChars(goal, 60)}”的代理协商未达成一致`;
		return sides.map((p) => ({ subjectId: p.id, content }));
	}
	return [];
}

export async function writeResolution(
	s: Scoped,
	job: MemoryJobRow,
): Promise<JobOutcome> {
	if (job.eventId === null) return DONE_NOTHING;
	const row = await s.first(events, eq(events.id, job.eventId));
	if (!row?.conversationId) return DONE_NOTHING;
	const event = toEvent(row);
	const decisions = await decisionsOf(s, event);
	const { scope } = await scopeOfConversation(s, row.conversationId);
	const workItemId =
		event.type === "escalation.resolved" ? event.payload.workItemId : null;
	const subjects: string[] = [];
	await s.transaction(async (tx) => {
		for (const d of decisions) {
			const written = await writeItem(tx, {
				subjectId: d.subjectId,
				kind: "decision",
				category: "决定与口径",
				content: d.content,
				entities: [],
				scope,
				sources: [
					{
						kind: "event",
						id: String(row.id),
						conversationId: row.conversationId ?? undefined,
						topicId: row.topicId,
					},
					...(workItemId
						? [{ kind: "work_item" as const, id: workItemId }]
						: []),
				],
				confidence: 1,
				validFrom: row.createdAt,
			});
			if (written) subjects.push(written.subjectId);
		}
	});
	return { subjects, throughEventId: null, more: false };
}
