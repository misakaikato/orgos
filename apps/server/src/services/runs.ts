/**
 * 运行记录：代理的每一次运行（内置循环的一次运行、外部 agent 的一轮）写一行 `runs`，写入只经本文件。
 *
 * - 开始：记下由什么触发、为谁办、在哪个话题；服务于任务时任务随之进入 working；
 * - 结束：completed / failed / canceled（被中止与被新消息打断都算 canceled，summary 写明是哪一种）；
 *   服务于任务时，任务在这一轮结束后等本人（input_required），或按调用方给的结局结束；
 * - 模型调用经 `llm_requests.run_id`、过程记录经 `task_logs.run_id` 关联到运行。
 */
import {
	type AgentEngine,
	canTransition,
	ERROR_CODES,
	type Run,
	type RunsQuery,
	type TaskState,
} from "@orgos/protocol";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import {
	conversationMembers,
	llmRequests,
	principals,
	runs,
} from "@/db/schema";
import {
	type PrincipalRow,
	type Scoped,
	scoped,
	tenantsWithRunningRuns,
} from "@/db/scope";
import { AppError, notFound } from "@/lib/errors";
import { isAgentRun, toRun } from "@/lib/serialize";
import { isUuid } from "@/lib/uuid";
import { requireTask, transitionTask } from "@/services/tasks";

export const INTERRUPTED_SUMMARY = "被新消息打断";
export const ABORTED_SUMMARY = "已中止";
export const RESTART_RUN_SUMMARY = "服务重启，运行中断";

export type StartRunInput = {
	agentId: string;
	conversationId: string;
	topicId: string;
	taskId?: string | null;
	trigger: string;
	actingForId: string;
	engine: AgentEngine;
};

/** 开始一次运行；服务于未结束的任务时任务进入 working。 */
export async function startRun(s: Scoped, input: StartRunInput): Promise<Run> {
	const row = await s.insert(runs, {
		agentId: input.agentId,
		conversationId: input.conversationId,
		topicId: input.topicId,
		taskId: input.taskId ?? null,
		trigger: input.trigger,
		actingForId: input.actingForId,
		engine: input.engine,
		state: "running",
	});
	if (row.taskId) {
		const task = await requireTask(s, row.taskId);
		if (task.state !== "working" && canTransition(task.state, "working"))
			await transitionTask(s, task.id, "working", { runId: row.id });
	}
	return toRun({
		...row,
		agentId: input.agentId,
		actingForId: input.actingForId,
		conversationId: input.conversationId,
		topicId: input.topicId,
	});
}

/**
 * 开始一次系统运行（记忆提炼、画像整理）：不属于任何代理、不替任何人办事，
 * 只为把模型调用的计量挂在一个运行名下。返回运行 id。
 */
export async function startSystemRun(
	s: Scoped,
	input: { conversationId?: string; topicId?: string; trigger: string },
): Promise<string> {
	const row = await s.insert(runs, {
		agentId: null,
		actingForId: null,
		conversationId: input.conversationId ?? null,
		topicId: input.topicId ?? null,
		taskId: null,
		trigger: input.trigger,
		engine: "builtin",
		state: "running",
	});
	return row.id;
}

export type RunEnd = {
	state: Exclude<Run["state"], "running">;
	summary?: string | null;
	externalSessionId?: string | null;
	/** 服务于任务时任务的结局；不给则这一轮结束后等本人（input_required）。 */
	taskState?: TaskState;
	taskSummary?: string;
};

/** 结束一次运行（已结束的不再改）；本次确实结束了它 → true，已结束过 → false。 */
export async function finishRun(
	s: Scoped,
	runId: string,
	end: RunEnd,
): Promise<boolean> {
	const [row] = await s.executor
		.update(runs)
		.set({
			state: end.state,
			endedAt: new Date(),
			summary: end.summary ?? null,
			...(end.externalSessionId
				? { externalSessionId: end.externalSessionId }
				: {}),
		})
		.where(s.where(runs, eq(runs.id, runId), eq(runs.state, "running")))
		.returning();
	if (!row) return false;
	if (row.taskId) {
		const task = await requireTask(s, row.taskId);
		const to =
			end.taskState ??
			(task.state === "working" || task.state === "awaiting_approval"
				? "input_required"
				: null);
		if (to && to !== task.state && canTransition(task.state, to))
			await transitionTask(s, task.id, to, {
				runId: row.id,
				...(end.taskSummary !== undefined ? { summary: end.taskSummary } : {}),
			});
	}
	return true;
}

/** 外部 agent 报来了这一轮所在的 ACP 会话。 */
export async function setRunExternalSession(
	s: Scoped,
	runId: string,
	externalSessionId: string,
): Promise<void> {
	await s.executor
		.update(runs)
		.set({ externalSessionId })
		.where(s.where(runs, eq(runs.id, runId)));
}

export async function findRun(s: Scoped, runId: string): Promise<Run | null> {
	const row = isUuid(runId) ? await s.first(runs, eq(runs.id, runId)) : null;
	return row && isAgentRun(row) ? toRun(row) : null;
}

/** 我看得到的运行：我的代理的运行，或我所在会话里的运行。否则 404。 */
export async function requireVisibleRun(
	s: Scoped,
	me: PrincipalRow,
	runId: string,
): Promise<Run> {
	const run = await findRun(s, runId);
	if (!run) throw notFound("运行不存在");
	const agent = await s.first(principals, eq(principals.id, run.agentId));
	if (agent?.ownerId === me.id) return run;
	const member = await s.first(
		conversationMembers,
		eq(conversationMembers.conversationId, run.conversationId),
		eq(conversationMembers.principalId, me.id),
	);
	if (!member) throw notFound("运行不存在");
	return run;
}

export const RUN_LIST_LIMIT = 200;

/**
 * 运行列表，最近的在前：给了代理须是我的代理（别人的 403）；给了话题须是我所在会话的话题；
 * 都不给是我全部代理的运行。
 */
export async function listRuns(
	s: Scoped,
	me: PrincipalRow,
	query: RunsQuery,
	visibleTopic: (topicId: string) => Promise<void>,
): Promise<Run[]> {
	if (query.agentId) {
		const agent = isUuid(query.agentId)
			? await s.first(principals, eq(principals.id, query.agentId))
			: undefined;
		if (agent?.kind !== "agent") throw notFound("代理不存在");
		if (agent.ownerId !== me.id)
			throw new AppError(403, ERROR_CODES.FORBIDDEN, "只能看自己代理的运行");
	}
	if (query.topicId) await visibleTopic(query.topicId);
	const mine = s.executor
		.select({ id: principals.id })
		.from(principals)
		.where(s.where(principals, eq(principals.ownerId, me.id)));
	const rows = await s.executor
		.select()
		.from(runs)
		.where(
			s.where(
				runs,
				query.agentId ? eq(runs.agentId, query.agentId) : undefined,
				query.topicId ? eq(runs.topicId, query.topicId) : undefined,
				!query.agentId && !query.topicId
					? inArray(runs.agentId, mine)
					: undefined,
			),
		)
		.orderBy(desc(runs.startedAt))
		.limit(RUN_LIST_LIMIT);
	return rows.filter(isAgentRun).map(toRun);
}

/** 一次运行的模型用量合计。 */
export async function runUsage(s: Scoped, runId: string) {
	const [row] = await s.executor
		.select({
			requests: count(),
			inputTokens: sql<string>`coalesce(sum(${llmRequests.inputTokens}), 0)`,
			outputTokens: sql<string>`coalesce(sum(${llmRequests.outputTokens}), 0)`,
			costMicroUsd: sql<string>`coalesce(sum(${llmRequests.costMicroUsd}), 0)`,
		})
		.from(llmRequests)
		.where(s.where(llmRequests, eq(llmRequests.runId, runId)));
	return {
		requests: row?.requests ?? 0,
		inputTokens: Number(row?.inputTokens ?? 0),
		outputTokens: Number(row?.outputTokens ?? 0),
		costMicroUsd: Number(row?.costMicroUsd ?? 0),
	};
}

/** 某话题里仍在进行的代理运行（系统运行不算）。 */
export async function runningRunsIn(
	s: Scoped,
	topicId: string,
): Promise<Run[]> {
	const rows = await s.select(
		runs,
		and(eq(runs.topicId, topicId), eq(runs.state, "running")),
	);
	return rows.filter(isAgentRun).map(toRun);
}

/** 进程启动：上一个进程留下的进行中的运行都已失去运行时，判失败。 */
export async function failDanglingRuns(): Promise<number> {
	let n = 0;
	for (const tenantId of await tenantsWithRunningRuns()) {
		const s = scoped(tenantId);
		const rows = await s.select(runs, eq(runs.state, "running"));
		for (const row of rows)
			if (
				await finishRun(s, row.id, {
					state: "failed",
					summary: RESTART_RUN_SUMMARY,
				})
			)
				n += 1;
	}
	return n;
}
