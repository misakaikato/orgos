/**
 * 数据库行 → 协议形态（@orgos/protocol 的实体 schema）。
 */
import type {
	Agent,
	Conversation,
	Event,
	Principal,
	Tenant,
} from "@orgos/protocol";
import type {
	agents,
	conversations,
	events,
	principals,
	tenants,
} from "@/db/schema";

type PrincipalRow = typeof principals.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type TenantRow = typeof tenants.$inferSelect;
type ConversationRow = typeof conversations.$inferSelect;
type EventRow = typeof events.$inferSelect;

export function toPrincipal(row: PrincipalRow): Principal {
	return {
		id: row.id,
		tenantId: row.tenantId,
		kind: row.kind,
		userId: row.userId,
		ownerId: row.ownerId,
		handle: row.handle,
		displayName: row.displayName,
		createdAt: row.createdAt.toISOString(),
	};
}

export function toAgent(principal: PrincipalRow, agent: AgentRow): Agent {
	return {
		principal: toPrincipal(principal),
		role: agent.role,
		description: agent.description,
		delegationPolicy: agent.delegationPolicy,
		model: agent.model,
		runnerId: agent.runnerId,
		updatedAt: agent.updatedAt.toISOString(),
	};
}

/** 邀请码只给 owner 看。 */
export function toTenant(row: TenantRow, withInviteCode: boolean): Tenant {
	return withInviteCode
		? { id: row.id, name: row.name, inviteCode: row.inviteCode }
		: { id: row.id, name: row.name };
}

export function toConversation(row: ConversationRow): Conversation {
	return {
		id: row.id,
		tenantId: row.tenantId,
		kind: row.kind,
		title: row.title,
		createdBy: row.createdBy,
		createdAt: row.createdAt.toISOString(),
		lastSeq: row.lastSeq,
	};
}

/**
 * 事件行只经 `@/services/events` 写入，写入前已按 type 校验载荷，
 * 故 type 与 payload 的配对在此成立。
 */
export function toEvent(row: EventRow): Event {
	return {
		id: row.id,
		tenantId: row.tenantId,
		conversationId: row.conversationId,
		seq: row.seq,
		type: row.type,
		actorId: row.actorId,
		onBehalfOfId: row.onBehalfOfId,
		payload: row.payload,
		createdAt: row.createdAt.toISOString(),
	} as Event;
}
