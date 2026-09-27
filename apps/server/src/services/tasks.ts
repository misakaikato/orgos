/**
 * 任务：全系统唯一的交办形态（代理之间的 delegate_to_teammate、与外部助手的一次会话）。
 * 写入只经本文件：建任务、状态迁移、进度与产出、过程日志。
 *
 * - 状态迁移按 protocol 的 `TASK_TRANSITIONS` 判定，条件更新（WHERE state = from）防并发；
 *   迁移在交办所在会话落 `task.updated`，进入结束态落 `task.ended`；
 * - 进度与产出变化只推 `{t:'task'}` 帧，不落会话事件；
 * - `task_logs` 只追加，seq 取自 `tasks.last_log_seq` 的原子自增，任务内连续。
 */
import {
	canTransition,
	ERROR_CODES,
	isTaskEnded,
	type Principal,
	TASK_ENDED_STATES,
	TASK_IDLE_COMPLETE_MS,
	TASK_LOG_PAYLOAD_SCHEMAS,
	type Task,
	type TaskArtifact,
	type TaskLog,
	type TaskLogKind,
	type TaskLogPayload,
	type TaskState,
	type TasksQuery,
	taskTitleOf,
} from "@orgos/protocol";
import { asc, desc, eq, gt, inArray, lt, notInArray, sql } from "drizzle-orm";
import { conversationMembers, principals, taskLogs, tasks } from "@/db/schema";
import type { PrincipalRow, Scoped } from "@/db/scope";
import { AppError, notFound } from "@/lib/errors";
import { toPrincipal, toTask, toTaskLog } from "@/lib/serialize";
import { isUuid } from "@/lib/uuid";
import { browserHub } from "@/realtime/browser-hub";
import { requireConversation } from "@/services/conversations";
import { transactWithEvents } from "@/services/events";

type TaskRow = typeof tasks.$inferSelect;

const ENDED = [...TASK_ENDED_STATES];

/** 进度摘要的上限（卡片上显示的一段话）。 */
export const SUMMARY_MAX_CHARS = 2000;

export function clip(text: string, max = SUMMARY_MAX_CHARS): string {
	const chars = Array.from(text.trim());
	return chars.length > max
		? `${chars.slice(0, max).join("")}…`
		: chars.join("");
}

// ─────────────────────────── 状态变化的监听（进程内） ───────────────────────────

type Listener = (task: Task) => void;
const listeners = new Map<string, Set<Listener>>();

function emit(task: Task): void {
	for (const l of listeners.get(task.id) ?? []) l(task);
}

/**
 * 等任务满足条件（例如一轮结束）：立即检查一次，之后每次变化再检查。signal 触发时返回当时的任务。
 */
export async function waitForTask(
	s: Scoped,
	taskId: string,
	until: (task: Task) => boolean,
	signal?: AbortSignal,
): Promise<Task> {
	const current = await requireTask(s, taskId);
	if (until(current) || signal?.aborted) return current;
	return new Promise<Task>((resolve) => {
		let last = current;
		const set = listeners.get(taskId) ?? new Set<Listener>();
		listeners.set(taskId, set);
		const done = () => {
			set.delete(listener);
			if (set.size === 0) listeners.delete(taskId);
			signal?.removeEventListener("abort", onAbort);
			resolve(last);
		};
		const listener: Listener = (task) => {
			last = task;
			if (until(task)) done();
		};
		const onAbort = () => done();
		set.add(listener);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

// ─────────────────────────── 读取 ───────────────────────────

export async function requireTask(s: Scoped, taskId: string): Promise<Task> {
	const row = isUuid(taskId)
		? await s.first(tasks, eq(tasks.id, taskId))
		: undefined;
	if (!row) throw notFound("任务不存在");
	return toTask(row);
}

/** 我看得到的任务：我是交办所在会话的成员。否则 404。 */
export async function requireVisibleTask(
	s: Scoped,
	me: PrincipalRow,
	taskId: string,
): Promise<Task> {
	const task = await requireTask(s, taskId);
	await requireConversation(s, task.conversationId, me.id);
	return task;
}

export async function taskAssignee(
	s: Scoped,
	task: Task,
): Promise<Principal | undefined> {
	const row = await s.first(principals, eq(principals.id, task.assigneeId));
	return row ? toPrincipal(row) : undefined;
}

/** 某会话里、或我所在的全部会话里的任务，最近的在前。 */
export async function listTasks(
	s: Scoped,
	me: PrincipalRow,
	query: TasksQuery,
): Promise<Task[]> {
	if (query.conversationId)
		await requireConversation(s, query.conversationId, me.id);
	const mine = s.executor
		.select({ id: conversationMembers.conversationId })
		.from(conversationMembers)
		.where(
			s.where(conversationMembers, eq(conversationMembers.principalId, me.id)),
		);
	const rows = await s.executor
		.select()
		.from(tasks)
		.where(
			s.where(
				tasks,
				query.conversationId
					? eq(tasks.conversationId, query.conversationId)
					: inArray(tasks.conversationId, mine),
				query.state ? eq(tasks.state, query.state) : undefined,
			),
		)
		.orderBy(desc(tasks.createdAt))
		.limit(200);
	return rows.map(toTask);
}

/** 某执行者在某会话里仍未结束的最新任务。 */
export async function openTaskOf(
	s: Scoped,
	conversationId: string,
	assigneeId: string,
): Promise<Task | null> {
	const [row] = await s.executor
		.select()
		.from(tasks)
		.where(
			s.where(
				tasks,
				eq(tasks.conversationId, conversationId),
				eq(tasks.assigneeId, assigneeId),
				notInArray(tasks.state, ENDED),
			),
		)
		.orderBy(desc(tasks.createdAt))
		.limit(1);
	return row ? toTask(row) : null;
}

/** 某执行者全部未结束的任务。 */
export async function openTasksOfAssignee(
	s: Scoped,
	assigneeId: string,
): Promise<Task[]> {
	const rows = await s.select(
		tasks,
		eq(tasks.assigneeId, assigneeId),
		notInArray(tasks.state, ENDED),
	);
	return rows.map(toTask);
}

export async function listTaskLogs(
	s: Scoped,
	taskId: string,
	after: number,
	limit: number,
): Promise<TaskLog[]> {
	const rows = await s.executor
		.select()
		.from(taskLogs)
		.where(
			s.where(taskLogs, eq(taskLogs.taskId, taskId), gt(taskLogs.seq, after)),
		)
		.orderBy(asc(taskLogs.seq))
		.limit(limit);
	return rows.map(toTaskLog);
}

// ─────────────────────────── 推送 ───────────────────────────

async function recipientsOf(s: Scoped, task: Task): Promise<string[]> {
	const rows = await s.select(
		conversationMembers,
		eq(conversationMembers.conversationId, task.conversationId),
	);
	return [...new Set([...rows.map((r) => r.principalId), task.onBehalfOfId])];
}

/** 任务变了：推给交办所在会话的成员，并通知进程内的等待者。 */
async function publish(s: Scoped, task: Task): Promise<void> {
	emit(task);
	browserHub.sendTo(await recipientsOf(s, task), { t: "task", task });
}

// ─────────────────────────── 写入 ───────────────────────────

export type CreateTaskInput = {
	conversationId: string;
	requesterId: string;
	/** 执行者：一位代理。 */
	assignee: { id: string; ownerId: string };
	onBehalfOfId: string;
	goal: string;
	engine: Task["engine"];
	adapter?: string | null;
	runnerId?: string | null;
	workspace?: string | null;
};

/**
 * 建一个 submitted 任务，并在交办所在会话落 `task.created`（actor 为执行者，代其本人）；
 * 同时记下第一段话（prompt 日志）。
 */
export async function createTask(
	s: Scoped,
	input: CreateTaskInput,
): Promise<Task> {
	const task = await transactWithEvents(s, async (tx, append) => {
		const row = await tx.insert(tasks, {
			conversationId: input.conversationId,
			requesterId: input.requesterId,
			assigneeId: input.assignee.id,
			onBehalfOfId: input.onBehalfOfId,
			title: taskTitleOf(input.goal),
			goal: input.goal,
			state: "submitted",
			engine: input.engine,
			adapter: input.adapter ?? null,
			runnerId: input.runnerId ?? null,
			workspace: input.workspace ?? null,
		});
		await append({
			conversationId: input.conversationId,
			actorId: input.assignee.id,
			onBehalfOfId: input.assignee.ownerId,
			type: "task.created",
			payload: { taskId: row.id, title: row.title },
		});
		await insertLog(tx, row.id, "prompt", {
			text: input.goal,
			byId: input.requesterId,
		});
		return toTask(row);
	});
	await publish(s, task);
	return task;
}

async function insertLog<K extends TaskLogKind>(
	tx: Scoped,
	taskId: string,
	kind: K,
	payload: TaskLogPayload<K>,
): Promise<TaskLog> {
	const parsed = TASK_LOG_PAYLOAD_SCHEMAS[kind].parse(payload);
	const [bumped] = await tx.executor
		.update(tasks)
		.set({ lastLogSeq: sql`${tasks.lastLogSeq} + 1`, updatedAt: new Date() })
		.where(tx.where(tasks, eq(tasks.id, taskId)))
		.returning({ seq: tasks.lastLogSeq });
	if (!bumped) throw notFound("任务不存在");
	const row = await tx.insert(taskLogs, {
		taskId,
		seq: bumped.seq,
		kind,
		payload: parsed,
	});
	return toTaskLog(row);
}

/** 追加一条过程日志（同时算作一次活动：刷新 updated_at）。 */
export async function appendTaskLog<K extends TaskLogKind>(
	s: Scoped,
	taskId: string,
	kind: K,
	payload: TaskLogPayload<K>,
): Promise<TaskLog> {
	return s.transaction((tx) => insertLog(tx, taskId, kind, payload));
}

/** 按 kind 校验一段来自 Runner 的日志载荷；不合法 → null。 */
export function parseLogPayload(
	kind: TaskLogKind,
	payload: unknown,
): TaskLogPayload<TaskLogKind> | null {
	const parsed = TASK_LOG_PAYLOAD_SCHEMAS[kind].safeParse(payload);
	return parsed.success ? parsed.data : null;
}

export type TransitionOptions = {
	/** 进度或结果的一段话。 */
	summary?: string;
	artifacts?: TaskArtifact[];
};

/**
 * 迁移任务状态。不允许的迁移（含已结束、或并发下已被别处迁移）→ null，不改任何东西。
 * 非结束态落 `task.updated`，结束态落 `task.ended` 并记下 endedAt。
 */
export async function transitionTask(
	s: Scoped,
	taskId: string,
	to: TaskState,
	opts: TransitionOptions = {},
): Promise<Task | null> {
	const current = await requireTask(s, taskId);
	if (!canTransition(current.state, to)) return null;
	const summary =
		opts.summary !== undefined ? clip(opts.summary) : current.resultSummary;
	const artifacts = opts.artifacts ?? current.artifacts;
	const ended = isTaskEnded(to);
	const next = await transactWithEvents(s, async (tx, append) => {
		const [row] = await tx.executor
			.update(tasks)
			.set({
				state: to,
				resultSummary: summary,
				artifacts,
				...(ended ? { endedAt: new Date() } : {}),
			})
			.where(
				tx.where(tasks, eq(tasks.id, taskId), eq(tasks.state, current.state)),
			)
			.returning();
		if (!row) return null;
		const task = toTask(row);
		const actor = await tx.first(
			principals,
			eq(principals.id, task.assigneeId),
		);
		const base = {
			conversationId: task.conversationId,
			actorId: task.assigneeId,
			onBehalfOfId: actor?.ownerId ?? null,
		};
		if (ended) {
			await append({
				...base,
				type: "task.ended",
				payload: {
					taskId,
					state: to,
					summary: task.resultSummary ?? "",
					artifacts: task.artifacts,
				},
			});
		} else {
			await append({
				...base,
				type: "task.updated",
				payload: {
					taskId,
					state: to,
					...(opts.summary !== undefined && task.resultSummary
						? { summary: task.resultSummary }
						: {}),
				},
			});
		}
		await insertLog(tx, taskId, "state", { state: to });
		return task;
	});
	if (next) await publish(s, next);
	return next;
}

/** 进行中的进度、产出与外部会话 id：只推帧，不落会话事件。已结束的任务不再变化。 */
export async function updateTaskProgress(
	s: Scoped,
	taskId: string,
	patch: {
		summary?: string;
		artifacts?: TaskArtifact[];
		externalSessionId?: string;
	},
): Promise<Task | null> {
	const set: Partial<TaskRow> = {};
	if (patch.summary !== undefined) set.resultSummary = clip(patch.summary);
	if (patch.artifacts !== undefined) set.artifacts = patch.artifacts;
	if (patch.externalSessionId !== undefined)
		set.externalSessionId = patch.externalSessionId;
	if (Object.keys(set).length === 0) return null;
	const [row] = await s.executor
		.update(tasks)
		.set(set)
		.where(s.where(tasks, eq(tasks.id, taskId), notInArray(tasks.state, ENDED)))
		.returning();
	if (!row) return null;
	const task = toTask(row);
	await publish(s, task);
	return task;
}

/** 追加产出（按 ref 去重，保持先后）。 */
export function withArtifact(
	list: readonly TaskArtifact[],
	artifact: TaskArtifact,
): TaskArtifact[] | null {
	if (list.some((a) => a.kind === artifact.kind && a.ref === artifact.ref))
		return null;
	return [...list, artifact];
}

/** 本人能否结束这个任务：只有外部任务可以，且只有执行者的本人。 */
export async function requireOwnExternalTask(
	s: Scoped,
	me: PrincipalRow,
	taskId: string,
): Promise<Task> {
	const task = await requireVisibleTask(s, me, taskId);
	const assignee = await s.first(
		principals,
		eq(principals.id, task.assigneeId),
	);
	if (task.engine !== "acp" || assignee?.ownerId !== me.id)
		throw new AppError(
			403,
			ERROR_CODES.FORBIDDEN,
			"只能结束自己外部助手的任务",
		);
	if (isTaskEnded(task.state))
		throw new AppError(409, ERROR_CODES.TASK_ENDED, "任务已经结束");
	return task;
}

/** 超过 24 小时没有任何活动的未结束任务（updated_at 早于 now - 24h）。 */
export async function idleTasks(s: Scoped, now: Date): Promise<Task[]> {
	const before = new Date(now.getTime() - TASK_IDLE_COMPLETE_MS);
	const rows = await s.select(
		tasks,
		notInArray(tasks.state, ENDED),
		lt(tasks.updatedAt, before),
	);
	return rows.map(toTask);
}
