import type { Agent, Principal } from "@orgos/protocol";
import { AGENT_ROLES } from "@orgos/protocol";
import { eq, inArray } from "drizzle-orm";
import { agents, principals } from "@/db/schema";
import type { Scoped } from "@/db/scope";
import { toAgent, toPrincipal } from "@/lib/serialize";

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

/** 某人的代理组：幕僚长在前，其余按创建时间。 */
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

/** 本租户所有人及其幕僚长，按 handle 排序。 */
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
