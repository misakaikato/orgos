/**
 * 代理在会话里留下的痕迹：消息与动作。actorId 是代理主体，onBehalfOfId 是代理所属的人——
 * 代理永远不以本人名义发言。事件经 `@/services/events` 写入。
 */
import type { Event, EventPayload } from "@orgos/protocol";

type MessagePostedPayload = EventPayload<"message.posted">;

import { eq } from "drizzle-orm";
import { principals } from "@/db/schema";
import type { PrincipalRow, Scoped } from "@/db/scope";
import { notFound } from "@/lib/errors";
import { postAs, requireConversation } from "@/services/conversations";
import { transactWithEvents } from "@/services/events";
import { topicIn } from "@/services/topics";

/** 取代理主体；不存在、跨租户或不是代理 → 404。 */
export async function requireAgentPrincipal(
	s: Scoped,
	agentId: string,
): Promise<PrincipalRow & { ownerId: string }> {
	const row = await s.first(
		principals,
		eq(principals.id, agentId),
		eq(principals.kind, "agent"),
	);
	if (!row?.ownerId) throw notFound("代理不存在");
	return { ...row, ownerId: row.ownerId };
}

/** 代理留痕的位置：会话与其中的话题（缺省为主线）。 */
export type Place = { conversationId: string; topicId?: string };

/** 代理消息的附加信息：引用的记忆条目；替本人回答他人时的提问人与所答的消息；html 消息的摘要。 */
export type AgentMessageExtra = Pick<
	MessagePostedPayload,
	"citations" | "askedById" | "replyToEventId" | "summary"
>;

/** 代理发一条消息（代理须是会话成员）。代理的文字默认按 Markdown 记；html 来自 post_html、经应用接口的代发与演示数据。 */
export async function postAgentMessage(
	s: Scoped,
	agentId: string,
	place: Place,
	text: string,
	opts: {
		mentions?: string[];
		at?: Date;
		extra?: AgentMessageExtra;
		format?: "md" | "html";
	} = {},
): Promise<Event> {
	const agent = await requireAgentPrincipal(s, agentId);
	return postAs(
		s,
		agent,
		place.conversationId,
		{
			text,
			format: opts.format ?? "md",
			mentions: opts.mentions ?? [],
			...(place.topicId ? { topicId: place.topicId } : {}),
		},
		{ onBehalfOfId: agent.ownerId, at: opts.at, extra: opts.extra },
	);
}

/** 记一条代理动作（工具调用），供界面折叠显示与审计。 */
export async function recordAgentAction(
	s: Scoped,
	agentId: string,
	place: Place,
	action: { tool: string; summary: string; ok: boolean },
	at?: Date,
): Promise<Event> {
	const agent = await requireAgentPrincipal(s, agentId);
	await requireConversation(s, place.conversationId, agent.id);
	const topic = await topicIn(s, place.conversationId, place.topicId);
	return transactWithEvents(s, (_tx, append) =>
		append({
			conversationId: place.conversationId,
			topicId: topic.id,
			actorId: agent.id,
			onBehalfOfId: agent.ownerId,
			type: "agent.action",
			payload: action,
			at,
		}),
	);
}
