/**
 * 数据库行 → 协议形态（@orgos/protocol 的实体 schema）。
 */
import type { Agent, Principal, Tenant } from "@orgos/protocol";
import type { agents, principals, tenants } from "@/db/schema";

type PrincipalRow = typeof principals.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type TenantRow = typeof tenants.$inferSelect;

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
