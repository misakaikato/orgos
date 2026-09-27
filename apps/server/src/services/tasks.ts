/**
 * 任务：带状态的话题（kind=task 的话题恰好对应一个当前任务）。代理之间的交办、本人把话题转为任务、
 * "新任务"都经这里。写入只经本文件：建任务、状态迁移、进度与产出、过程日志。
 *
 * - 状态迁移按 protocol 的 `TASK_TRANSITIONS` 判定，条件更新（WHERE state = from）防并发；
 *   迁移在任务话题落 `task.updated`，进入结束态落 `task.ended` 并为该话题排一个提炼作业；
 *   运行的开始与结束经 `@/services/runs` 驱动迁移；
 * - 进度与产出变化只推 `{t:'task'}` 帧，不落会话事件；
 * - 过程日志只追加：服务于任务的记录 seq 取自 `tasks.last_log_seq`（任务内连续），
 *   不服务于任务的运行的记录 seq 取自 `runs.last_log_seq`（运行内连续）。
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
import {
	and,
	asc,
	desc,
	eq,
	gt,
	inArray,
	lt,
	notInArray,
	or,
	sql,
} from "drizzle-orm";
import {
	conversationMembers,
	principals,
	runs,
	taskLogs,
	tasks,
} from "@/db/schema";
import type { PrincipalRow, Scoped } from "@/db/scope";
import { AppError, notFound } from "@/lib/errors";
import { toPrincipal, toRunLog, toTask, toTaskLog } from "@/lib/serialize";
import { isUuid } from "@/lib/uuid";
import { enqueueMemoryJob } from "@/memory/queue";
import { browserHub } from "@/realtime/browser-hub";
import { requireConversation } from "@/services/conversations";
import { transactWithEvents } from "@/services/events";
import {
	attachTask,
	insertTopic,
	publishTopic,
	type TopicRow,
} from "@/services/topics";

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

/** 我看得到的任务：我是任务所在会话的成员，或任务是为我办的。否则 404。 */
export async function requireVisibleTask(
	s: Scoped,
	me: PrincipalRow,
	taskId: string,
): Promise<Task> {
	const task = await requireTask(s, taskId);
	if (task.onBehalfOfId === me.id || task.requesterId === me.id) return task;
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
					: or(
							inArray(tasks.conversationId, mine),
							eq(tasks.onBehalfOfId, me.id),
						),
				query.state ? eq(tasks.state, query.state) : undefined,
			),
		)
		.orderBy(desc(tasks.createdAt))
		.limit(200);
	return rows.map(toTask);
}

/** 话题当前的任务（仍未结束的）；没有则 null。 */
export async function openTaskOfTopic(
	s: Scoped,
	topic: Pick<TopicRow, "taskId">,
): Promise<Task | null> {
	if (!topic.taskId) return null;
	const row = await s.first(
		tasks,
		eq(tasks.id, topic.taskId),
		notInArray(tasks.state, ENDED),
	);
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

/** 某台设备上的外部助手全部未结束的任务。 */
export async function openTasksOnRunner(
	s: Scoped,
	runnerId: string,
): Promise<Task[]> {
	const rows = await s.select(
		tasks,
		eq(tasks.runnerId, runnerId),
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
	return rows.map((r) => toTaskLog({ ...r, taskId }));
}

/** 一次运行的过程记录（不论是否记在任务名下），按写入顺序。 */
export async function listRunLogs(s: Scoped, runId: string) {
	const rows = await s.executor
		.select()
		.from(taskLogs)
		.where(s.where(taskLogs, eq(taskLogs.runId, runId)))
		.orderBy(asc(taskLogs.id));
	return rows.map(toRunLog);
}

// ─────────────────────────── 推送 ───────────────────────────

async function recipientsOf(s: Scoped, task: Task): Promise<string[]> {
	const rows = await s.select(
		conversationMembers,
		eq(conversationMembers.conversationId, task.conversationId),
	);
	return [...new Set([...rows.map((r) => r.principalId), task.onBehalfOfId])];
}

/** 任务变了：推给任务所在会话的成员与委托人，并通知进程内的等待者。 */
async function publish(s: Scoped, task: Task): Promise<void> {
	emit(task);
	browserHub.sendTo(await recipientsOf(s, task), { t: "task", task });
}

// ─────────────────────────── 写入 ───────────────────────────

export type CreateTaskInput = {
	conversationId: string;
	/** 把已有的话题转为任务；不给则在会话里新开一个任务话题（标题取目标）。 */
	topic?: TopicRow;
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
 * 建一个 submitted 任务并让话题指向它（新开或转为任务话题），在该话题落 `task.created`
 * （actor 为执行者，代其本人），同时记下第一段话（prompt 日志）。返回任务与它的话题。
 */
export async function createTask(
	s: Scoped,
	input: CreateTaskInput,
): Promise<{ task: Task; topic: TopicRow }> {
	const created = await transactWithEvents(s, async (tx, append) => {
		const bare =
			input.topic ??
			(await insertTopic(tx, {
				conversationId: input.conversationId,
				title: taskTitleOf(input.goal),
				kind: "task",
				createdBy: input.requesterId,
			}));
		const row = await tx.insert(tasks, {
			conversationId: input.conversationId,
			topicId: bare.id,
			requesterId: input.requesterId,
			assigneeId: input.assignee.id,
			onBehalfOfId: input.onBehalfOfId,
			title: input.topic ? input.topic.title : taskTitleOf(input.goal),
			goal: input.goal,
			state: "submitted",
			engine: input.engine,
			adapter: input.adapter ?? null,
			runnerId: input.runnerId ?? null,
			workspace: input.workspace ?? null,
		});
		const topic = await attachTask(tx, bare.id, row.id);
		await append({
			conversationId: input.conversationId,
			topicId: topic.id,
			actorId: input.assignee.id,
			onBehalfOfId: input.assignee.ownerId,
			type: "task.created",
			payload: { taskId: row.id, title: row.title },
		});
		await insertLog(tx, { taskId: row.id }, "prompt", {
			text: input.goal,
			byId: input.requesterId,
		});
		return { task: toTask(row), topic };
	});
	await publish(s, created.task);
	await publishTopic(s, created.topic);
	return created;
}

/** 日志记在谁名下：服务于任务的记在任务名下，否则记在运行名下。 */
export type LogOwner =
	| { taskId: string; runId?: string | null }
	| {
			taskId?: null;
			runId: string;
	  };

async function insertLog<K extends TaskLogKind>(
	tx: Scoped,
	owner: LogOwner,
	kind: K,
	payload: TaskLogPayload<K>,
): Promise<TaskLog | null> {
	const parsed = TASK_LOG_PAYLOAD_SCHEMAS[kind].parse(payload);
	const runId = owner.runId ?? null;
	let seq: number | undefined;
	if (owner.taskId) {
		const [bumped] = await tx.executor
			.update(tasks)
			.set({ lastLogSeq: sql`${tasks.lastLogSeq} + 1`, updatedAt: new Date() })
			.where(tx.where(tasks, eq(tasks.id, owner.taskId)))
			.returning({ seq: tasks.lastLogSeq });
		if (!bumped) throw notFound("任务不存在");
		seq = bumped.seq;
	} else if (runId) {
		const [bumped] = await tx.executor
			.update(runs)
			.set({ lastLogSeq: sql`${runs.lastLogSeq} + 1` })
			.where(tx.where(runs, eq(runs.id, runId)))
			.returning({ seq: runs.lastLogSeq });
		if (!bumped) throw notFound("运行不存在");
		seq = bumped.seq;
	}
	if (seq === undefined) return null;
	const row = await tx.insert(taskLogs, {
		taskId: owner.taskId ?? null,
		runId,
		seq,
		kind,
		payload: parsed,
	});
	return row.taskId ? toTaskLog({ ...row, taskId: row.taskId }) : null;
}

/** 追加一条过程日志（记在任务名下时同时算作任务的一次活动：刷新 updated_at）。 */
export async function appendTaskLog<K extends TaskLogKind>(
	s: Scoped,
	owner: LogOwner,
	kind: K,
	payload: TaskLogPayload<K>,
): Promise<void> {
	await s.transaction((tx) => insertLog(tx, owner, kind, payload));
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
	/** 促成这次迁移的运行（记进状态日志）。 */
	runId?: string | null;
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
			topicId: row.topicId,
			actorId: task.assigneeId,
			onBehalfOfId: actor?.ownerId ?? null,
		};
		if (ended) {
			await enqueueMemoryJob(tx, { topicId: row.topicId, trigger: "task_end" });
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
		await insertLog(tx, { taskId, runId: opts.runId ?? null }, "state", {
			state: to,
		});
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

/** 本人能否结束这个任务：只有执行者的本人，且任务尚未结束。 */
export async function requireOwnOpenTask(
	s: Scoped,
	me: PrincipalRow,
	taskId: string,
): Promise<Task> {
	const task = await requireVisibleTask(s, me, taskId);
	const assignee = await s.first(
		principals,
		and(eq(principals.id, task.assigneeId)),
	);
	if (assignee?.ownerId !== me.id)
		throw new AppError(403, ERROR_CODES.FORBIDDEN, "只能结束自己代理的任务");
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
