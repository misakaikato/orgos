/**
 * 组织单元的只读查找：谁是单元、谁替某个主体拍板、单元的成员。
 *
 * "替谁拍板"（`deciderOf`）是全系统唯一的解释处：人由本人拍板；单元由负责人拍板。
 * 上报、协商里的 need_owner、承诺待办、协商确认、协商观察者都经它找到处理人。
 */
import { eq, inArray } from "drizzle-orm";
import { orgUnits, principals, unitMemberships } from "@/db/schema";
import type { PrincipalRow, Scoped } from "@/db/scope";

export type OrgUnitRow = typeof orgUnits.$inferSelect;
export type UnitMembershipRow = typeof unitMemberships.$inferSelect;

export async function findUnit(
	s: Scoped,
	unitId: string,
): Promise<OrgUnitRow | undefined> {
	return s.first(orgUnits, eq(orgUnits.principalId, unitId));
}

/** 以某个会话为单元群的单元。 */
export async function unitOfGroup(
	s: Scoped,
	conversationId: string,
): Promise<OrgUnitRow | undefined> {
	return s.first(orgUnits, eq(orgUnits.groupConversationId, conversationId));
}

async function requirePrincipal(s: Scoped, id: string): Promise<PrincipalRow> {
	const row = await s.first(principals, eq(principals.id, id));
	if (!row) throw new Error(`主体 ${id} 不存在`);
	return row;
}

/** 替某个主体（人或单元）拍板的人：人是本人，单元是负责人。 */
export async function deciderOf(
	s: Scoped,
	principalId: string,
): Promise<PrincipalRow> {
	const principal = await requirePrincipal(s, principalId);
	if (principal.kind !== "unit") return principal;
	const unit = await findUnit(s, principal.id);
	if (!unit) throw new Error(`单元 ${principal.id} 缺少 org_units 行`);
	return requirePrincipal(s, unit.headId);
}

export async function isUnitMember(
	s: Scoped,
	unitId: string,
	principalId: string,
): Promise<boolean> {
	const row = await s.first(
		unitMemberships,
		eq(unitMemberships.unitId, unitId),
		eq(unitMemberships.principalId, principalId),
	);
	return row !== undefined;
}

/** 单元的成员行，负责人在前。 */
export async function unitMembershipsOf(
	s: Scoped,
	unitIds: readonly string[],
): Promise<UnitMembershipRow[]> {
	if (unitIds.length === 0) return [];
	const rows = await s.select(
		unitMemberships,
		inArray(unitMemberships.unitId, [...unitIds]),
	);
	return rows.sort(
		(a, b) =>
			Number(b.role === "head") - Number(a.role === "head") ||
			a.createdAt.getTime() - b.createdAt.getTime(),
	);
}

/** 单元分身运行时需要的单元信息：负责人、章程，以及提问的人是不是成员。 */
export type UnitContext = {
	unit: OrgUnitRow;
	head: PrincipalRow;
	/** 提问的人是本单元成员（为单元本身运行时为 false）。 */
	requesterIsMember: boolean;
};

export async function unitContextOf(
	s: Scoped,
	owner: PrincipalRow,
	requesterId: string | null,
): Promise<UnitContext | null> {
	if (owner.kind !== "unit") return null;
	const unit = await findUnit(s, owner.id);
	if (!unit) return null;
	return {
		unit,
		head: await deciderOf(s, owner.id),
		requesterIsMember:
			requesterId !== null &&
			(await isUnitMember(s, unit.principalId, requesterId)),
	};
}

/** 代理所属的单元（它是单元分身时）；否则 null。 */
export async function unitOfAgent(
	s: Scoped,
	agentId: string,
): Promise<PrincipalRow | null> {
	const agent = await s.first(principals, eq(principals.id, agentId));
	if (!agent?.ownerId) return null;
	const owner = await s.first(principals, eq(principals.id, agent.ownerId));
	return owner?.kind === "unit" ? owner : null;
}
