import type { Agent, CreateAgentRequest, Principal } from "@orgos/protocol";
import { AGENT_ROLES, ERROR_CODES } from "@orgos/protocol";
import { and, eq, inArray } from "drizzle-orm";
import { agents, principals } from "@/db/schema";
import type { PrincipalRow, Scoped } from "@/db/scope";
import {
	AppError,
	notFound,
	PG_UNIQUE_VIOLATION,
	pgErrorOf,
} from "@/lib/errors";
import { toAgent, toPrincipal } from "@/lib/serialize";
import { isUuid } from "@/lib/uuid";

type AgentRole = (typeof AGENT_ROLES)[number];

/** 建一个代理：agent 主体 + agents 行。调用方负责事务。 */
export async function createAgent(
	s: Scoped,
	input: {
		ownerId: string;
		role: AgentRole;
		handle: string;
		displayName: string;
		description: string;
	},
): Promise<Agent> {
	const principal = await s.insert(principals, {
		kind: "agent",
		userId: null,
		ownerId: input.ownerId,
		handle: input.handle,
		displayName: input.displayName,
	});
	const agent = await s.insert(agents, {
		principalId: principal.id,
		role: input.role,
		description: input.description,
	});
	return toAgent(principal, agent);
}

/** 某人的代理组：分身在前，其余按创建时间。 */
export async function listAgentsOf(
	s: Scoped,
	ownerId: string,
): Promise<Agent[]> {
	const owned = await s.select(
		principals,
		eq(principals.ownerId, ownerId),
		eq(principals.kind, "agent"),
	);
	if (owned.length === 0) return [];
	const rows = await s.select(
		agents,
		inArray(
			agents.principalId,
			owned.map((p) => p.id),
		),
	);
	const byId = new Map(owned.map((p) => [p.id, p]));
	return rows
		.flatMap((a) => {
			const p = byId.get(a.principalId);
			return p ? [toAgent(p, a)] : [];
		})
		.sort(
			(x, y) =>
				AGENT_ROLES.indexOf(x.role) - AGENT_ROLES.indexOf(y.role) ||
				x.principal.createdAt.localeCompare(y.principal.createdAt),
		);
}

/** 某人的分身（每人恰好一个）；缺失即数据损坏。 */
export async function requireTwinOf(
	s: Scoped,
	ownerId: string,
): Promise<PrincipalRow> {
	const [row] = await s.executor
		.select({ principal: principals })
		.from(principals)
		.innerJoin(agents, eq(agents.principalId, principals.id))
		.where(
			and(
				s.where(
					principals,
					eq(principals.ownerId, ownerId),
					eq(principals.kind, "agent"),
				),
				s.where(agents, eq(agents.role, "front")),
			),
		)
		.limit(1);
	if (!row) throw new Error(`主体 ${ownerId} 没有分身`);
	return row.principal;
}

/** 本租户所有人及其分身，按 handle 排序。 */
export async function listDirectory(
	s: Scoped,
): Promise<{ principal: Principal; front: Principal }[]> {
	const humans = await s.select(principals, eq(principals.kind, "human"));
	const fronts = await s.select(agents, eq(agents.role, "front"));
	const frontPrincipals =
		fronts.length === 0
			? []
			: await s.select(
					principals,
					inArray(
						principals.id,
						fronts.map((a) => a.principalId),
					),
				);
	const frontByOwner = new Map(
		frontPrincipals.flatMap((p) =>
			p.ownerId ? [[p.ownerId, p] as const] : [],
		),
	);
	return humans
		.flatMap((h) => {
			const front = frontByOwner.get(h.id);
			return front
				? [{ principal: toPrincipal(h), front: toPrincipal(front) }]
				: [];
		})
		.sort((x, y) => x.principal.handle.localeCompare(y.principal.handle));
}

/** 改代理的资料、对外政策与绑定的设备；不存在或跨租户 → 404。调用方负责"只能改自己的代理"与设备归属。 */
export async function updateAgentProfile(
	s: Scoped,
	principalId: string,
	patch: {
		displayName?: string;
		description?: string;
		delegationPolicy?: string;
		runnerId?: string | null;
	},
): Promise<Agent> {
	const principal = await s.first(principals, eq(principals.id, principalId));
	const agent = await s.first(agents, eq(agents.principalId, principalId));
	if (!principal || !agent) throw notFound("代理不存在");
	const nextPrincipal =
		patch.displayName === undefined
			? principal
			: (
					await s.executor
						.update(principals)
						.set({ displayName: patch.displayName })
						.where(s.where(principals, eq(principals.id, principalId)))
						.returning()
				)[0];
	const { displayName: _, ...agentPatch } = patch;
	const nextAgent =
		Object.keys(agentPatch).length === 0
			? agent
			: (
					await s.executor
						.update(agents)
						.set(agentPatch)
						.where(s.where(agents, eq(agents.principalId, principalId)))
						.returning()
				)[0];
	if (!nextPrincipal || !nextAgent) throw notFound("代理不存在");
	return toAgent(nextPrincipal, nextAgent);
}

/**
 * 按 id 或 handle 取一个在职的代理（有 agents 行）。删除的代理只留主体行作历史锚点，这里取不到。
 */
export async function findAgent(
	s: Scoped,
	by: { id: string } | { handle: string },
): Promise<Agent | null> {
	if ("id" in by && !isUuid(by.id)) return null;
	const [row] = await s.executor
		.select({ principal: principals, agent: agents })
		.from(principals)
		.innerJoin(agents, eq(agents.principalId, principals.id))
		.where(
			and(
				s.where(
					principals,
					eq(principals.kind, "agent"),
					"id" in by
						? eq(principals.id, by.id)
						: eq(principals.handle, by.handle),
				),
				s.where(agents),
			),
		)
		.limit(1);
	return row ? toAgent(row.principal, row.agent) : null;
}

/** 我的某个代理：不存在或跨租户 → 404；别人的 → 403。 */
export async function requireOwnAgent(
	s: Scoped,
	me: PrincipalRow,
	agentId: string,
): Promise<Agent> {
	const agent = await findAgent(s, { id: agentId });
	if (!agent) throw notFound("代理不存在");
	if (agent.principal.ownerId !== me.id) {
		throw new AppError(403, ERROR_CODES.FORBIDDEN, "只能管理自己的代理");
	}
	return agent;
}

/** 新建一个助手（分身随入驻创建，每人恰好一个）。handle 冲突 → 409。 */
export async function createSpecialist(
	s: Scoped,
	me: PrincipalRow,
	req: CreateAgentRequest,
): Promise<Agent> {
	try {
		return await s.transaction((tx) =>
			createAgent(tx, {
				ownerId: me.id,
				role: "specialist",
				handle: req.handle,
				displayName: req.displayName,
				description: req.description,
			}),
		);
	} catch (e) {
		if (pgErrorOf(e)?.code === PG_UNIQUE_VIOLATION) {
			throw new AppError(409, ERROR_CODES.HANDLE_TAKEN, "handle 已被占用");
		}
		throw e;
	}
}

/**
 * 删除我的一个助手：删去 agents 行，主体行留作历史消息与记账的锚点
 * （events 只追加、不能删）。分身不可删除 → 403。
 */
export async function retireAgent(
	s: Scoped,
	me: PrincipalRow,
	agentId: string,
): Promise<void> {
	const agent = await requireOwnAgent(s, me, agentId);
	if (agent.role === "front") {
		throw new AppError(403, ERROR_CODES.FORBIDDEN, "分身不能删除");
	}
	await s.executor
		.delete(agents)
		.where(s.where(agents, eq(agents.principalId, agent.principal.id)));
}
