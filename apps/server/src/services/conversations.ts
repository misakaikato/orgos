/**
 * 会话、成员、消息与已读。所有查询经 `scoped()`；事件经 `@/services/events` 写入。
 */
import type {
	Conversation,
	ConversationSummary,
	Event,
	EventsQuery,
	PostMessageRequest,
} from "@orgos/protocol";
import { ERROR_CODES } from "@orgos/protocol";
import { and, asc, count, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { isHumanPairDm, type TriggerConversation } from "@/agent/triggers";
import {
	agents,
	conversationMembers,
	conversations,
	events,
	principals,
} from "@/db/schema";
import type { PrincipalRow, Scoped } from "@/db/scope";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { toConversation, toEvent, toPrincipal } from "@/lib/serialize";
import { isUuid } from "@/lib/uuid";
import { requireTwinOf } from "@/services/agents";
import { transactWithEvents } from "@/services/events";

type ConversationRow = typeof conversations.$inferSelect;
type MembershipRow = typeof conversationMembers.$inferSelect;

/**
 * 取会话并确认 `principalId` 是其成员（含 observer）。
 * 不存在、跨租户、非成员、id 不是 uuid 一律 404，不泄露存在性。
 */
export async function requireConversation(
	s: Scoped,
	conversationId: string,
	principalId: string,
): Promise<{ conversation: ConversationRow; membership: MembershipRow }> {
	if (!isUuid(conversationId)) throw notFound("会话不存在");
	const [row] = await s.executor
		.select({ conversation: conversations, membership: conversationMembers })
		.from(conversationMembers)
		.innerJoin(
			conversations,
			eq(conversations.id, conversationMembers.conversationId),
		)
		.where(
			and(
				s.where(
					conversationMembers,
					eq(conversationMembers.conversationId, conversationId),
					eq(conversationMembers.principalId, principalId),
				),
				s.where(conversations),
			),
		)
		.limit(1);
	if (!row) throw notFound("会话不存在");
	return row;
}

/**
 * 我能否把 `targetId` 拉进群：同租户的任何人、我自己的任何代理、他人的分身。
 * 不存在或跨租户 → 404；是我自己 → 400；他人的助手 → 400 AGENT_NOT_REACHABLE。
 */
async function requireGroupReachable(
	s: Scoped,
	me: PrincipalRow,
	targetId: string,
): Promise<PrincipalRow> {
	const target = await requireSomeoneElse(s, me, targetId);
	if (target.kind === "agent" && target.ownerId !== me.id) {
		const agent = await s.first(agents, eq(agents.principalId, target.id));
		if (agent?.role !== "front") {
			throw new AppError(
				400,
				ERROR_CODES.AGENT_NOT_REACHABLE,
				"别人的助手只替本人办事，只能拉入对方的分身",
			);
		}
	}
	return target;
}

async function requireSomeoneElse(
	s: Scoped,
	me: PrincipalRow,
	targetId: string,
): Promise<PrincipalRow> {
	const target = await s.first(principals, eq(principals.id, targetId));
	if (!target) throw notFound("找不到此人");
	if (target.id === me.id) throw badRequest("不能和自己建会话");
	if (
		target.kind === "agent" &&
		!(await s.first(agents, eq(agents.principalId, target.id)))
	) {
		throw notFound("代理不存在");
	}
	return target;
}

/**
 * 私聊的成员：和同事私聊时是两人加双方的分身；和自己的代理私聊时是我与该代理。
 * 别人的任何代理不能单独私聊 → 400 AGENT_NOT_REACHABLE。
 */
async function dmMembersWith(
	s: Scoped,
	me: PrincipalRow,
	withPrincipalId: string,
): Promise<{ target: PrincipalRow; memberIds: string[] }> {
	const target = await requireSomeoneElse(s, me, withPrincipalId);
	if (target.kind === "agent") {
		if (target.ownerId !== me.id) {
			throw new AppError(
				400,
				ERROR_CODES.AGENT_NOT_REACHABLE,
				"找别人的分身，请在与他本人的私聊里点名或切到“问分身”",
			);
		}
		return { target, memberIds: [me.id, target.id] };
	}
	const [myTwin, theirTwin] = await Promise.all([
		requireTwinOf(s, me.id),
		requireTwinOf(s, target.id),
	]);
	return { target, memberIds: [me.id, target.id, myTwin.id, theirTwin.id] };
}

/**
 * 与某主体的私聊；已有时返回已有的（created=false）。
 * 两个真人的私聊在同一事务里加入双方的分身。
 */
export async function openDm(
	s: Scoped,
	me: PrincipalRow,
	withPrincipalId: string,
): Promise<{ conversation: Conversation; created: boolean }> {
	const { target, memberIds } = await dmMembersWith(s, me, withPrincipalId);
	return s.transaction(async (tx) => {
		// 同一对主体的建私聊串行化，防止并发请求各建一个。
		const pair = [me.id, target.id].sort().join(":");
		await tx.executor.execute(
			sql`select pg_advisory_xact_lock(hashtext(${`dm:${tx.tenantId}:${pair}`}))`,
		);
		const existing = await findDm(tx, memberIds);
		if (existing) {
			return { conversation: toConversation(existing), created: false };
		}
		const conversation = await tx.insert(conversations, {
			kind: "dm",
			title: null,
			createdBy: me.id,
		});
		for (const principalId of memberIds) {
			await tx.insert(conversationMembers, {
				conversationId: conversation.id,
				principalId,
				role: "member",
			});
		}
		return { conversation: toConversation(conversation), created: true };
	});
}

/** 成员恰好是 `memberIds`（前两位是私聊的双方）的私聊。 */
async function findDm(
	tx: Scoped,
	memberIds: string[],
): Promise<ConversationRow | undefined> {
	const [a, b] = memberIds;
	if (!a || !b) return undefined;
	const other = alias(conversationMembers, "other_member");
	const candidates = await tx.executor
		.select({ conversation: conversations })
		.from(conversationMembers)
		.innerJoin(
			other,
			eq(other.conversationId, conversationMembers.conversationId),
		)
		.innerJoin(
			conversations,
			eq(conversations.id, conversationMembers.conversationId),
		)
		.where(
			and(
				tx.where(
					conversationMembers,
					eq(conversationMembers.principalId, a),
					eq(conversationMembers.role, "member"),
				),
				tx.where(other, eq(other.principalId, b), eq(other.role, "member")),
				tx.where(conversations, eq(conversations.kind, "dm")),
			),
		);
	if (candidates.length === 0) return undefined;
	const rows = await tx.select(
		conversationMembers,
		inArray(
			conversationMembers.conversationId,
			candidates.map((c) => c.conversation.id),
		),
	);
	const wanted = [...memberIds].sort().join(",");
	return candidates.find(
		({ conversation }) =>
			rows
				.filter((r) => r.conversationId === conversation.id)
				.map((r) => r.principalId)
				.sort()
				.join(",") === wanted,
	)?.conversation;
}

/** 会话全部成员（含 observer）的主体，按 id 索引。 */
export async function memberPrincipals(
	s: Scoped,
	conversationId: string,
): Promise<Map<string, PrincipalRow>> {
	const rows = await s.executor
		.select({ principal: principals })
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
	return new Map(rows.map((r) => [r.principal.id, r.principal]));
}

/**
 * 会话成员连同判定"谁该回应"所需的身份信息，按入群顺序。
 * 已删除的代理（没有 agents 行）不参与判定。
 */
export async function triggerConversationOf(
	s: Scoped,
	conversation: ConversationRow,
): Promise<TriggerConversation> {
	const rows = await s.executor
		.select({
			principal: principals,
			role: conversationMembers.role,
			agentRole: agents.role,
		})
		.from(conversationMembers)
		.innerJoin(principals, eq(principals.id, conversationMembers.principalId))
		.leftJoin(agents, eq(agents.principalId, principals.id))
		.where(
			and(
				s.where(
					conversationMembers,
					eq(conversationMembers.conversationId, conversation.id),
				),
				s.where(principals),
			),
		)
		.orderBy(asc(conversationMembers.joinedAt), asc(principals.createdAt));
	return {
		kind: conversation.kind,
		members: rows
			.filter((r) => r.principal.kind === "human" || r.agentRole !== null)
			.map((r) => ({
				id: r.principal.id,
				kind: r.principal.kind,
				ownerId: r.principal.ownerId,
				agentRole: r.agentRole,
				status: r.principal.kind === "human" ? r.principal.status : null,
				role: r.role,
			})),
	};
}

/**
 * 建群：我与 memberIds 为成员；每位被拉入者落一条 member.joined。
 * `at` 只在回放历史（演示数据）时指定。
 */
export async function createGroup(
	s: Scoped,
	me: PrincipalRow,
	title: string,
	memberIds: string[],
	at?: Date,
): Promise<Conversation> {
	const invited: PrincipalRow[] = [];
	for (const id of new Set(memberIds)) {
		if (id === me.id) continue;
		invited.push(await requireGroupReachable(s, me, id));
	}
	return transactWithEvents(s, async (tx, append) => {
		const created = await tx.insert(conversations, {
			kind: "group",
			title,
			createdBy: me.id,
			...(at ? { createdAt: at } : {}),
		});
		for (const p of [me, ...invited]) {
			await tx.insert(conversationMembers, {
				conversationId: created.id,
				principalId: p.id,
				role: "member",
			});
		}
		for (const p of invited) {
			await append({
				conversationId: created.id,
				actorId: me.id,
				type: "member.joined",
				payload: { principalId: p.id },
				at,
			});
		}
		const fresh = await tx.first(
			conversations,
			eq(conversations.id, created.id),
		);
		if (!fresh) throw new Error("群聊写入后读不到");
		return toConversation(fresh);
	});
}

/** 往群里加一个成员；只有群聊可以加人，已在群里 → 409。 */
export async function addMember(
	s: Scoped,
	me: PrincipalRow,
	conversationId: string,
	principalId: string,
): Promise<void> {
	const { conversation } = await requireConversation(s, conversationId, me.id);
	if (conversation.kind !== "group") throw badRequest("只有群聊可以加成员");
	const target = await requireGroupReachable(s, me, principalId);
	const already = await s.first(
		conversationMembers,
		eq(conversationMembers.conversationId, conversation.id),
		eq(conversationMembers.principalId, target.id),
	);
	if (already) {
		throw new AppError(409, ERROR_CODES.ALREADY_MEMBER, "已经在会话里了");
	}
	await transactWithEvents(s, async (tx, append) => {
		await tx.insert(conversationMembers, {
			conversationId: conversation.id,
			principalId: target.id,
			role: "member",
		});
		await append({
			conversationId: conversation.id,
			actorId: me.id,
			type: "member.joined",
			payload: { principalId: target.id },
		});
	});
}

/**
 * 以 `actor` 的身份发一条消息。人发的由 `postMessage` 进来；代理发的由
 * `@/services/agent-events` 进来并带上 onBehalfOfId（代理所属的人）。
 */
export async function postAs(
	s: Scoped,
	actor: PrincipalRow,
	conversationId: string,
	req: PostMessageRequest,
	opts: { onBehalfOfId?: string | null; at?: Date } = {},
): Promise<Event> {
	const { conversation } = await requireConversation(
		s,
		conversationId,
		actor.id,
	);
	const mentions = [...new Set(req.mentions ?? [])];
	if (
		req.askTwin &&
		!isHumanPairDm(await triggerConversationOf(s, conversation))
	) {
		throw badRequest("“问分身”只能在两个人的私聊里使用");
	}
	if (mentions.length > 0) {
		const rows = await s.select(
			conversationMembers,
			eq(conversationMembers.conversationId, conversation.id),
			inArray(conversationMembers.principalId, mentions),
		);
		if (rows.length !== mentions.length) {
			throw badRequest("只能 @ 会话里的成员");
		}
	}
	return transactWithEvents(s, (_tx, append) =>
		append({
			conversationId: conversation.id,
			actorId: actor.id,
			onBehalfOfId: opts.onBehalfOfId ?? null,
			type: "message.posted",
			payload: {
				text: req.text,
				mentions,
				...(req.askTwin ? { askTwin: true } : {}),
			},
			at: opts.at,
		}),
	);
}

/** 本人发消息。`at` 只在回放历史（演示数据）时指定。 */
export async function postMessage(
	s: Scoped,
	me: PrincipalRow,
	conversationId: string,
	req: PostMessageRequest,
	at?: Date,
): Promise<Event> {
	return postAs(s, me, conversationId, req, { at });
}

export async function listEvents(
	s: Scoped,
	me: PrincipalRow,
	conversationId: string,
	query: EventsQuery,
): Promise<Event[]> {
	const { conversation } = await requireConversation(s, conversationId, me.id);
	const rows = await s.executor
		.select()
		.from(events)
		.where(
			s.where(
				events,
				eq(events.conversationId, conversation.id),
				gt(events.seq, query.after),
			),
		)
		.orderBy(asc(events.seq))
		.limit(query.limit);
	return rows.map(toEvent);
}

/** 已读位置只前进不后退；超过会话当前 seq → 400。 */
export async function markRead(
	s: Scoped,
	me: PrincipalRow,
	conversationId: string,
	seq: number,
): Promise<void> {
	const { conversation } = await requireConversation(s, conversationId, me.id);
	if (seq > conversation.lastSeq) throw badRequest("seq 超出会话当前进度");
	await s.executor
		.update(conversationMembers)
		.set({
			lastReadSeq: sql`greatest(${conversationMembers.lastReadSeq}, ${seq})`,
		})
		.where(
			s.where(
				conversationMembers,
				eq(conversationMembers.conversationId, conversation.id),
				eq(conversationMembers.principalId, me.id),
			),
		);
}

/**
 * 我参与的会话，按最近活动倒序。协商会话不在列表里：它以卡片出现在两位本人的私聊中，
 * 其事件经 `listEvents` 读取。
 */
export async function listConversations(
	s: Scoped,
	me: PrincipalRow,
): Promise<ConversationSummary[]> {
	const mine = await s.select(
		conversationMembers,
		eq(conversationMembers.principalId, me.id),
	);
	if (mine.length === 0) return [];
	const convRows = await s.select(
		conversations,
		inArray(
			conversations.id,
			mine.map((m) => m.conversationId),
		),
		ne(conversations.kind, "negotiation"),
	);
	if (convRows.length === 0) return [];
	const ids = convRows.map((c) => c.id);
	const memberRows = await s.executor
		.select({
			conversationId: conversationMembers.conversationId,
			principal: principals,
		})
		.from(conversationMembers)
		.innerJoin(principals, eq(principals.id, conversationMembers.principalId))
		.where(
			and(
				s.where(
					conversationMembers,
					inArray(conversationMembers.conversationId, ids),
				),
				s.where(principals),
			),
		)
		.orderBy(asc(conversationMembers.joinedAt));
	const lastRows = await s.executor
		.selectDistinctOn([events.conversationId])
		.from(events)
		.where(s.where(events, inArray(events.conversationId, ids)))
		.orderBy(events.conversationId, desc(events.seq));
	const unreadRows = await s.executor
		.select({ conversationId: events.conversationId, n: count() })
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
				s.where(
					events,
					inArray(events.conversationId, ids),
					eq(events.type, "message.posted"),
					ne(events.actorId, me.id),
					gt(events.seq, conversationMembers.lastReadSeq),
				),
				s.where(conversationMembers),
			),
		)
		.groupBy(events.conversationId);

	const membersOf = new Map<string, ConversationSummary["members"]>();
	for (const r of memberRows) {
		const list = membersOf.get(r.conversationId) ?? [];
		list.push(toPrincipal(r.principal));
		membersOf.set(r.conversationId, list);
	}
	const lastOf = new Map(lastRows.map((r) => [r.conversationId, toEvent(r)]));
	const unreadOf = new Map(unreadRows.map((r) => [r.conversationId, r.n]));
	const readOf = new Map(mine.map((m) => [m.conversationId, m.lastReadSeq]));

	return convRows
		.map((row): ConversationSummary => {
			const lastEvent = lastOf.get(row.id);
			return {
				conversation: toConversation(row),
				members: membersOf.get(row.id) ?? [],
				...(lastEvent ? { lastEvent } : {}),
				unread: unreadOf.get(row.id) ?? 0,
				lastReadSeq: readOf.get(row.id) ?? 0,
			};
		})
		.sort((a, b) => activityOf(b).localeCompare(activityOf(a)));
}

function activityOf(item: ConversationSummary): string {
	return item.lastEvent?.createdAt ?? item.conversation.createdAt;
}
