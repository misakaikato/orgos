/**
 * 话题：会话内一条独立的上下文，也是代理运行、外部 agent 会话与任务的边界。
 *
 * - 每个会话恰好一个主线：会话只经 `insertConversation` 建立，同一事务里建主线；
 * - 消息与事件落在哪个话题由调用方给出，缺省为主线（`topicIn`）；
 * - 任务 = 带状态的话题（kind=task）；话题的建立、改名、归档、转为任务、转出都推 `{t:'topic'}` 帧。
 */
import {
	MAIN_TOPIC_TITLE,
	type Topic,
	type TopicKind,
	type UpdateTopicRequest,
} from "@orgos/protocol";
import { and, asc, count, desc, eq, gt, inArray, ne } from "drizzle-orm";
import {
	conversationMembers,
	conversations,
	events,
	tasks,
	topics,
} from "@/db/schema";
import type { PrincipalRow, Scoped } from "@/db/scope";
import { badRequest, notFound } from "@/lib/errors";
import { toTopic } from "@/lib/serialize";
import { isUuid } from "@/lib/uuid";
import { browserHub } from "@/realtime/browser-hub";
import { requireConversation } from "@/services/conversations";

export type TopicRow = typeof topics.$inferSelect;
type ConversationRow = typeof conversations.$inferSelect;
type NewConversation = Omit<typeof conversations.$inferInsert, "tenantId">;

/** 建一个会话与它的主线。调用方负责事务（二者必须同时成立）。 */
export async function insertConversation(
	tx: Scoped,
	values: NewConversation,
): Promise<{ conversation: ConversationRow; main: TopicRow }> {
	const conversation = await tx.insert(conversations, values);
	const main = await tx.insert(topics, {
		conversationId: conversation.id,
		title: MAIN_TOPIC_TITLE,
		kind: "chat",
		isMain: true,
		createdBy: conversation.createdBy,
		createdAt: conversation.createdAt,
		lastEventAt: conversation.createdAt,
	});
	return { conversation, main };
}

/**
 * 在会话里建一个非主线话题（不校验成员身份，调用方负责）。时间取应用时钟，与事件的发生时间
 * （`appendEvent`）同一个钟，最近活动的先后才可比。
 */
export async function insertTopic(
	tx: Scoped,
	values: {
		conversationId: string;
		title: string;
		kind: TopicKind;
		createdBy: string;
		sourceTopicId?: string | null;
	},
): Promise<TopicRow> {
	const now = new Date();
	return tx.insert(topics, {
		...values,
		isMain: false,
		createdAt: now,
		lastEventAt: now,
	});
}

export async function mainTopicOf(
	s: Scoped,
	conversationId: string,
): Promise<TopicRow> {
	const row = await s.first(
		topics,
		eq(topics.conversationId, conversationId),
		eq(topics.isMain, true),
	);
	if (!row) throw new Error(`会话 ${conversationId} 没有主线`);
	return row;
}

/** 会话里的某个话题：不给 id 即主线；不存在或不属于该会话 → 404。 */
export async function topicIn(
	s: Scoped,
	conversationId: string,
	topicId?: string,
): Promise<TopicRow> {
	if (topicId === undefined) return mainTopicOf(s, conversationId);
	const row = isUuid(topicId)
		? await s.first(
				topics,
				eq(topics.id, topicId),
				eq(topics.conversationId, conversationId),
			)
		: undefined;
	if (!row) throw notFound("话题不存在");
	return row;
}

export async function findTopic(
	s: Scoped,
	topicId: string,
): Promise<TopicRow | undefined> {
	return isUuid(topicId) ? s.first(topics, eq(topics.id, topicId)) : undefined;
}

/** 我看得到的话题：我是其会话的成员（含 observer）。否则 404。 */
export async function requireTopic(
	s: Scoped,
	me: PrincipalRow,
	topicId: string,
): Promise<{ topic: TopicRow; conversation: ConversationRow }> {
	const topic = await findTopic(s, topicId);
	if (!topic) throw notFound("话题不存在");
	const { conversation } = await requireConversation(
		s,
		topic.conversationId,
		me.id,
	);
	return { topic, conversation };
}

/** 话题连同任务状态（任务话题的状态点）。 */
export async function describeTopics(
	s: Scoped,
	rows: readonly TopicRow[],
): Promise<Topic[]> {
	const taskIds = rows.flatMap((r) => (r.taskId ? [r.taskId] : []));
	const states =
		taskIds.length === 0
			? []
			: await s.executor
					.select({ id: tasks.id, state: tasks.state })
					.from(tasks)
					.where(s.where(tasks, inArray(tasks.id, taskIds)));
	const stateOf = new Map(states.map((r) => [r.id, r.state]));
	return rows.map((r) =>
		toTopic(r, r.taskId ? (stateOf.get(r.taskId) ?? null) : null),
	);
}

export async function describeTopic(s: Scoped, row: TopicRow): Promise<Topic> {
	const [topic] = await describeTopics(s, [row]);
	if (!topic) throw new Error("话题描述为空");
	return topic;
}

/** 话题变了：推给其会话的全部成员。 */
export async function publishTopic(s: Scoped, row: TopicRow): Promise<Topic> {
	const topic = await describeTopic(s, row);
	const members = await s.select(
		conversationMembers,
		eq(conversationMembers.conversationId, row.conversationId),
	);
	browserHub.sendTo(
		members.map((m) => m.principalId),
		{ t: "topic", topic },
	);
	return topic;
}

/** 会话的话题：主线在前，其余按最近活动倒序；带上各话题里我的未读数。 */
export async function listTopics(
	s: Scoped,
	me: PrincipalRow,
	conversationId: string,
): Promise<Topic[]> {
	const { conversation, membership } = await requireConversation(
		s,
		conversationId,
		me.id,
	);
	const rows = await s.executor
		.select()
		.from(topics)
		.where(s.where(topics, eq(topics.conversationId, conversation.id)))
		.orderBy(desc(topics.isMain), desc(topics.lastEventAt), asc(topics.id));
	const unread = await s.executor
		.select({ topicId: events.topicId, n: count() })
		.from(events)
		.where(
			s.where(
				events,
				eq(events.conversationId, conversation.id),
				eq(events.type, "message.posted"),
				ne(events.actorId, me.id),
				gt(events.seq, membership.lastReadSeq),
			),
		)
		.groupBy(events.topicId);
	const unreadOf = new Map(unread.map((r) => [r.topicId, r.n]));
	return (await describeTopics(s, rows)).map((t) => ({
		...t,
		unread: unreadOf.get(t.id) ?? 0,
	}));
}

/** 本人在会话里开一个新话题（"＋新话题"）。 */
export async function createTopic(
	s: Scoped,
	me: PrincipalRow,
	conversationId: string,
	title: string,
	kind: TopicKind = "chat",
): Promise<TopicRow> {
	const { conversation } = await requireConversation(s, conversationId, me.id);
	const row = await insertTopic(s, {
		conversationId: conversation.id,
		title,
		kind,
		createdBy: me.id,
	});
	await publishTopic(s, row);
	return row;
}

/** 改名或归档。主线不能改名、不能归档。 */
export async function updateTopic(
	s: Scoped,
	me: PrincipalRow,
	topicId: string,
	patch: UpdateTopicRequest,
): Promise<TopicRow> {
	const { topic } = await requireTopic(s, me, topicId);
	if (topic.isMain && (patch.title !== undefined || patch.archived))
		throw badRequest("主线不能改名或归档");
	const set: Partial<TopicRow> = {};
	if (patch.title !== undefined) set.title = patch.title;
	if (patch.archived !== undefined)
		set.archivedAt = patch.archived ? new Date() : null;
	if (Object.keys(set).length === 0) return topic;
	const [row] = await s.executor
		.update(topics)
		.set(set)
		.where(s.where(topics, eq(topics.id, topic.id)))
		.returning();
	if (!row) throw notFound("话题不存在");
	await publishTopic(s, row);
	return row;
}

/** 话题改为任务话题并指向任务（转为任务、再次交办）。调用方负责事务。 */
export async function attachTask(
	tx: Scoped,
	topicId: string,
	taskId: string,
): Promise<TopicRow> {
	const [row] = await tx.executor
		.update(topics)
		.set({ kind: "task", taskId })
		.where(tx.where(topics, eq(topics.id, topicId)))
		.returning();
	if (!row) throw notFound("话题不存在");
	return row;
}

/** 标记话题已转成群聊。 */
export async function markMoved(
	tx: Scoped,
	topicId: string,
	conversationId: string,
): Promise<TopicRow> {
	const [row] = await tx.executor
		.update(topics)
		.set({ movedToConversationId: conversationId })
		.where(tx.where(topics, eq(topics.id, topicId)))
		.returning();
	if (!row) throw notFound("话题不存在");
	return row;
}

/** 追加事件时推进话题的最近活动（事件的发生时间）；话题不属于该会话 → 404。 */
export async function touchTopic(
	tx: Scoped,
	conversationId: string,
	topicId: string,
	at: Date,
): Promise<void> {
	const [row] = await tx.executor
		.update(topics)
		.set({ lastEventAt: at })
		.where(
			and(
				tx.where(
					topics,
					eq(topics.id, topicId),
					eq(topics.conversationId, conversationId),
				),
			),
		)
		.returning({ id: topics.id });
	if (!row) throw notFound("话题不存在");
}

/** 各会话最近有活动的话题。 */
export async function latestTopics(
	s: Scoped,
	conversationIds: readonly string[],
): Promise<Map<string, TopicRow>> {
	if (conversationIds.length === 0) return new Map();
	const rows = await s.executor
		.selectDistinctOn([topics.conversationId])
		.from(topics)
		.where(
			s.where(topics, inArray(topics.conversationId, [...conversationIds])),
		)
		.orderBy(
			topics.conversationId,
			desc(topics.lastEventAt),
			desc(topics.isMain),
		);
	return new Map(rows.map((r) => [r.conversationId, r]));
}
