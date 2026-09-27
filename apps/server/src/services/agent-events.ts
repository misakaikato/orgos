/**
 * 代理在会话里留下的痕迹：消息与动作。actorId 是代理主体，onBehalfOfId 是代理所属的人——
 * 代理永远不以本人名义发言。事件经 `@/services/events` 写入。
 */
import type { Event } from "@orgos/protocol";
import { eq } from "drizzle-orm";
import { principals } from "@/db/schema";
import type { PrincipalRow, Scoped } from "@/db/scope";
import { notFound } from "@/lib/errors";
import { postAs, requireConversation } from "@/services/conversations";
import { transactWithEvents } from "@/services/events";

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

/** 代理发一条消息（代理须是会话成员）。 */
export async function postAgentMessage(
	s: Scoped,
	agentId: string,
	conversationId: string,
	text: string,
	opts: { mentions?: string[]; at?: Date } = {},
): Promise<Event> {
	const agent = await requireAgentPrincipal(s, agentId);
	return postAs(
		s,
		agent,
		conversationId,
		{ text, mentions: opts.mentions ?? [] },
		{ onBehalfOfId: agent.ownerId, at: opts.at },
	);
}

/** 记一条代理动作（工具调用），供界面折叠显示与审计。 */
export async function recordAgentAction(
	s: Scoped,
	agentId: string,
	conversationId: string,
	action: { tool: string; summary: string; ok: boolean },
	at?: Date,
): Promise<Event> {
	const agent = await requireAgentPrincipal(s, agentId);
	await requireConversation(s, conversationId, agent.id);
	return transactWithEvents(s, (_tx, append) =>
		append({
			conversationId,
			actorId: agent.id,
			onBehalfOfId: agent.ownerId,
			type: "agent.action",
			payload: action,
			at,
		}),
	);
}
