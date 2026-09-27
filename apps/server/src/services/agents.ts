import path from "node:path";
import {
	AGENT_ACP_CAPABILITY,
	AGENT_ROLES,
	type Agent,
	type AgentEngine,
	type CreateExternalAgentRequest,
	type CreateSpecialistRequest,
	ERROR_CODES,
	findAdapter,
	isUnsupervisedAdapter,
	type Principal,
	type TenantSettings,
} from "@orgos/protocol";
import { and, eq, inArray } from "drizzle-orm";
import { agents, principals } from "@/db/schema";
import type { PrincipalRow, RunnerRow, Scoped } from "@/db/scope";
import {
	AppError,
	badRequest,
	notFound,
	PG_UNIQUE_VIOLATION,
	pgErrorOf,
} from "@/lib/errors";
import { toAgent, toPrincipal } from "@/lib/serialize";
import { isUuid } from "@/lib/uuid";
import { getTenantSettings } from "@/services/tenant-settings";

type AgentRole = (typeof AGENT_ROLES)[number];

/** 建一个代理：agent 主体 + agents 行，模型取租户默认模型。调用方负责事务。 */
export async function createAgent(
	s: Scoped,
	input: {
		ownerId: string;
		role: AgentRole;
		handle: string;
		displayName: string;
		description: string;
		/** 外部助手：适配器、设备与工作目录。 */
		external?: { adapter: string; runnerId: string; workspace: string };
	},
): Promise<Agent> {
	const principal = await s.insert(principals, {
		kind: "agent",
		userId: null,
		ownerId: input.ownerId,
		handle: input.handle,
		displayName: input.displayName,
	});
	const engine: AgentEngine = input.external ? "acp" : "builtin";
	const agent = await s.insert(agents, {
		principalId: principal.id,
		role: input.role,
		description: input.description,
		model: (await getTenantSettings(s)).defaultModel,
		engine,
		...(input.external ?? {}),
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

/** 改代理的资料、对外政策、绑定的设备与模型；不存在或跨租户 → 404。调用方负责"只能改自己的代理"、设备归属与模型可用。 */
export async function updateAgentProfile(
	s: Scoped,
	principalId: string,
	patch: {
		displayName?: string;
		description?: string;
		delegationPolicy?: string;
		runnerId?: string | null;
		model?: string;
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

async function insertOwnAgent(
	s: Scoped,
	input: Parameters<typeof createAgent>[1],
): Promise<Agent> {
	try {
		return await s.transaction((tx) => createAgent(tx, input));
	} catch (e) {
		if (pgErrorOf(e)?.code === PG_UNIQUE_VIOLATION) {
			throw new AppError(409, ERROR_CODES.HANDLE_TAKEN, "handle 已被占用");
		}
		throw e;
	}
}

/** 新建一个助手（分身随入驻创建，每人恰好一个）。handle 冲突 → 409。 */
export async function createSpecialist(
	s: Scoped,
	me: PrincipalRow,
	req: CreateSpecialistRequest,
): Promise<Agent> {
	return insertOwnAgent(s, {
		ownerId: me.id,
		role: "specialist",
		handle: req.handle,
		displayName: req.displayName,
		description: req.description,
	});
}

/**
 * 设备上的工作目录：绝对路径或相对设备工作目录，解析后必须仍在设备工作目录之内
 * （设备在启动任务时再用真实路径校验一次）。
 */
export function resolveAgentWorkspace(
	runnerWorkspace: string,
	requested: string,
): string | null {
	const target = path.resolve(runnerWorkspace, requested);
	const rel = path.relative(runnerWorkspace, target);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
		? target
		: null;
}

function adapterUnavailable(message: string): AppError {
	return new AppError(400, ERROR_CODES.ADAPTER_UNAVAILABLE, message);
}

/**
 * 接入一位外部助手（role=specialist、engine=acp）：设备须是本人未吊销的（调用方已校验），
 * 适配器须在该设备 hello 上报的可用列表里（测试适配器另须开发模式），工作目录须在设备工作目录内。
 * 不经审批、不限工作目录的适配器（pi、Hermes）：租户未开启 → 400 ADAPTER_UNAVAILABLE；
 * 本人没有勾选确认 → 400。handle 冲突 → 409。
 */
export async function createExternalAgent(
	s: Scoped,
	me: PrincipalRow,
	runner: RunnerRow,
	req: CreateExternalAgentRequest,
	opts: {
		devMode: boolean;
		capabilities: readonly {
			name: string;
			adapters?: { id: string; available: boolean }[];
		}[];
		settings: TenantSettings;
	},
): Promise<Agent> {
	const def = findAdapter(req.adapter);
	if (!def || (def.devOnly && !opts.devMode))
		throw adapterUnavailable(`没有叫 ${req.adapter} 的适配器`);
	if (isUnsupervisedAdapter(def)) {
		if (!opts.settings.allowUnsupervisedAdapters)
			throw adapterUnavailable(
				`${def.label} 不经审批、不限工作目录，组织尚未允许使用`,
			);
		if (!req.acknowledgeUnsupervised)
			throw badRequest(`请先确认：${def.label} 不经审批、不限工作目录`);
	}
	const acp = opts.capabilities.find((c) => c.name === AGENT_ACP_CAPABILITY);
	if (!acp?.adapters?.some((a) => a.id === def.id && a.available))
		throw adapterUnavailable(`“${runner.name}”上没有可用的 ${def.label}`);
	if (!runner.workspace)
		throw badRequest("设备还没有连上过，不知道它的工作目录");
	const workspace = resolveAgentWorkspace(runner.workspace, req.workspace);
	if (!workspace) throw badRequest("工作目录必须在设备的工作目录之内");
	return insertOwnAgent(s, {
		ownerId: me.id,
		role: "specialist",
		handle: req.handle,
		displayName: req.displayName,
		description:
			req.description ||
			`用${def.label}在“${runner.name}”的 ${workspace} 里替你干活。`,
		external: { adapter: def.id, runnerId: runner.id, workspace },
	});
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
