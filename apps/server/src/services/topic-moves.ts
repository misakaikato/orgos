/**
 * 话题的两种转变：转为任务（普通话题 → kind=task + tasks 行）与转成群聊（以话题为起点建新群，
 * 新群主线引用原话题、原话题标记已转出；不复制事件）。
 */
import {
	type Agent,
	type Conversation,
	ERROR_CODES,
	type Event,
	isExternalAgent,
	isTaskEnded,
	plainTextOf,
	type Task,
	type TopicSourceResponse,
} from "@orgos/protocol";
import { and, asc, desc, eq } from "drizzle-orm";
import { conversations, events } from "@/db/schema";
import type { PrincipalRow, Scoped } from "@/db/scope";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { toEvent, toPrincipal } from "@/lib/serialize";
import { findAgent } from "@/services/agents";
import {
	createGroup,
	memberPrincipals,
	postMessage,
} from "@/services/conversations";
import { transactWithEvents } from "@/services/events";
import { runningRunsIn } from "@/services/runs";
import { createTask, requireTask, transitionTask } from "@/services/tasks";
import {
	describeTopic,
	findTopic,
	markMoved,
	publishTopic,
	requireTopic,
	type TopicRow,
} from "@/services/topics";

type ConversationRow = typeof conversations.$inferSelect;

/** 会话是本人与自己某个代理的私聊时，返回那个代理。 */
export async function ownAgentOfDm(
	s: Scoped,
	me: PrincipalRow,
	conversation: ConversationRow,
): Promise<Agent | null> {
	if (conversation.kind !== "dm") return null;
	const others = [
		...(await memberPrincipals(s, conversation.id)).values(),
	].filter((p) => p.id !== me.id);
	const [only] = others;
	if (others.length !== 1 || !only || only.ownerId !== me.id) return null;
	return findAgent(s, { id: only.id });
}

function requireOwnAgentDm(agent: Agent | null): Agent {
	if (!agent) throw badRequest("只能在与自己代理的私聊里交办任务");
	return agent;
}

/** 话题里本人最后一条消息。 */
async function lastOwnMessage(
	s: Scoped,
	topicId: string,
	meId: string,
): Promise<string | null> {
	const [row] = await s.executor
		.select()
		.from(events)
		.where(
			s.where(
				events,
				eq(events.topicId, topicId),
				eq(events.type, "message.posted"),
				eq(events.actorId, meId),
			),
		)
		.orderBy(desc(events.id))
		.limit(1);
	if (!row) return null;
	const e = toEvent(row);
	return e.type === "message.posted" ? plainTextOf(e.payload) : null;
}

function taskInput(me: PrincipalRow, agent: Agent) {
	return {
		requesterId: me.id,
		assignee: { id: agent.principal.id, ownerId: me.id },
		onBehalfOfId: me.id,
		engine: agent.engine ?? ("builtin" as const),
		...(isExternalAgent(agent)
			? {
					adapter: agent.adapter ?? null,
					runnerId: agent.runnerId,
					workspace: agent.workspace ?? null,
				}
			: {}),
	};
}

/**
 * "转为任务"：只在本人与自己代理的私聊里、主线以外的话题上。目标取本人填写的，否则取该话题里
 * 本人最后一条消息。本人填了目标时它作为本人的消息发出（由调用方交给调度器，代理随即开始干活）；
 * 否则代理正在干活则任务进行中，不然等本人处理。已是进行中的任务 → 409。
 */
export async function topicToTask(
	s: Scoped,
	me: PrincipalRow,
	topicId: string,
	goal: string | undefined,
): Promise<{ task: Task; posted: Event | null }> {
	const { topic, conversation } = await requireTopic(s, me, topicId);
	if (topic.isMain) throw badRequest("主线不能转为任务，请开一个新话题");
	if (topic.taskId && !isTaskEnded((await requireTask(s, topic.taskId)).state))
		throw new AppError(
			409,
			ERROR_CODES.TASK_IN_PROGRESS,
			"这个话题已经是进行中的任务",
		);
	const agent = requireOwnAgentDm(await ownAgentOfDm(s, me, conversation));
	const fallback = goal ? null : await lastOwnMessage(s, topic.id, me.id);
	const target = goal ?? fallback;
	if (!target) throw badRequest("话题里还没有你的消息，请写下任务目标");
	const { task } = await createTask(s, {
		conversationId: conversation.id,
		topic,
		goal: target,
		...taskInput(me, agent),
	});
	if (goal) {
		const posted = await postMessage(s, me, conversation.id, {
			text: goal,
			topicId: topic.id,
		});
		return { task, posted };
	}
	const busy = (await runningRunsIn(s, topic.id)).length > 0;
	const working = await transitionTask(s, task.id, "working");
	const settled = busy
		? working
		: await transitionTask(s, task.id, "input_required");
	return { task: settled ?? working ?? task, posted: null };
}

/**
 * "新任务"：在本人与自己代理的私聊里新开一个任务话题，目标作为本人的第一条消息发出
 * （由调用方交给调度器）。
 */
export async function newTaskTopic(
	s: Scoped,
	me: PrincipalRow,
	conversation: ConversationRow,
	goal: string,
): Promise<{ task: Task; posted: Event }> {
	const agent = requireOwnAgentDm(await ownAgentOfDm(s, me, conversation));
	const { task, topic } = await createTask(s, {
		conversationId: conversation.id,
		goal,
		...taskInput(me, agent),
	});
	const posted = await postMessage(s, me, conversation.id, {
		text: goal,
		topicId: topic.id,
	});
	return { task, posted };
}

/**
 * "转成群聊"：以话题为起点建新群（标题缺省为话题名，成员照常带上各自的分身），
 * 新群主线引用原话题；原话题标记已转出并在那里落一条 `topic.moved`。
 */
export async function topicToGroup(
	s: Scoped,
	me: PrincipalRow,
	topicId: string,
	input: { title?: string; memberIds: string[] },
): Promise<Conversation> {
	const { topic } = await requireTopic(s, me, topicId);
	const title = input.title ?? topic.title;
	const { conversation } = await createGroup(s, me, title, input.memberIds, {
		sourceTopicId: topic.id,
	});
	const moved = await transactWithEvents(s, async (tx, append) => {
		const row = await markMoved(tx, topic.id, conversation.id);
		await append({
			conversationId: topic.conversationId,
			topicId: topic.id,
			actorId: me.id,
			type: "topic.moved",
			payload: { conversationId: conversation.id, title },
		});
		return row;
	});
	await publishTopic(s, moved);
	return conversation;
}

export const SOURCE_EVENTS_MAX = 500;

/**
 * 新群主线引用的原话题：只读的前置历史。`topicId` 是引用它的话题（我须是其会话成员）。
 */
export async function topicSource(
	s: Scoped,
	me: PrincipalRow,
	topicId: string,
): Promise<TopicSourceResponse> {
	const { topic } = await requireTopic(s, me, topicId);
	const source: TopicRow | undefined = topic.sourceTopicId
		? await findTopic(s, topic.sourceTopicId)
		: undefined;
	if (!source) throw notFound("这个话题没有引用别的话题");
	const conversation = await s.first(
		conversations,
		eq(conversations.id, source.conversationId),
	);
	if (!conversation) throw notFound("原会话不存在");
	const members = [...(await memberPrincipals(s, conversation.id)).values()];
	const rows = await s.executor
		.select()
		.from(events)
		.where(and(s.where(events, eq(events.topicId, source.id))))
		.orderBy(asc(events.id))
		.limit(SOURCE_EVENTS_MAX);
	const humans = members.filter((m) => m.kind === "human");
	const label =
		conversation.kind === "group"
			? `群聊“${conversation.title ?? "群聊"}”`
			: humans.length >= 2
				? `${humans.map((h) => h.displayName).join("与")}的私聊`
				: `${humans[0]?.displayName ?? ""}与${
						members.find((m) => m.kind === "agent")?.displayName ?? "代理"
					}的私聊`;
	return {
		topic: await describeTopic(s, source),
		conversationLabel: label,
		members: members.map(toPrincipal),
		events: rows.map(toEvent),
	};
}
