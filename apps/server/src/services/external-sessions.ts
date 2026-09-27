/**
 * 外部助手的会话：每个话题一个 ACP 会话（主线也是一个），开在外部助手绑定的设备上。
 * Runner 帧里的 taskId 是会话槽的标识，服务端填话题 id。
 *
 * - 本人在与外部助手的私聊里发消息：进这条消息所在话题的 ACP 会话（没有则起一个）；
 *   每发出一段话就是一次运行（`@/services/runs`），这一轮结束（ACP stopReason）时运行结束，
 *   这一轮最后一段连续的文字作为外部助手的消息发在该话题里；
 * - 一轮进行中又来的消息排队，这一轮结束后依次发出（各自一次运行）；
 * - 话题是任务话题时，运行服务于该任务：任务随运行进入 working / 等本人（input_required），
 *   进度与产出写进任务；
 * - 权限请求（含 agent 要开终端执行命令）→ `requestApproval`：卡片落在该话题，任务置 awaiting_approval，
 *   本人所选选项原样回给 agent，10 分钟未处理视为拒绝；运行结束时仍未处理的审批随之取消；
 * - 代理为本人交办：在本人与它的私聊里新开任务话题，在那里的 ACP 会话里交办，等这一轮结束；
 * - 话题归档、外部助手删除、设备吊销、闲置 24 小时：让 Runner 终止该话题的 agent 进程；
 *   Runner 重连时上报仍在跑的会话槽：认得的接回，认不得的让它终止。
 *
 * 进程内只保存会话槽（是否已在设备上起了会话、排队的消息、这一轮的文字与审批）；其余都在库里。
 */
import {
	type AcpUp,
	AGENT_ACP_CAPABILITY,
	type Agent,
	APPROVAL_TIMEOUT_MS,
	isExternalAgent,
	isTaskEnded,
	type Task,
	type TaskLogKind,
} from "@orgos/protocol";
import { eq, isNull } from "drizzle-orm";
import { framesFor, type RunFrames } from "@/agent/frames";
import { principals, runners } from "@/db/schema";
import {
	type RunnerRow,
	type Scoped,
	scoped,
	tenantsWithOpenTasks,
} from "@/db/scope";
import { type RunnerHub, runnerHub } from "@/realtime/runner-hub";
import { postAgentMessage } from "@/services/agent-events";
import { findAgent } from "@/services/agents";
import { memberPrincipals, openDm } from "@/services/conversations";
import {
	failDanglingRuns,
	finishRun,
	INTERRUPTED_SUMMARY,
	type RunEnd,
	setRunExternalSession,
	startRun,
} from "@/services/runs";
import {
	appendTaskLog,
	clip,
	createTask,
	idleTasks,
	type LogOwner,
	openTaskOfTopic,
	parseLogPayload,
	requireTask,
	transitionTask,
	updateTaskProgress,
	waitForTask,
	withArtifact,
} from "@/services/tasks";
import { findTopic } from "@/services/topics";
import {
	type ApprovalDecision,
	cancelRunApprovals,
	requestApproval,
} from "@/services/work-items";

export const OFFLINE_SUMMARY = "设备离线，这条没有送达";
export const REVOKED_SUMMARY = "设备已被吊销，外部助手不可用";
export const LOST_SUMMARY = "设备上的外部助手已不在运行，这一轮中断";
export const IDLE_SUMMARY = "24 小时没有活动，已自动完成";
export const RETIRED_SUMMARY = "外部助手已删除";

/** 会话槽闲置多久后让设备终止它的 agent 进程。 */
export const SLOT_IDLE_MS = 24 * 60 * 60 * 1000;

/** 运行记录里这一轮文字的摘要长度。 */
const RUN_SUMMARY_CHARS = 80;
const WORKING_LABEL = "正在处理…";
const APPROVAL_LABEL = "等你批准…";

type Turn = {
	runId: string;
	taskId: string | null;
	/** 这一轮最后一段连续的文字（工具调用会把它清空）：结束时作为消息发出。 */
	text: string;
	/** 这一轮结束时触发：等待中的审批随之取消。 */
	abort: AbortController;
	/** 等本人决定的权限请求数。 */
	pendingPermissions: number;
	frames: RunFrames;
};

type Pending = { text: string; triggerRef: string; requesterId: string };

type Slot = {
	topicId: string;
	conversationId: string;
	agentId: string;
	ownerId: string;
	runnerId: string;
	adapter: string;
	workspace: string;
	/** 设备上已为这个话题起了 ACP 会话。 */
	started: boolean;
	queue: Pending[];
	turn: Turn | null;
	lastActivity: number;
};

export type ExternalSessionsOptions = { approvalTimeoutMs: number };

type Place = { conversationId: string; topicId: string };

export class ExternalSessions {
	private readonly slots = new Map<string, Slot>();
	/** 同一话题的处理串行：Runner 的帧、新消息、审批的回传按到达顺序一件件来。 */
	private readonly chains = new Map<string, Promise<unknown>>();

	constructor(
		readonly options: ExternalSessionsOptions = {
			approvalTimeoutMs: APPROVAL_TIMEOUT_MS,
		},
		private readonly hub: RunnerHub = runnerHub,
	) {}

	private serial<R>(topicId: string, job: () => Promise<R>): Promise<R> {
		const prev = this.chains.get(topicId) ?? Promise.resolve();
		const next = prev.then(job, job);
		const tail = next.catch(() => {});
		this.chains.set(topicId, tail);
		void tail.then(() => {
			if (this.chains.get(topicId) === tail) this.chains.delete(topicId);
		});
		return next;
	}

	/** 该话题的会话槽（没有则按外部助手的绑定建一个，尚未在设备上起会话）。 */
	private slotFor(agent: Agent, place: Place): Slot | null {
		const existing = this.slots.get(place.topicId);
		if (existing) return existing;
		if (!agent.runnerId || !agent.adapter || !agent.workspace) return null;
		const slot: Slot = {
			...place,
			agentId: agent.principal.id,
			ownerId: agent.principal.ownerId ?? "",
			runnerId: agent.runnerId,
			adapter: agent.adapter,
			workspace: agent.workspace,
			started: false,
			queue: [],
			turn: null,
			lastActivity: Date.now(),
		};
		this.slots.set(place.topicId, slot);
		return slot;
	}

	private logOwner(turn: Turn): LogOwner {
		return turn.taskId
			? { taskId: turn.taskId, runId: turn.runId }
			: { runId: turn.runId };
	}

	private async framesOf(s: Scoped, slot: Slot, runId: string) {
		const members = await memberPrincipals(s, slot.conversationId);
		return framesFor([...members.keys()], {
			conversationId: slot.conversationId,
			topicId: slot.topicId,
			agentId: slot.agentId,
			runId,
		});
	}

	// ─────────────────────────── 发出一段话 ───────────────────────────

	/**
	 * 本人在与外部助手的私聊里发了一条消息：进这个话题的 ACP 会话。
	 * 这一轮还在进行时排队。外部助手不可用时这次运行直接失败，并在话题里说明原因。
	 */
	onOwnerMessage(
		s: Scoped,
		agent: Agent,
		place: Place,
		event: { id: number; actorId: string; text: string },
	): Promise<void> {
		return this.serial(place.topicId, async () => {
			const pending: Pending = {
				text: event.text,
				triggerRef: `event:${event.id}`,
				requesterId: event.actorId,
			};
			const slot = await this.usableSlot(s, agent, place, pending);
			if (!slot) return;
			slot.lastActivity = Date.now();
			if (slot.turn) slot.queue.push(pending);
			else await this.send(s, slot, pending);
		});
	}

	/** 外部助手绑定的设备仍可用时返回会话槽；否则记一次失败的运行并说明原因。 */
	private async usableSlot(
		s: Scoped,
		agent: Agent,
		place: Place,
		pending: Pending,
	): Promise<Slot | null> {
		const runner = agent.runnerId
			? await s.first(
					runners,
					eq(runners.id, agent.runnerId),
					isNull(runners.revokedAt),
				)
			: undefined;
		const slot = runner ? this.slotFor(agent, place) : null;
		if (slot) return slot;
		const run = await startRun(s, {
			agentId: agent.principal.id,
			...place,
			taskId: (await this.topicTask(s, place.topicId))?.id ?? null,
			trigger: pending.triggerRef,
			actingForId: agent.principal.ownerId ?? pending.requesterId,
			engine: "acp",
		});
		await finishRun(s, run.id, {
			state: "failed",
			summary: REVOKED_SUMMARY,
			taskSummary: REVOKED_SUMMARY,
		});
		await postAgentMessage(s, agent.principal.id, place, REVOKED_SUMMARY);
		return null;
	}

	private async topicTask(s: Scoped, topicId: string): Promise<Task | null> {
		const topic = await findTopic(s, topicId);
		return topic ? openTaskOfTopic(s, topic) : null;
	}

	/** 开一次运行并把这段话发给设备：没有会话先起会话（acp_start），否则继续同一会话（acp_prompt）。 */
	private async send(s: Scoped, slot: Slot, pending: Pending): Promise<void> {
		const task = await this.topicTask(s, slot.topicId);
		// 刚交办的任务：这段话就是任务目标，建任务时已记过。
		const logged = task?.state === "submitted" && task.goal === pending.text;
		const run = await startRun(s, {
			agentId: slot.agentId,
			conversationId: slot.conversationId,
			topicId: slot.topicId,
			taskId: task?.id ?? null,
			trigger: pending.triggerRef,
			actingForId: slot.ownerId,
			engine: "acp",
		});
		const turn: Turn = {
			runId: run.id,
			taskId: task?.id ?? null,
			text: "",
			abort: new AbortController(),
			pendingPermissions: 0,
			frames: await this.framesOf(s, slot, run.id),
		};
		if (!logged)
			await appendTaskLog(s, this.logOwner(turn), "prompt", {
				text: pending.text,
				byId: pending.requesterId,
			});
		const sent = slot.started
			? this.hub.send(slot.runnerId, {
					t: "acp_prompt",
					taskId: slot.topicId,
					prompt: pending.text,
				})
			: this.hub.send(slot.runnerId, {
					t: "acp_start",
					taskId: slot.topicId,
					adapter: slot.adapter,
					workspace: slot.workspace,
					prompt: pending.text,
				});
		if (!sent) {
			await appendTaskLog(s, this.logOwner(turn), "error", {
				message: OFFLINE_SUMMARY,
			});
			await finishRun(s, run.id, {
				state: "failed",
				summary: OFFLINE_SUMMARY,
				taskSummary: OFFLINE_SUMMARY,
			});
			await postAgentMessage(s, slot.agentId, slot, OFFLINE_SUMMARY);
			return;
		}
		slot.started = true;
		slot.turn = turn;
		turn.frames.status("tool", WORKING_LABEL);
	}

	/** 这一轮结束：运行结束、文字（或失败原因）作为消息发出、未处理的审批取消，然后发出排队的下一段。 */
	private async endTurn(
		s: Scoped,
		slot: Slot,
		end: RunEnd,
		notice?: string,
	): Promise<void> {
		const turn = slot.turn;
		if (!turn) return;
		slot.turn = null;
		turn.abort.abort();
		turn.frames.status("idle");
		// 这一轮的文字发成外部助手的消息；没有文字却失败了，就把原因说出来。
		const text = turn.text.trim();
		const said = text || (end.state === "failed" ? (end.summary ?? "") : "");
		if (said) await postAgentMessage(s, slot.agentId, slot, said);
		if (notice)
			await appendTaskLog(s, this.logOwner(turn), "error", { message: notice });
		await finishRun(s, turn.runId, {
			...end,
			...(text || notice ? { taskSummary: text || notice } : {}),
		});
		await cancelRunApprovals(s, turn.runId);
		const next = slot.queue.shift();
		if (next) await this.send(s, slot, next);
	}

	// ─────────────────────────── 交办 ───────────────────────────

	/**
	 * 代理为本人把一件活交给外部助手：在本人与它的私聊里新开任务话题并在那里交办，
	 * 等这一轮结束（等本人追问或任务结束），交回任务。
	 */
	async delegate(
		s: Scoped,
		agent: Agent,
		input: {
			requesterId: string;
			goal: string;
			/** 交办它的那次运行。 */
			parentRunId: string;
			signal: AbortSignal;
		},
	): Promise<Task> {
		const owner = await s.first(
			principals,
			eq(principals.id, agent.principal.ownerId ?? ""),
		);
		if (!owner) throw new Error("外部助手没有本人");
		const { conversation } = await openDm(s, owner, agent.principal.id);
		const { task, topic } = await createTask(s, {
			conversationId: conversation.id,
			requesterId: input.requesterId,
			assignee: { id: agent.principal.id, ownerId: owner.id },
			onBehalfOfId: owner.id,
			goal: input.goal,
			engine: "acp",
			adapter: agent.adapter ?? null,
			runnerId: agent.runnerId,
			workspace: agent.workspace ?? null,
		});
		const place = { conversationId: conversation.id, topicId: topic.id };
		await this.serial(topic.id, async () => {
			const pending: Pending = {
				text: input.goal,
				triggerRef: `run:${input.parentRunId}`,
				requesterId: input.requesterId,
			};
			const slot = await this.usableSlot(s, agent, place, pending);
			if (slot) await this.send(s, slot, pending);
		});
		return waitForTask(
			s,
			task.id,
			(t) => t.state === "input_required" || isTaskEnded(t.state),
			input.signal,
		);
	}

	// ─────────────────────────── 结束与打断 ───────────────────────────

	private interruptTopic(topicId: string): void {
		const slot = this.slots.get(topicId);
		if (!slot?.turn) return;
		slot.queue.length = 0;
		this.hub.send(slot.runnerId, { t: "acp_interrupt", taskId: topicId });
	}

	/** 输入框的"停止"：打断会话（或其中某个话题）里外部助手正在进行的这一轮（会话保留）。 */
	interrupt(conversationId: string, topicId?: string): void {
		for (const slot of this.slots.values()) {
			if (slot.conversationId !== conversationId) continue;
			if (topicId && slot.topicId !== topicId) continue;
			this.interruptTopic(slot.topicId);
		}
	}

	/** 关掉一个话题的会话槽：让设备终止 agent 进程，进行中的一轮以 `end` 结束。 */
	private close(s: Scoped, topicId: string, end: RunEnd): Promise<void> {
		return this.serial(topicId, async () => {
			const slot = this.slots.get(topicId);
			if (!slot) return;
			slot.queue.length = 0;
			if (slot.started)
				this.hub.send(slot.runnerId, { t: "acp_cancel", taskId: topicId });
			slot.started = false;
			await this.endTurn(s, slot, end);
			this.slots.delete(topicId);
		});
	}

	/** 话题归档：它的 ACP 会话随之结束。 */
	async onTopicArchived(s: Scoped, topicId: string): Promise<void> {
		await this.close(s, topicId, {
			state: "canceled",
			summary: "话题已归档",
		});
	}

	/** 外部助手被删除：它的会话全部结束、未结束的任务取消。 */
	async onAgentRetired(
		s: Scoped,
		agentId: string,
		openTasks: readonly Task[],
	): Promise<void> {
		for (const slot of [...this.slots.values()])
			if (slot.agentId === agentId)
				await this.close(s, slot.topicId, {
					state: "canceled",
					summary: RETIRED_SUMMARY,
				});
		for (const task of openTasks)
			await transitionTask(s, task.id, "canceled", {
				summary: RETIRED_SUMMARY,
			});
	}

	/** 设备被吊销：在它上面的会话全部结束，进行中的一轮失败，未结束的任务失败。 */
	async onRunnerRevoked(
		s: Scoped,
		runnerId: string,
		openTasks: readonly Task[],
	): Promise<void> {
		for (const slot of [...this.slots.values()])
			if (slot.runnerId === runnerId)
				await this.close(s, slot.topicId, {
					state: "failed",
					summary: REVOKED_SUMMARY,
				});
		for (const task of openTasks)
			await transitionTask(s, task.id, "failed", { summary: REVOKED_SUMMARY });
	}

	// ─────────────────────────── Runner 的上行 ───────────────────────────

	onRunnerFrame(runner: RunnerRow, frame: AcpUp): Promise<void> {
		const topicId = frame.taskId;
		return this.serial(topicId, async () => {
			const s = scoped(runner.tenantId);
			const slot = this.slots.get(topicId);
			if (!slot || slot.runnerId !== runner.id) {
				this.hub.send(runner.id, { t: "acp_cancel", taskId: topicId });
				return;
			}
			slot.lastActivity = Date.now();
			switch (frame.t) {
				case "acp_event":
					await this.onEvent(s, slot, frame.kind, frame.payload);
					return;
				case "acp_turn_end":
					await this.onTurnEnd(s, slot, frame.stopReason, frame.sessionId);
					return;
				case "acp_permission":
					await this.onPermission(s, runner, slot, frame);
					return;
			}
		});
	}

	private async onEvent(
		s: Scoped,
		slot: Slot,
		kind: TaskLogKind,
		raw: unknown,
	): Promise<void> {
		const turn = slot.turn;
		if (kind === "prompt" || !turn) return;
		const payload = parseLogPayload(kind, raw);
		if (!payload) {
			console.warn(`[acp] 丢弃不合法的 ${kind} 记录`);
			return;
		}
		await appendTaskLog(s, this.logOwner(turn), kind, payload as never);
		if (kind === "tool_call") turn.text = "";
		if (kind === "agent_text" && "text" in payload && payload.text.trim()) {
			turn.text += payload.text;
			turn.frames.draft(payload.text);
			if (turn.taskId)
				await updateTaskProgress(s, turn.taskId, { summary: turn.text });
		} else if (kind === "tool_result" && "ok" in payload && turn.taskId) {
			const task = await requireTask(s, turn.taskId);
			const artifacts =
				payload.ok && payload.path
					? withArtifact(task.artifacts, {
							kind: "file",
							label: payload.path.split("/").at(-1) ?? payload.path,
							ref: payload.path,
						})
					: null;
			if (artifacts) await updateTaskProgress(s, task.id, { artifacts });
		} else if (kind === "state" && "state" in payload && payload.sessionId) {
			await this.recordSession(s, turn, payload.sessionId);
		} else if (kind === "error" && "fatal" in payload && payload.fatal) {
			// 设备已收掉这个会话：下一段话会起一个新会话。
			slot.started = false;
			await this.endTurn(
				s,
				slot,
				{ state: "failed", summary: payload.message },
				undefined,
			);
		}
	}

	private async recordSession(s: Scoped, turn: Turn, sessionId: string) {
		await setRunExternalSession(s, turn.runId, sessionId);
		if (turn.taskId)
			await updateTaskProgress(s, turn.taskId, {
				externalSessionId: sessionId,
			});
	}

	private async onTurnEnd(
		s: Scoped,
		slot: Slot,
		stopReason: string,
		sessionId: string | null,
	): Promise<void> {
		const turn = slot.turn;
		if (!turn) return;
		if (sessionId) await this.recordSession(s, turn, sessionId);
		const notice = STOP_NOTICE[stopReason];
		await this.endTurn(
			s,
			slot,
			{
				state:
					stopReason === "cancelled"
						? "canceled"
						: stopReason === "error"
							? "failed"
							: "completed",
				summary:
					stopReason === "cancelled"
						? INTERRUPTED_SUMMARY
						: (notice ??
							(clip(turn.text, RUN_SUMMARY_CHARS) || "没有文字回复")),
				...(sessionId ? { externalSessionId: sessionId } : {}),
			},
			notice,
		);
	}

	/**
	 * 权限请求：在话题的串行链里（服务于任务时置 awaiting_approval）并记一笔；等本人决定不占着链
	 * （等待期间 Runner 的其他帧照常处理）；决定到了再排回链里回传选项、记一笔、视情况回到 working。
	 */
	private async onPermission(
		s: Scoped,
		runner: RunnerRow,
		slot: Slot,
		frame: Extract<AcpUp, { t: "acp_permission" }>,
	): Promise<void> {
		const turn = slot.turn;
		if (!turn) {
			this.hub.send(runner.id, {
				t: "acp_permission_reply",
				taskId: slot.topicId,
				requestId: frame.requestId,
				optionId: null,
			});
			return;
		}
		turn.pendingPermissions += 1;
		turn.frames.status("tool", APPROVAL_LABEL);
		if (turn.taskId) {
			const task = await requireTask(s, turn.taskId);
			if (task.state === "working")
				await transitionTask(s, task.id, "awaiting_approval", {
					runId: turn.runId,
				});
		}
		const { toolCall, options } = frame;
		await appendTaskLog(s, this.logOwner(turn), "permission", {
			title: toolCall.title,
			options,
			...(toolCall.rawInput === undefined ? {} : { input: toolCall.rawInput }),
		});
		const agent = await s.first(principals, eq(principals.id, slot.agentId));
		const name = agent?.displayName ?? "外部助手";
		const terminal = frame.source === "terminal";
		const command = commandOf(toolCall.rawInput) ?? toolCall.title;
		void requestApproval(s, {
			agentId: slot.agentId,
			conversationId: slot.conversationId,
			topicId: slot.topicId,
			runId: turn.runId,
			runnerId: runner.id,
			runnerName: runner.name,
			capability: terminal ? "shell.exec" : AGENT_ACP_CAPABILITY,
			args: terminal ? { command } : (toolCall.rawInput ?? {}),
			title: terminal
				? `${name}想在“${runner.name}”上执行命令`
				: `${name}请求：${toolCall.title}`,
			body: terminal ? command : toolCall.title,
			acp: {
				...(turn.taskId ? { taskId: turn.taskId } : {}),
				toolCall,
				options,
			},
			signal: turn.abort.signal,
			timeoutMs: this.options.approvalTimeoutMs,
		})
			.catch((e): ApprovalDecision => {
				console.error("[acp] 审批出错", e);
				return { outcome: "cancelled" };
			})
			.then((decision) =>
				this.serial(slot.topicId, () =>
					this.afterDecision(s, runner, slot, turn, frame, decision),
				),
			)
			.catch((e) => console.error("[acp] 回传审批结果出错", e));
	}

	private async afterDecision(
		s: Scoped,
		runner: RunnerRow,
		slot: Slot,
		turn: Turn,
		frame: Extract<AcpUp, { t: "acp_permission" }>,
		decision: ApprovalDecision,
	): Promise<void> {
		this.hub.send(runner.id, {
			t: "acp_permission_reply",
			taskId: slot.topicId,
			requestId: frame.requestId,
			optionId: decision.optionId ?? null,
		});
		await appendTaskLog(s, this.logOwner(turn), "permission", {
			title: frame.toolCall.title,
			optionId: decision.optionId ?? null,
			outcome: decision.outcome,
		});
		turn.pendingPermissions -= 1;
		if (slot.turn !== turn || turn.pendingPermissions > 0) return;
		turn.frames.status("tool", WORKING_LABEL);
		if (!turn.taskId) return;
		const task = await requireTask(s, turn.taskId);
		if (task.state === "awaiting_approval")
			await transitionTask(s, task.id, "working", { runId: turn.runId });
	}

	/**
	 * Runner 连上：它上报的在跑会话槽里，认得的（话题仍在、外部助手仍绑在这台设备上）接回，
	 * 认不得的让它终止；我们以为在这台设备上、它却不再运行的，进行中的一轮判失败。
	 */
	async onRunnerHello(
		runner: RunnerRow,
		running: readonly string[],
	): Promise<void> {
		const s = scoped(runner.tenantId);
		const reported = new Set(running);
		for (const topicId of reported) {
			if (this.slots.get(topicId)?.runnerId === runner.id) continue;
			if (!(await this.adopt(s, runner, topicId)))
				this.hub.send(runner.id, { t: "acp_cancel", taskId: topicId });
		}
		for (const slot of [...this.slots.values()]) {
			if (slot.runnerId !== runner.id || !slot.started) continue;
			if (reported.has(slot.topicId)) continue;
			await this.serial(slot.topicId, async () => {
				slot.started = false;
				await this.endTurn(
					s,
					slot,
					{ state: "failed", summary: LOST_SUMMARY },
					LOST_SUMMARY,
				);
			});
		}
	}

	/** 接回设备上仍在跑的一个会话槽（服务重启后）。 */
	private async adopt(
		s: Scoped,
		runner: RunnerRow,
		topicId: string,
	): Promise<boolean> {
		const topic = await findTopic(s, topicId);
		if (!topic) return false;
		const members = await memberPrincipals(s, topic.conversationId);
		for (const p of members.values()) {
			if (p.kind !== "agent") continue;
			const agent = await findAgent(s, { id: p.id });
			if (!agent || !isExternalAgent(agent) || agent.runnerId !== runner.id)
				continue;
			const slot = this.slotFor(agent, {
				conversationId: topic.conversationId,
				topicId,
			});
			if (!slot) return false;
			slot.started = true;
			return true;
		}
		return false;
	}

	// ─────────────────────────── 维护 ───────────────────────────

	/**
	 * 24 小时没有活动：未结束的任务自动完成；空闲的会话槽让设备终止 agent 进程。
	 * 返回自动完成的任务数。
	 */
	async sweepIdle(now = new Date()): Promise<number> {
		let n = 0;
		for (const tenantId of await tenantsWithOpenTasks()) {
			const s = scoped(tenantId);
			for (const task of await idleTasks(s, now))
				if (
					await transitionTask(s, task.id, "completed", {
						summary: IDLE_SUMMARY,
					})
				)
					n += 1;
		}
		for (const slot of [...this.slots.values()]) {
			if (slot.turn || now.getTime() - slot.lastActivity < SLOT_IDLE_MS)
				continue;
			if (slot.started)
				this.hub.send(slot.runnerId, { t: "acp_cancel", taskId: slot.topicId });
			this.slots.delete(slot.topicId);
		}
		return n;
	}

	/** 进程启动：上一个进程留下的进行中的运行都已失去运行时，判失败。 */
	async interruptAll(): Promise<void> {
		await failDanglingRuns();
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

export const externalSessions = new ExternalSessions();
