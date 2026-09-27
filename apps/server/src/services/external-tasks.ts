/**
 * 外部助手的任务：一个任务对应设备 Runner 上的一个 ACP 会话。
 *
 * - 交办：本人在与外部助手的私聊里发消息——有未结束的任务即为追问（继续同一 ACP 会话），
 *   否则开新任务；"新任务"先完成当前任务再开；代理为本人交办时在本人与它的私聊里开新任务并等这一轮结束；
 * - 一轮进行中又来的追问排队，这一轮结束后依次发出；一轮结束（ACP stopReason）→ input_required；
 * - 权限请求（含 agent 要开终端执行命令）→ `requestApproval`：任务置 awaiting_approval，
 *   本人所选选项原样回给 agent，10 分钟未处理视为拒绝；
 * - 完成、取消、闲置 24 小时自动完成、设备吊销、服务重启：任务结束并让 Runner 终止 agent 进程；
 * - Runner 重连时上报仍在跑的任务：已结束的让它终止，丢失的判失败。
 *
 * 进程内只保存排队的追问、等待中的审批与打断信号；其余状态都在库里。
 */
import {
	type AcpUp,
	AGENT_ACP_CAPABILITY,
	type Agent,
	APPROVAL_TIMEOUT_MS,
	isTaskEnded,
	type Task,
	type TaskLogKind,
} from "@orgos/protocol";
import { eq, isNull } from "drizzle-orm";
import { framesFor } from "@/agent/frames";
import { principals, runners, tasks } from "@/db/schema";
import {
	type RunnerRow,
	type Scoped,
	scoped,
	tenantsWithOpenTasks,
} from "@/db/scope";
import { toTask } from "@/lib/serialize";
import { type RunnerHub, runnerHub } from "@/realtime/runner-hub";
import { memberPrincipals, openDm } from "@/services/conversations";
import {
	appendTaskLog,
	createTask,
	idleTasks,
	openTaskOf,
	parseLogPayload,
	requireTask,
	transitionTask,
	updateTaskProgress,
	waitForTask,
	withArtifact,
} from "@/services/tasks";
import {
	type ApprovalDecision,
	cancelTaskApprovals,
	requestApproval,
} from "@/services/work-items";

export const OFFLINE_SUMMARY = "设备离线，任务没有开始";
export const REVOKED_SUMMARY = "设备已被吊销，任务中断";
export const RESTART_SUMMARY = "服务重启，任务中断";
export const LOST_SUMMARY = "设备上的外部助手已不在运行，任务中断";
export const IDLE_SUMMARY = "24 小时没有活动，已自动完成";
export const BUSY_TEXT = "手上还有未结束的任务，请本人先在与它的私聊里处理";
export const UNDELIVERED_TEXT = "设备离线，这条追问没有送达";

const WORKING_LABEL = "正在处理任务…";
const APPROVAL_LABEL = "等你批准…";

type Runtime = {
	/** 一轮进行中到来的追问，这一轮结束后依次发出。 */
	queue: string[];
	/** 任务结束时触发：等待中的审批随之取消。 */
	abort: AbortController;
	/** 等本人决定的权限请求数。 */
	pendingPermissions: number;
	/** 最近一段连续的文字（工具调用或新一轮会把它清空）：卡片上的进度摘要。 */
	text: string;
};

export type ExternalTasksOptions = { approvalTimeoutMs: number };

/** 这一轮已经结束（等本人追问或已结束）。 */
function turnOver(task: Task): boolean {
	return task.state === "input_required" || isTaskEnded(task.state);
}

export class ExternalTasks {
	private readonly runtimes = new Map<string, Runtime>();
	/** 同一任务的处理串行：Runner 的帧、追问、审批的回传按到达顺序一件件来。 */
	private readonly chains = new Map<string, Promise<unknown>>();

	constructor(
		readonly options: ExternalTasksOptions = {
			approvalTimeoutMs: APPROVAL_TIMEOUT_MS,
		},
		private readonly hub: RunnerHub = runnerHub,
	) {}

	private runtime(taskId: string): Runtime {
		let rt = this.runtimes.get(taskId);
		if (!rt) {
			rt = {
				queue: [],
				abort: new AbortController(),
				pendingPermissions: 0,
				text: "",
			};
			this.runtimes.set(taskId, rt);
		}
		return rt;
	}

	private serial<R>(taskId: string, job: () => Promise<R>): Promise<R> {
		const prev = this.chains.get(taskId) ?? Promise.resolve();
		const next = prev.then(job, job);
		const tail = next.catch(() => {});
		this.chains.set(taskId, tail);
		void tail.then(() => {
			if (this.chains.get(taskId) === tail) this.chains.delete(taskId);
		});
		return next;
	}

	/** 任务结束：取消等待中的审批、忘掉排队的追问。 */
	private release(taskId: string): void {
		this.runtimes.get(taskId)?.abort.abort();
		this.runtimes.delete(taskId);
	}

	/** 私聊里外部助手的团子：进行中 working，其余 idle。 */
	private async showActivity(s: Scoped, task: Task): Promise<void> {
		const members = await memberPrincipals(s, task.conversationId);
		const frames = framesFor([...members.keys()], {
			conversationId: task.conversationId,
			agentId: task.assigneeId,
			runId: task.id,
		});
		if (task.state === "working") frames.status("tool", WORKING_LABEL);
		else if (task.state === "awaiting_approval")
			frames.status("tool", APPROVAL_LABEL);
		else frames.status("idle");
	}

	private async move(
		s: Scoped,
		taskId: string,
		to: Task["state"],
		summary?: string,
	): Promise<Task | null> {
		const next = await transitionTask(
			s,
			taskId,
			to,
			summary === undefined ? {} : { summary },
		);
		if (!next) return null;
		if (isTaskEnded(next.state)) {
			this.release(next.id);
			if (next.runnerId)
				this.hub.send(next.runnerId, { t: "acp_cancel", taskId: next.id });
			await cancelTaskApprovals(s, next.id);
		}
		await this.showActivity(s, next);
		return next;
	}

	// ─────────────────────────── 交办 ───────────────────────────

	/**
	 * 在会话里给外部助手开一个新任务：建任务、让设备起 agent 进程并发出第一段话。
	 * 设备不可用时任务直接失败（卡片上写明原因）。
	 */
	private async start(
		s: Scoped,
		agent: Agent,
		conversationId: string,
		requesterId: string,
		goal: string,
	): Promise<Task> {
		const ownerId = agent.principal.ownerId ?? "";
		const task = await createTask(s, {
			conversationId,
			requesterId,
			assignee: { id: agent.principal.id, ownerId },
			onBehalfOfId: ownerId,
			goal,
			engine: "acp",
			adapter: agent.adapter ?? null,
			runnerId: agent.runnerId,
			workspace: agent.workspace ?? null,
		});
		const runner = agent.runnerId
			? await s.first(
					runners,
					eq(runners.id, agent.runnerId),
					isNull(runners.revokedAt),
				)
			: undefined;
		if (!runner || !agent.adapter || !agent.workspace)
			return (await this.move(s, task.id, "failed", REVOKED_SUMMARY)) ?? task;
		const { adapter, workspace } = agent;
		return this.serial(task.id, async () => {
			this.runtime(task.id);
			// 先置 working 再下发：Runner 的回帧不会早于这次迁移。
			const working = (await this.move(s, task.id, "working")) ?? task;
			const sent = this.hub.send(runner.id, {
				t: "acp_start",
				taskId: task.id,
				adapter,
				workspace,
				prompt: goal,
			});
			if (sent) return working;
			return (await this.move(s, task.id, "failed", OFFLINE_SUMMARY)) ?? task;
		});
	}

	/** 同一任务的追问：这一轮已结束则立即发出，否则排队。 */
	private followUp(s: Scoped, open: Task, text: string): Promise<Task> {
		return this.serial(open.id, async () => {
			await appendTaskLog(s, open.id, "prompt", {
				text,
				byId: open.onBehalfOfId,
			});
			const task = await requireTask(s, open.id);
			if (isTaskEnded(task.state)) return task;
			if (task.state !== "input_required" || !task.runnerId) {
				this.runtime(task.id).queue.push(text);
				return task;
			}
			this.runtime(task.id).text = "";
			const working = (await this.move(s, task.id, "working")) ?? task;
			if (
				this.hub.send(task.runnerId, {
					t: "acp_prompt",
					taskId: task.id,
					prompt: text,
				})
			)
				return working;
			await appendTaskLog(s, task.id, "error", { message: UNDELIVERED_TEXT });
			return (
				(await this.move(s, task.id, "input_required", UNDELIVERED_TEXT)) ??
				working
			);
		});
	}

	/**
	 * 本人在与外部助手的私聊里发了一条消息：有未结束的任务 → 追问；否则开新任务。
	 */
	async onOwnerMessage(
		s: Scoped,
		agent: Agent,
		conversationId: string,
		event: { actorId: string; text: string },
	): Promise<Task> {
		const open = await openTaskOf(s, conversationId, agent.principal.id);
		if (open) return this.followUp(s, open, event.text);
		return this.start(s, agent, conversationId, event.actorId, event.text);
	}

	/** "新任务"：当前未结束的任务先完成，再开一个。 */
	async startNew(
		s: Scoped,
		agent: Agent,
		conversationId: string,
		requesterId: string,
		goal: string,
	): Promise<Task> {
		const open = await openTaskOf(s, conversationId, agent.principal.id);
		if (open) await this.move(s, open.id, "completed");
		return this.start(s, agent, conversationId, requesterId, goal);
	}

	/**
	 * 代理为本人把一件活交给外部助手：在本人与它的私聊里开新任务，等这一轮结束
	 * （等本人追问或任务结束），交回这一轮的任务。它手上有未结束的任务时不接新活。
	 */
	async delegate(
		s: Scoped,
		agent: Agent,
		input: { requesterId: string; goal: string; signal: AbortSignal },
	): Promise<{ task: Task } | { busy: true }> {
		const owner = await s.first(
			principals,
			eq(principals.id, agent.principal.ownerId ?? ""),
		);
		if (!owner) throw new Error("外部助手没有本人");
		const { conversation } = await openDm(s, owner, agent.principal.id);
		if (await openTaskOf(s, conversation.id, agent.principal.id))
			return { busy: true };
		const task = await this.start(
			s,
			agent,
			conversation.id,
			input.requesterId,
			input.goal,
		);
		return { task: await waitForTask(s, task.id, turnOver, input.signal) };
	}

	// ─────────────────────────── 结束与打断 ───────────────────────────

	async complete(s: Scoped, task: Task): Promise<Task> {
		return (
			(await this.move(s, task.id, "completed")) ?? requireTask(s, task.id)
		);
	}

	async cancel(s: Scoped, task: Task): Promise<Task> {
		return (
			(await this.move(s, task.id, "canceled", "已停止")) ??
			requireTask(s, task.id)
		);
	}

	/** 输入框的"停止"：打断会话里外部助手正在进行的这一轮（任务保留）。 */
	async interrupt(s: Scoped, conversationId: string): Promise<void> {
		const rows = await s.select(
			tasks,
			eq(tasks.conversationId, conversationId),
		);
		for (const row of rows) {
			const task = toTask(row);
			if (task.engine !== "acp" || !task.runnerId) continue;
			if (task.state !== "working" && task.state !== "awaiting_approval")
				continue;
			this.runtime(task.id).queue.length = 0;
			this.hub.send(task.runnerId, { t: "acp_interrupt", taskId: task.id });
		}
	}

	/** 外部助手被删除：它的未结束任务一并取消。 */
	async onAgentRetired(s: Scoped, openTasks: readonly Task[]): Promise<void> {
		for (const task of openTasks)
			await this.move(s, task.id, "canceled", "外部助手已删除");
	}

	/** 设备被吊销：在它上面进行的任务失败。 */
	async onRunnerRevoked(s: Scoped, runnerId: string): Promise<void> {
		const rows = await s.select(tasks, eq(tasks.runnerId, runnerId));
		for (const row of rows)
			if (!isTaskEnded(row.state))
				await this.move(s, row.id, "failed", REVOKED_SUMMARY);
	}

	// ─────────────────────────── Runner 的上行 ───────────────────────────

	/** 这台设备上的某个任务；不是它的或不存在 → null。 */
	private async taskOn(
		s: Scoped,
		runner: RunnerRow,
		taskId: string,
	): Promise<Task | null> {
		const row = await s.first(
			tasks,
			eq(tasks.id, taskId),
			eq(tasks.runnerId, runner.id),
		);
		return row ? toTask(row) : null;
	}

	onRunnerFrame(runner: RunnerRow, frame: AcpUp): Promise<void> {
		return this.serial(frame.taskId, async () => {
			const s = scoped(runner.tenantId);
			const task = await this.taskOn(s, runner, frame.taskId);
			if (!task) {
				this.hub.send(runner.id, { t: "acp_cancel", taskId: frame.taskId });
				return;
			}
			if (isTaskEnded(task.state)) return;
			switch (frame.t) {
				case "acp_event":
					await this.onEvent(s, task, frame.kind, frame.payload);
					return;
				case "acp_turn_end":
					await this.onTurnEnd(s, task, frame.stopReason, frame.sessionId);
					return;
				case "acp_permission":
					await this.onPermission(s, runner, task, frame);
					return;
			}
		});
	}

	private async onEvent(
		s: Scoped,
		task: Task,
		kind: TaskLogKind,
		raw: unknown,
	): Promise<void> {
		if (kind === "prompt") return;
		const payload = parseLogPayload(kind, raw);
		if (!payload) {
			console.warn(`[acp] 丢弃不合法的 ${kind} 记录`);
			return;
		}
		await appendTaskLog(s, task.id, kind, payload as never);
		const rt = this.runtime(task.id);
		if (kind === "tool_call") rt.text = "";
		if (kind === "agent_text" && "text" in payload && payload.text.trim()) {
			rt.text += payload.text;
			await updateTaskProgress(s, task.id, { summary: rt.text });
		} else if (kind === "tool_result" && "ok" in payload) {
			const artifacts =
				payload.ok && payload.path
					? withArtifact(task.artifacts, {
							kind: "file",
							label: payload.path.split("/").at(-1) ?? payload.path,
							ref: payload.path,
						})
					: null;
			if (artifacts) await updateTaskProgress(s, task.id, { artifacts });
		} else if (kind === "state" && "state" in payload) {
			if (payload.sessionId && payload.sessionId !== task.externalSessionId)
				await updateTaskProgress(s, task.id, {
					externalSessionId: payload.sessionId,
				});
		} else if (kind === "error" && "fatal" in payload && payload.fatal) {
			await this.move(s, task.id, "failed", payload.message);
		}
	}

	private async onTurnEnd(
		s: Scoped,
		task: Task,
		stopReason: string,
		sessionId: string | null,
	): Promise<void> {
		if (sessionId && sessionId !== task.externalSessionId)
			await updateTaskProgress(s, task.id, { externalSessionId: sessionId });
		const notice = STOP_NOTICE[stopReason];
		if (notice) await appendTaskLog(s, task.id, "error", { message: notice });
		const rt = this.runtime(task.id);
		const next = rt.queue.shift();
		if (next !== undefined && task.runnerId) {
			rt.text = "";
			if (
				this.hub.send(task.runnerId, {
					t: "acp_prompt",
					taskId: task.id,
					prompt: next,
				})
			)
				return;
		}
		if (task.state === "awaiting_approval")
			await this.move(s, task.id, "working");
		await this.move(s, task.id, "input_required", notice);
	}

	/**
	 * 权限请求：在任务的串行链里置 awaiting_approval 并记一笔；等本人决定不占着链
	 * （等待期间 Runner 的其他帧照常处理）；决定到了再排回链里回传选项、记一笔、视情况回到 working。
	 */
	private async onPermission(
		s: Scoped,
		runner: RunnerRow,
		task: Task,
		frame: Extract<AcpUp, { t: "acp_permission" }>,
	): Promise<void> {
		const rt = this.runtime(task.id);
		rt.pendingPermissions += 1;
		if (task.state === "working")
			await this.move(s, task.id, "awaiting_approval");
		const { toolCall, options } = frame;
		await appendTaskLog(s, task.id, "permission", {
			title: toolCall.title,
			options,
			...(toolCall.rawInput === undefined ? {} : { input: toolCall.rawInput }),
		});
		const agent = await s.first(principals, eq(principals.id, task.assigneeId));
		const name = agent?.displayName ?? "外部助手";
		const terminal = frame.source === "terminal";
		const command = commandOf(toolCall.rawInput) ?? toolCall.title;
		void requestApproval(s, {
			agentId: task.assigneeId,
			conversationId: task.conversationId,
			runnerId: runner.id,
			runnerName: runner.name,
			capability: terminal ? "shell.exec" : AGENT_ACP_CAPABILITY,
			args: terminal ? { command } : (toolCall.rawInput ?? {}),
			title: terminal
				? `${name}想在“${runner.name}”上执行命令`
				: `${name}请求：${toolCall.title}`,
			body: terminal ? command : toolCall.title,
			acp: { taskId: task.id, toolCall, options },
			signal: rt.abort.signal,
			timeoutMs: this.options.approvalTimeoutMs,
		})
			.catch((e): ApprovalDecision => {
				console.error("[acp] 审批出错", e);
				return { outcome: "cancelled" };
			})
			.then((decision) =>
				this.serial(task.id, () =>
					this.afterDecision(s, runner, task.id, frame, decision),
				),
			)
			.catch((e) => console.error("[acp] 回传审批结果出错", e));
	}

	private async afterDecision(
		s: Scoped,
		runner: RunnerRow,
		taskId: string,
		frame: Extract<AcpUp, { t: "acp_permission" }>,
		decision: ApprovalDecision,
	): Promise<void> {
		this.hub.send(runner.id, {
			t: "acp_permission_reply",
			taskId,
			requestId: frame.requestId,
			optionId: decision.optionId ?? null,
		});
		await appendTaskLog(s, taskId, "permission", {
			title: frame.toolCall.title,
			optionId: decision.optionId ?? null,
			outcome: decision.outcome,
		});
		const rt = this.runtimes.get(taskId);
		if (!rt) return;
		rt.pendingPermissions -= 1;
		const now = await requireTask(s, taskId);
		if (rt.pendingPermissions <= 0 && now.state === "awaiting_approval")
			await this.move(s, taskId, "working");
	}

	/**
	 * Runner 连上：它上报的在跑任务里，已结束或不属于它的让它终止；
	 * 库里仍未结束、它却不再运行的任务判失败。
	 */
	async onRunnerHello(
		runner: RunnerRow,
		running: readonly string[],
	): Promise<void> {
		const s = scoped(runner.tenantId);
		const reported = new Set(running);
		for (const id of reported) {
			const task = await this.taskOn(s, runner, id);
			if (!task || isTaskEnded(task.state))
				this.hub.send(runner.id, { t: "acp_cancel", taskId: id });
		}
		const rows = await s.select(tasks, eq(tasks.runnerId, runner.id));
		for (const row of rows)
			if (!isTaskEnded(row.state) && !reported.has(row.id))
				await this.move(s, row.id, "failed", LOST_SUMMARY);
	}

	// ─────────────────────────── 维护 ───────────────────────────

	/** 24 小时没有活动的未结束任务自动完成。 */
	async sweepIdle(now = new Date()): Promise<number> {
		let n = 0;
		for (const tenantId of await tenantsWithOpenTasks()) {
			const s = scoped(tenantId);
			for (const task of await idleTasks(s, now))
				if (await this.move(s, task.id, "completed", IDLE_SUMMARY)) n += 1;
		}
		return n;
	}

	/** 进程启动：上一个进程留下的未结束任务都已失去运行时，判失败并取消它们的审批。 */
	async interruptAll(): Promise<void> {
		for (const tenantId of await tenantsWithOpenTasks()) {
			const s = scoped(tenantId);
			const rows = await s.select(tasks);
			for (const row of rows)
				if (!isTaskEnded(row.state))
					await this.move(s, row.id, "failed", RESTART_SUMMARY);
		}
	}
}

/** 非正常结束一轮时记一句说明（end_turn 与 error 不记：前者是正常收尾，后者 Runner 已报过错）。 */
const STOP_NOTICE: Record<string, string> = {
	cancelled: "这一轮已被打断",
	max_tokens: "外部助手因达到 token 上限停止了这一轮",
	max_turn_requests: "外部助手因达到单轮请求数上限停止了这一轮",
	refusal: "外部助手拒绝了这次请求",
};

function commandOf(input: unknown): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	const { command, args } = input as { command?: unknown; args?: unknown };
	if (typeof command !== "string") return undefined;
	return Array.isArray(args) && args.length > 0
		? [command, ...args.map(String)].join(" ")
		: command;
}

export const externalTasks = new ExternalTasks();
