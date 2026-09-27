/**
 * 会话事件的唯一写入口。`events` 表只追加：此处没有、全库也不应出现更新或删除事件的路径。
 * 每条事件都落在一个话题里（调用方给出），写入同时推进该话题的最近活动。
 */
import {
	EVENT_PAYLOAD_SCHEMAS,
	type Event,
	type EventDraft,
} from "@orgos/protocol";
import { eq, inArray, sql } from "drizzle-orm";
import { conversationMembers, conversations, events } from "@/db/schema";
import type { Scoped } from "@/db/scope";
import { notFound } from "@/lib/errors";
import { toEvent } from "@/lib/serialize";
import { browserHub } from "@/realtime/browser-hub";
import { touchTopic } from "@/services/topics";

export type AppendInput = EventDraft & {
	conversationId: string;
	/** 事件所在的话题（须属于该会话）。 */
	topicId: string;
	actorId: string;
	onBehalfOfId?: string | null;
	/** 发生时间，缺省为当前时间；只在回放历史（演示数据）时指定，且须与 seq 顺序一致。 */
	at?: Date;
};

export type Append = (input: AppendInput) => Promise<Event>;

/**
 * 在事务 `tx` 内追加一条会话事件。
 *
 * seq 取自 `conversations.last_seq` 的原子自增：UPDATE 持有该会话行锁直到事务结束，
 * 并发写入按提交顺序排队，seq 在会话内连续、不重、不缺（回滚的事务不占号）。
 */
export async function appendEvent(
	tx: Scoped,
	input: AppendInput,
): Promise<Event> {
	const payload = EVENT_PAYLOAD_SCHEMAS[input.type].parse(input.payload);
	const [bumped] = await tx.executor
		.update(conversations)
		.set({ lastSeq: sql`${conversations.lastSeq} + 1` })
		.where(tx.where(conversations, eq(conversations.id, input.conversationId)))
		.returning({ lastSeq: conversations.lastSeq });
	if (!bumped) throw notFound("会话不存在");
	const at = input.at ?? new Date();
	await touchTopic(tx, input.conversationId, input.topicId, at);
	const row = await tx.insert(events, {
		conversationId: input.conversationId,
		topicId: input.topicId,
		seq: bumped.lastSeq,
		type: input.type,
		actorId: input.actorId,
		onBehalfOfId: input.onBehalfOfId ?? null,
		payload,
		createdAt: at,
	});
	return toEvent(row);
}

/**
 * 在一个事务里执行 `fn`，其中经 `append` 写入的事件在事务提交后推送给各会话的全部成员
 * （含 observer）。收件人在事务内查询，因此同一事务里新加入的成员也会收到。
 */
export async function transactWithEvents<R>(
	s: Scoped,
	fn: (tx: Scoped, append: Append) => Promise<R>,
): Promise<R> {
	const written: Event[] = [];
	const { result, recipients } = await s.transaction(async (tx) => {
		const result = await fn(tx, async (input) => {
			const event = await appendEvent(tx, input);
			written.push(event);
			return event;
		});
		return { result, recipients: await recipientsOf(tx, written) };
	});
	for (const event of written) {
		if (!event.conversationId) continue;
		browserHub.sendTo(recipients.get(event.conversationId) ?? [], {
			t: "event",
			event,
		});
	}
	return result;
}

async function recipientsOf(
	tx: Scoped,
	written: Event[],
): Promise<Map<string, string[]>> {
	const ids = [
		...new Set(
			written.flatMap((e) => (e.conversationId ? [e.conversationId] : [])),
		),
	];
	const byConversation = new Map<string, string[]>();
	if (ids.length === 0) return byConversation;
	const rows = await tx.select(
		conversationMembers,
		inArray(conversationMembers.conversationId, ids),
	);
	for (const r of rows) {
		const list = byConversation.get(r.conversationId) ?? [];
		list.push(r.principalId);
		byConversation.set(r.conversationId, list);
	}
	return byConversation;
}
