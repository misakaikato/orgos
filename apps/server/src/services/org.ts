/**
 * 组织结构：单元树、负责人与成员（写入口）。
 *
 * - 建单元时同一事务建它的分身（`<单元handle>-twin`、`<单元名>的分身`、role=front、本人=单元）
 *   与单元群（成员 = 单元分身 + 单元成员，成员入群时带上各自的分身，沿用 `withTwins`）；
 * - 成员变动同步单元群（`joinGroup` / `leaveGroup`）；负责人始终是成员，其成员行 role=head；
 * - 权限（规格第 8 条）：租户 owner 管理单元树与负责人；负责人改章程、管理成员；
 *   其余人 403（单元不存在或跨租户 404）。
 */
import {
	type AddUnitMemberRequest,
	type CreateUnitRequest,
	ERROR_CODES,
	type MEMBER_ROLES,
	type OrgUnit,
	twinHandle,
	twinName,
	type UpdateUnitRequest,
} from "@orgos/protocol";
import { and, eq, inArray, ne } from "drizzle-orm";
import {
	conversations,
	orgUnits,
	principals,
	unitMemberships,
} from "@/db/schema";
import type { PrincipalRow, Scoped } from "@/db/scope";
import {
	AppError,
	badRequest,
	notFound,
	PG_UNIQUE_VIOLATION,
	pgErrorOf,
} from "@/lib/errors";
import { toPrincipal } from "@/lib/serialize";
import { isUuid } from "@/lib/uuid";
import { browserHub } from "@/realtime/browser-hub";
import { createAgent, requireTwinOf } from "@/services/agents";
import {
	insertGroup,
	joinGroup,
	leaveGroup,
	withTwins,
} from "@/services/conversations";
import { type Append, transactWithEvents } from "@/services/events";
import { findUnit, type OrgUnitRow, unitMembershipsOf } from "@/services/units";

type TenantRole = (typeof MEMBER_ROLES)[number];

/** 调用者：本人主体与他在租户里的身份。 */
export type OrgActor = { me: PrincipalRow; tenantRole: TenantRole };

export const UNIT_TWIN_DESCRIPTION = (name: string) =>
	`${name}的分身。本租户任何人都可以私聊它"问${name}"：按负责人写的章程直接答复或决定，章程之外转给负责人；在${name}群里被 @ 时发言。它不读成员的私聊与私有资料，不提供按人统计的数据。`;

function forbidden(message: string): AppError {
	return new AppError(403, ERROR_CODES.FORBIDDEN, message);
}

async function requireHuman(s: Scoped, id: string): Promise<PrincipalRow> {
	const row = isUuid(id)
		? await s.first(
				principals,
				eq(principals.id, id),
				eq(principals.kind, "human"),
			)
		: undefined;
	if (!row) throw notFound("找不到此人");
	return row;
}

/** 单元与它的主体行；不存在或跨租户 → 404。 */
export async function requireUnit(
	s: Scoped,
	unitId: string,
): Promise<{ unit: OrgUnitRow; principal: PrincipalRow }> {
	const unit = isUuid(unitId) ? await findUnit(s, unitId) : undefined;
	const principal = unit
		? await s.first(principals, eq(principals.id, unit.principalId))
		: undefined;
	if (!unit || !principal) throw notFound("部门不存在");
	return { unit, principal };
}

/** 调用者是该单元负责人：返回单元主体（记忆与代答记录的"本人"）；不是 → 403。 */
export async function requireUnitHead(
	s: Scoped,
	me: PrincipalRow,
	unitId: string,
): Promise<PrincipalRow> {
	const { unit, principal } = await requireUnit(s, unitId);
	if (unit.headId !== me.id) throw forbidden("只有部门负责人可以操作");
	return principal;
}

/** 单元的线上形态。 */
export async function toOrgUnits(
	s: Scoped,
	units: readonly OrgUnitRow[],
): Promise<OrgUnit[]> {
	if (units.length === 0) return [];
	const memberships = await unitMembershipsOf(
		s,
		units.map((u) => u.principalId),
	);
	const ids = [
		...units.flatMap((u) => [u.principalId, u.headId]),
		...memberships.map((m) => m.principalId),
	];
	const byId = new Map(
		(await s.select(principals, inArray(principals.id, [...new Set(ids)]))).map(
			(p) => [p.id, p],
		),
	);
	const out: OrgUnit[] = [];
	for (const u of units) {
		const unit = byId.get(u.principalId);
		const head = byId.get(u.headId);
		if (!unit || !head) continue;
		out.push({
			unit: toPrincipal(unit),
			head: toPrincipal(head),
			members: memberships.flatMap((m) => {
				const p = m.unitId === u.principalId ? byId.get(m.principalId) : null;
				return p
					? [
							{
								principal: toPrincipal(p),
								role: m.role,
								isPrimary: m.isPrimary,
							},
						]
					: [];
			}),
			twin: toPrincipal(await requireTwinOf(s, u.principalId)),
			parentId: u.parentId,
			charter: u.charter,
			groupId: u.groupConversationId,
		});
	}
	return out;
}

/** 全部单元，按名称排序（前端按 parentId 组成树）。 */
export async function listOrg(s: Scoped): Promise<OrgUnit[]> {
	const units = await toOrgUnits(s, await s.select(orgUnits));
	return units.sort((a, b) =>
		a.unit.displayName.localeCompare(b.unit.displayName, "zh-CN"),
	);
}

export async function getOrgUnit(s: Scoped, unitId: string): Promise<OrgUnit> {
	const { unit } = await requireUnit(s, unitId);
	const [out] = await toOrgUnits(s, [unit]);
	if (!out) throw notFound("部门不存在");
	return out;
}

/** 上级单元须存在，且不能是自己或自己的下级（不成环）。 */
async function checkParent(
	s: Scoped,
	unitId: string | null,
	parentId: string,
): Promise<void> {
	let cur: string | null = parentId;
	for (let depth = 0; cur; depth++) {
		if (cur === unitId || depth > 64)
			throw badRequest("上级部门不能是它自己或它的下级");
		const row: OrgUnitRow | undefined = await findUnit(s, cur);
		if (!row) throw badRequest("上级部门不存在");
		cur = row.parentId;
	}
}

function handleTaken(e: unknown): never {
	if (pgErrorOf(e)?.code === PG_UNIQUE_VIOLATION)
		throw new AppError(409, ERROR_CODES.HANDLE_TAKEN, "handle 已被占用");
	throw e;
}

/**
 * 建单元（仅租户 owner）：单元主体、单元行、单元分身、负责人的成员行与单元群在同一事务里建立。
 */
export async function createUnit(
	s: Scoped,
	actor: OrgActor,
	req: CreateUnitRequest,
	opts: { at?: Date } = {},
): Promise<OrgUnit> {
	if (actor.tenantRole !== "owner")
		throw forbidden("只有组织的管理员可以建部门");
	const head = await requireHuman(s, req.headId);
	if (req.parentId) await checkParent(s, null, req.parentId);
	const created = await transactWithEvents(s, async (tx, append) => {
		const principal = await tx.insert(principals, {
			kind: "unit",
			userId: null,
			ownerId: null,
			handle: req.handle,
			displayName: req.name,
		});
		const unit = await tx.insert(orgUnits, {
			principalId: principal.id,
			parentId: req.parentId ?? null,
			headId: head.id,
		});
		const twin = await createAgent(tx, {
			ownerId: principal.id,
			role: "front",
			handle: twinHandle(req.handle),
			displayName: twinName(req.name),
			description: UNIT_TWIN_DESCRIPTION(req.name),
		});
		await tx.insert(unitMemberships, {
			unitId: principal.id,
			principalId: head.id,
			role: "head",
			isPrimary: false,
		});
		const twinRow = await tx.first(
			principals,
			eq(principals.id, twin.principal.id),
		);
		if (!twinRow) throw new Error("单元分身写入后读不到");
		const { conversation } = await insertGroup(tx, append, {
			title: req.name,
			createdBy: principal.id,
			actorId: actor.me.id,
			members: [twinRow, ...(await withTwins(tx, [head]))],
			announced: [head],
			...(opts.at ? { at: opts.at } : {}),
		});
		await tx.executor
			.update(orgUnits)
			.set({ groupConversationId: conversation.id })
			.where(tx.where(orgUnits, eq(orgUnits.principalId, unit.principalId)));
		return unit.principalId;
	}).catch(handleTaken);
	return getOrgUnit(s, created);
}

/** 让某人成为负责人：成员行置 head（没有则加入并入群），原负责人降为成员。调用方负责事务。 */
async function applyHead(
	tx: Scoped,
	append: Append,
	unit: OrgUnitRow,
	head: PrincipalRow,
	actorId: string,
): Promise<void> {
	await tx.executor
		.update(unitMemberships)
		.set({ role: "member" })
		.where(
			tx.where(
				unitMemberships,
				eq(unitMemberships.unitId, unit.principalId),
				ne(unitMemberships.principalId, head.id),
			),
		);
	const existing = await tx.first(
		unitMemberships,
		eq(unitMemberships.unitId, unit.principalId),
		eq(unitMemberships.principalId, head.id),
	);
	if (existing)
		await tx.executor
			.update(unitMemberships)
			.set({ role: "head" })
			.where(
				tx.where(
					unitMemberships,
					and(
						eq(unitMemberships.unitId, unit.principalId),
						eq(unitMemberships.principalId, head.id),
					),
				),
			);
	else await addMembership(tx, append, unit, head, "head", false, actorId);
	await tx.executor
		.update(orgUnits)
		.set({ headId: head.id })
		.where(tx.where(orgUnits, eq(orgUnits.principalId, unit.principalId)));
}

/** 加一条成员行并让他（带分身）进单元群。调用方负责事务。 */
async function addMembership(
	tx: Scoped,
	append: Append,
	unit: OrgUnitRow,
	person: PrincipalRow,
	role: "head" | "member",
	isPrimary: boolean,
	actorId: string,
): Promise<void> {
	if (isPrimary)
		await tx.executor
			.update(unitMemberships)
			.set({ isPrimary: false })
			.where(
				tx.where(unitMemberships, eq(unitMemberships.principalId, person.id)),
			);
	await tx.insert(unitMemberships, {
		unitId: unit.principalId,
		principalId: person.id,
		role,
		isPrimary,
	});
	if (unit.groupConversationId)
		await joinGroup(tx, append, {
			conversationId: unit.groupConversationId,
			actorId,
			joiners: await withTwins(tx, [person]),
			announced: [person],
		});
}

/**
 * 改单元：名称、负责人、上级只有租户 owner 能改；章程 owner 与负责人都能改。
 * 改名同步单元分身的显示名与单元群的群名。
 */
export async function updateUnit(
	s: Scoped,
	actor: OrgActor,
	unitId: string,
	req: UpdateUnitRequest,
): Promise<OrgUnit> {
	const { unit, principal } = await requireUnit(s, unitId);
	const owner = actor.tenantRole === "owner";
	const head = unit.headId === actor.me.id;
	const structural =
		req.name !== undefined ||
		req.headId !== undefined ||
		req.parentId !== undefined;
	if (structural && !owner)
		throw forbidden("只有组织的管理员可以调整部门结构与负责人");
	if (req.charter !== undefined && !owner && !head)
		throw forbidden("只有部门负责人可以改章程");
	const newHead = req.headId ? await requireHuman(s, req.headId) : null;
	if (req.parentId) await checkParent(s, unit.principalId, req.parentId);
	await transactWithEvents(s, async (tx, append) => {
		if (req.name !== undefined && req.name !== principal.displayName) {
			await tx.executor
				.update(principals)
				.set({ displayName: req.name })
				.where(tx.where(principals, eq(principals.id, unit.principalId)));
			const twin = await requireTwinOf(tx, unit.principalId);
			await tx.executor
				.update(principals)
				.set({ displayName: twinName(req.name) })
				.where(tx.where(principals, eq(principals.id, twin.id)));
			if (unit.groupConversationId)
				await tx.executor
					.update(conversations)
					.set({ title: req.name })
					.where(
						tx.where(
							conversations,
							eq(conversations.id, unit.groupConversationId),
						),
					);
		}
		if (newHead && newHead.id !== unit.headId)
			await applyHead(tx, append, unit, newHead, actor.me.id);
		const patch = {
			...(req.charter !== undefined ? { charter: req.charter } : {}),
			...(req.parentId !== undefined ? { parentId: req.parentId } : {}),
		};
		if (Object.keys(patch).length > 0)
			await tx.executor
				.update(orgUnits)
				.set(patch)
				.where(tx.where(orgUnits, eq(orgUnits.principalId, unit.principalId)));
	});
	return getOrgUnit(s, unit.principalId);
}

function requireManager(unit: OrgUnitRow, actor: OrgActor): void {
	if (actor.tenantRole !== "owner" && unit.headId !== actor.me.id)
		throw forbidden("只有部门负责人可以管理成员");
}

/** 加成员（owner 或负责人）：成员带着分身进单元群。role=head 即改负责人（仅 owner）。已是成员 → 409。 */
export async function addUnitMember(
	s: Scoped,
	actor: OrgActor,
	unitId: string,
	req: AddUnitMemberRequest,
): Promise<OrgUnit> {
	const { unit } = await requireUnit(s, unitId);
	requireManager(unit, actor);
	const person = await requireHuman(s, req.principalId);
	const existing = await s.first(
		unitMemberships,
		eq(unitMemberships.unitId, unit.principalId),
		eq(unitMemberships.principalId, person.id),
	);
	if (req.role === "head") {
		if (actor.tenantRole !== "owner")
			throw forbidden("只有组织的管理员可以换负责人");
		return updateUnit(s, actor, unitId, { headId: person.id });
	}
	if (existing)
		throw new AppError(409, ERROR_CODES.ALREADY_MEMBER, "已经是部门成员了");
	await transactWithEvents(s, (tx, append) =>
		addMembership(
			tx,
			append,
			unit,
			person,
			"member",
			req.isPrimary ?? false,
			actor.me.id,
		),
	);
	return getOrgUnit(s, unit.principalId);
}

/** 移出成员（owner 或负责人）：他与他的分身一起退出单元群。负责人不能移出（先换负责人）。 */
export async function removeUnitMember(
	s: Scoped,
	actor: OrgActor,
	unitId: string,
	principalId: string,
): Promise<OrgUnit> {
	const { unit } = await requireUnit(s, unitId);
	requireManager(unit, actor);
	if (principalId === unit.headId)
		throw badRequest("负责人不能移出，请先换负责人");
	const person = await requireHuman(s, principalId);
	const existing = await s.first(
		unitMemberships,
		eq(unitMemberships.unitId, unit.principalId),
		eq(unitMemberships.principalId, person.id),
	);
	if (!existing) throw notFound("不是部门成员");
	const left = await transactWithEvents(s, async (tx, append) => {
		await tx.executor
			.delete(unitMemberships)
			.where(
				tx.where(
					unitMemberships,
					eq(unitMemberships.unitId, unit.principalId),
					eq(unitMemberships.principalId, person.id),
				),
			);
		return unit.groupConversationId
			? leaveGroup(tx, append, {
					conversationId: unit.groupConversationId,
					actorId: actor.me.id,
					target: person,
				})
			: null;
	});
	if (left) browserHub.sendTo(left.leaving, { t: "event", event: left.event });
	return getOrgUnit(s, unit.principalId);
}
