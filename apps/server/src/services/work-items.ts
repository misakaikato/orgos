/**
 * 待办（"待我处理"）：处理人必为人。写入只经本文件，写入前按 kind 校验载荷。
 */
import {
	type AcpPermissionOption,
	type AcpToolCall,
	APPROVAL_TIMEOUT_MS,
	type ApprovalOutcome,
	type ApprovalResolution,
	type ConfirmationResolution,
	DECISION_OPTION_MAX_CHARS,
	DECISION_OPTIONS_MAX,
	DECISION_OPTIONS_MIN,
	type DecisionResolution,
	ERROR_CODES,
	isAllowOption,
	RESOLVE_ACTIONS_BY_KIND,
	type ResolveWorkItemRequest,
	WORK_ITEM_PAYLOAD_SCHEMAS,
	type WORK_ITEM_STATUSES,
	type WorkItem,
	type WorkItemDraft,
	type WorkItemPayload,
} from "@orgos/protocol";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { events, principals, workItems } from "@/db/schema";
import type { PrincipalRow, Scoped } from "@/db/scope";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { toWorkItem } from "@/lib/serialize";
import { isUuid } from "@/lib/uuid";
import { enqueueMemoryJob } from "@/memory/queue";
import { browserHub } from "@/realtime/browser-hub";
import { requireAgentPrincipal } from "@/services/agent-events";
import { requireConversation } from "@/services/conversations";
import { transactWithEvents } from "@/services/events";
import { createNote } from "@/services/notes";
import { mainTopicOf } from "@/services/topics";
import { deciderOf, unitOfAgent } from "@/services/units";

export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

export type CreateWorkItemInput = WorkItemDraft & {
	title: string;
	body: string;
	ownerId: string;
	requesterId: string;
	conversationId?: string | null;
	sourceEventId?: number | null;
	dueAt?: Date | null;
};

/** 建一条 open 待办；处理人不是本租户的人 → 400。调用方负责事务。 */
export async function createWorkItem(
	s: Scoped,
	input: CreateWorkItemInput,
): Promise<WorkItem> {
	const payload = WORK_ITEM_PAYLOAD_SCHEMAS[input.kind].parse(input.payload);
	const owner = await s.first(principals, eq(principals.id, input.ownerId));
	if (owner?.kind !== "human") throw badRequest("待办的处理人必须是人");
	const row = await s.insert(workItems, {
		kind: input.kind,
		title: input.title,
		body: input.body,
		ownerId: input.ownerId,
		requesterId: input.requesterId,
		status: "open",
		conversationId: input.conversationId ?? null,
		sourceEventId: input.sourceEventId ?? null,
		payload,
		dueAt: input.dueAt ?? null,
	});
	return toWorkItem(row);
}

/** 把新增或变化的待办推给处理人（须在写入提交之后调用）。 */
export function notifyWorkItem(item: WorkItem): void {
	browserHub.sendTo([item.ownerId], { t: "work_item", workItem: item });
}

/** 我是处理人的待办，按创建时间倒序。 */
export async function listWorkItems(
	s: Scoped,
	ownerId: string,
	status: WorkItemStatus,
): Promise<WorkItem[]> {
	const rows = await s.executor
		.select()
		.from(workItems)
		.where(
			s.where(
				workItems,
				eq(workItems.ownerId, ownerId),
				eq(workItems.status, status),
			),
		)
		.orderBy(desc(workItems.createdAt));
	return rows.map(toWorkItem);
}

/**
 * 代理给出的候选答复 → 待办里存的候选（候选的整理只在这里）：去掉空白与重复，
 * 超过 60 字的丢弃（截断会把一句完整的答复截坏），多于 4 条的只留前 4 条；
 * 剩下不足 2 条就不算有候选。不报错。
 */
export function decisionOptionsOf(
	raw: readonly string[] | undefined,
): string[] | undefined {
	const kept: string[] = [];
	for (const option of raw ?? []) {
		const text = option.trim();
		if (!text || Array.from(text).length > DECISION_OPTION_MAX_CHARS) continue;
		if (!kept.includes(text)) kept.push(text);
	}
	const options = kept.slice(0, DECISION_OPTIONS_MAX);
	return options.length >= DECISION_OPTIONS_MIN ? options : undefined;
}

/**
 * 代理把超出授权的问题转给本人（上报的唯一入口）：一个事务内建 decision 待办
 * （处理人 = 替代理的本人拍板的人：人是本人，单元是负责人；提问人 = requesterId）
 * 并在会话里落 `escalation.created`，提交后把待办推给处理人。
 */
export async function escalateToOwner(
	s: Scoped,
	input: {
		agentId: string;
		conversationId: string;
		/** 卡片落在哪个话题（触发上报的话题）。 */
		topicId: string;
		requesterId: string;
		question: string;
		title: string;
		sourceEventId?: number | null;
		/** 协商中请本人拍板：答复后恢复该协商而不是在会话里回复。 */
		negotiationConversationId?: string;
		/** 代理给出的候选答复，经 `decisionOptionsOf` 整理后存入。 */
		options?: readonly string[];
		at?: Date;
	},
): Promise<WorkItem> {
	const agent = await requireAgentPrincipal(s, input.agentId);
	const decider = await deciderOf(s, agent.ownerId);
	const options = decisionOptionsOf(input.options);
	const extra = {
		...(input.negotiationConversationId
			? { negotiationConversationId: input.negotiationConversationId }
			: {}),
		...(options ? { options } : {}),
	};
	// 协商中请本人拍板时，卡片落在拍板人的私聊里（单元分身不在任何人的私聊里）。
	await requireConversation(
		s,
		input.conversationId,
		input.negotiationConversationId ? decider.id : agent.id,
	);
	const item = await transactWithEvents(s, async (tx, append) => {
		const item = await createWorkItem(tx, {
			kind: "decision",
			payload: {
				question: input.question,
				askedById: input.requesterId,
				...extra,
			},
			title: input.title,
			body: input.question,
			ownerId: decider.id,
			requesterId: input.requesterId,
			conversationId: input.conversationId,
			sourceEventId: input.sourceEventId ?? null,
		});
		await append({
			conversationId: input.conversationId,
			topicId: input.topicId,
			actorId: agent.id,
			onBehalfOfId: agent.ownerId,
			type: "escalation.created",
			payload: {
				workItemId: item.id,
				question: input.question,
				...extra,
			},
			at: input.at,
		});
		return item;
	});
	notifyWorkItem(item);
	return item;
}

/**
 * 待办的卡片事件（上报的 `escalation.created`、审批的 `approval.requested`）：
 * 发起它的代理与它所在的话题——答复、恢复运行、了结审批都回到这个话题。
 */
export async function cardEventOf(
	s: Scoped,
	item: WorkItem,
): Promise<{ actorId: string; topicId: string } | null> {
	if (!item.conversationId) return null;
	const [row] = await s.executor
		.select({ actorId: events.actorId, topicId: events.topicId })
		.from(events)
		.where(
			s.where(
				events,
				eq(events.conversationId, item.conversationId),
				inArray(events.type, ["escalation.created", "approval.requested"]),
				sql`${events.payload}->>'workItemId' = ${item.id}`,
			),
		)
		.limit(1);
	return row ?? null;
}

export const NOTE_TITLE_MAX_CHARS = 30;

function noteTitleOf(question: string): string {
	return Array.from(question.trim()).slice(0, NOTE_TITLE_MAX_CHARS).join("");
}

/**
 * 本人处理一条待办。不存在、跨租户、不是我的 → 404；动作与 kind 不符 → 400；
 * 已处理 → 409。提交后推 work_item 帧。
 *
 * - decision：待办置 done 并写入 resolution；answer 且 saveAsNote 时以本人为作者写一条共享资料
 *   （标题取问题前 30 字）；在原会话落 `escalation.resolved`，答复另排一个 resolution 作业写成 decision 记忆。
 *   恢复上报代理的运行由调用方交给调度器。
 * - confirmation：在协商会话落 `confirmation.resolved`，待办置 done；reject 时同一协商里
 *   另一方仍未处理的确认待办置 cancelled。同一协商的处理经协商会话的行锁串行。
 * - approval：待办置 done 并在会话里落 `approval.resolved`，再把决定交给正在等待的代理运行。
 */
export async function resolveWorkItem(
	s: Scoped,
	me: PrincipalRow,
	workItemId: string,
	req: ResolveWorkItemRequest,
): Promise<WorkItem> {
	if (!isUuid(workItemId)) throw notFound("待办不存在");
	const row = await s.first(
		workItems,
		eq(workItems.id, workItemId),
		eq(workItems.ownerId, me.id),
	);
	if (!row) throw notFound("待办不存在");
	const item = toWorkItem(row);
	const allowed: readonly string[] = RESOLVE_ACTIONS_BY_KIND[item.kind];
	if (!allowed.includes(req.action)) {
		throw new AppError(
			400,
			ERROR_CODES.WORK_ITEM_ACTION_MISMATCH,
			`这类待办不能执行 ${req.action}`,
		);
	}
	if (item.status !== "open") throw notOpen();
	if (
		item.kind === "decision" &&
		(req.action === "answer" || req.action === "decline")
	)
		return resolveDecision(s, me, item, req);
	if (
		item.kind === "confirmation" &&
		(req.action === "confirm" || req.action === "reject")
	)
		return resolveConfirmation(s, me, item, req.action);
	if (
		item.kind === "approval" &&
		(req.action === "approve" || req.action === "deny")
	) {
		const decision: ApprovalDecision = {
			outcome: req.action,
			optionId: chooseOption(item.payload.options, req.action, req.optionId),
		};
		const settled = await settleApproval(s, item, decision, me.id);
		if (!settled) throw notOpen();
		deliverApproval(item.id, decision);
		return settled;
	}
	throw new AppError(
		400,
		ERROR_CODES.WORK_ITEM_ACTION_MISMATCH,
		`这类待办不能执行 ${req.action}`,
	);
}

function notOpen(): AppError {
	return new AppError(409, ERROR_CODES.WORK_ITEM_NOT_OPEN, "待办已处理");
}

/** 把仍为 open 的待办置为 status；已被别人或并发请求处理过 → null。 */
async function closeIfOpen(
	tx: Scoped,
	id: string,
	resolution: unknown,
	status: Exclude<WorkItemStatus, "open"> = "done",
): Promise<WorkItem | null> {
	const [updated] = await tx.executor
		.update(workItems)
		.set({ status, resolution })
		.where(
			tx.where(
				workItems,
				and(eq(workItems.id, id), eq(workItems.status, "open")),
			),
		)
		.returning();
	return updated ? toWorkItem(updated) : null;
}

/** 同 closeIfOpen，但已处理过 → 409。 */
async function closeOpen(
	tx: Scoped,
	id: string,
	resolution: unknown,
): Promise<WorkItem> {
	const closed = await closeIfOpen(tx, id, resolution);
	if (!closed) throw notOpen();
	return closed;
}

async function resolveDecision(
	s: Scoped,
	me: PrincipalRow,
	item: Extract<WorkItem, { kind: "decision" }>,
	req: Extract<ResolveWorkItemRequest, { action: "answer" | "decline" }>,
): Promise<WorkItem> {
	const text = req.text?.trim() || undefined;
	const option = req.action === "answer" ? req.option : undefined;
	if (option !== undefined && item.payload.options?.[option] !== text)
		throw badRequest("答复与所选候选不一致");
	const card = await cardEventOf(s, item);
	const unit = card ? await unitOfAgent(s, card.actorId) : null;
	const resolved = await transactWithEvents(s, async (tx, append) => {
		let noteId: string | undefined;
		if (req.action === "answer" && req.saveAsNote && text) {
			// 单元分身上报的问题：答复存为单元资料（仅成员可见）；否则存为本人的共享资料。
			const note = await createNote(tx, {
				ownerId: unit?.id ?? me.id,
				authorId: me.id,
				title: noteTitleOf(item.payload.question),
				body: `问：${item.payload.question}\n答：${text}`,
				visibility: unit ? "unit" : "shared",
			});
			noteId = note.id;
		}
		const resolution: DecisionResolution = {
			action: req.action,
			...(text ? { text } : {}),
			...(option === undefined ? {} : { option }),
			...(noteId ? { noteId } : {}),
		};
		const updated = await closeOpen(tx, item.id, resolution);
		if (item.conversationId && card) {
			const resolved = await append({
				conversationId: item.conversationId,
				topicId: card.topicId,
				actorId: me.id,
				type: "escalation.resolved",
				payload: {
					workItemId: item.id,
					action: req.action,
					...(text ? { text } : {}),
					...(option === undefined ? {} : { option }),
				},
			});
			if (req.action === "answer")
				await enqueueMemoryJob(tx, {
					topicId: card.topicId,
					trigger: "resolution",
					eventId: resolved.id,
				});
		}
		return updated;
	});
	notifyWorkItem(resolved);
	return resolved;
}

async function resolveConfirmation(
	s: Scoped,
	me: PrincipalRow,
	item: Extract<WorkItem, { kind: "confirmation" }>,
	action: ConfirmationResolution["action"],
): Promise<WorkItem> {
	const negotiationId = item.payload.negotiationConversationId;
	const { mine, cancelled } = await transactWithEvents(
		s,
		async (tx, append) => {
			// 先落事件：它锁住协商会话的行，同一协商的并发处理在此排队。
			await append({
				conversationId: negotiationId,
				topicId: (await mainTopicOf(tx, negotiationId)).id,
				actorId: me.id,
				type: "confirmation.resolved",
				payload: { workItemId: item.id, action },
			});
			const resolution: ConfirmationResolution = { action };
			const mine = await closeOpen(tx, item.id, resolution);
			const cancelled =
				action === "reject"
					? (
							await tx.executor
								.update(workItems)
								.set({ status: "cancelled" })
								.where(
									tx.where(
										workItems,
										eq(workItems.kind, "confirmation"),
										eq(workItems.status, "open"),
										ne(workItems.id, item.id),
										sql`${workItems.payload}->>'negotiationConversationId' = ${negotiationId}`,
									),
								)
								.returning()
						).map(toWorkItem)
					: [];
			return { mine, cancelled };
		},
	);
	for (const w of [mine, ...cancelled]) notifyWorkItem(w);
	return mine;
}

// ─────────────────────────── 审批 ───────────────────────────

/** 审批的结局；带选项的审批（外部助手的权限请求）另有所选选项，原样回给 agent。 */
export type ApprovalDecision = { outcome: ApprovalOutcome; optionId?: string };

/**
 * 带选项的审批：给定 optionId 时须是同类选项（批准只能选 allow_*，拒绝只能选 reject_*），
 * 否则 400；不给时取第一个同类选项。没有选项的审批不带 optionId。
 */
function chooseOption(
	options: readonly AcpPermissionOption[] | undefined,
	action: "approve" | "deny",
	optionId: string | undefined,
): string | undefined {
	if (!options) {
		if (optionId) throw badRequest("这条审批没有可选的选项");
		return undefined;
	}
	const sameKind = options.filter(
		(o) => isAllowOption(o) === (action === "approve"),
	);
	if (optionId === undefined) return sameKind[0]?.optionId;
	if (!sameKind.some((o) => o.optionId === optionId))
		throw badRequest("选项与动作不符");
	return optionId;
}

/** 审批过期视为拒绝：带选项时代为选第一个拒绝类选项。 */
function expiredDecision(
	options: readonly AcpPermissionOption[] | undefined,
): ApprovalDecision {
	const reject = options?.find((o) => !isAllowOption(o))?.optionId;
	return { outcome: "expired", ...(reject ? { optionId: reject } : {}) };
}

/** 正在等本人决定的代理运行（进程内）：待办 id → 交付决定。 */
const approvalWaiters = new Map<string, (d: ApprovalDecision) => void>();

function deliverApproval(workItemId: string, decision: ApprovalDecision): void {
	approvalWaiters.get(workItemId)?.(decision);
}

type ApprovalItem = Extract<WorkItem, { kind: "approval" }>;

/**
 * 了结一条仍为 open 的审批待办并在会话里落 `approval.resolved`，提交后推给本人。
 * 批准与拒绝置 done（actor 为本人），过期与取消置 cancelled（actor 为发起的代理）。
 * 已被了结（并发的处理、过期或取消）→ null。
 */
async function settleApproval(
	s: Scoped,
	item: ApprovalItem,
	decision: ApprovalDecision,
	actorId: string,
): Promise<WorkItem | null> {
	const { outcome, optionId } = decision;
	const resolution: ApprovalResolution = {
		outcome,
		...(optionId ? { optionId } : {}),
	};
	const settled = await transactWithEvents(s, async (tx, append) => {
		const closed = await closeIfOpen(
			tx,
			item.id,
			resolution,
			outcome === "approve" || outcome === "deny" ? "done" : "cancelled",
		);
		if (!closed) return null;
		const card = await cardEventOf(tx, item);
		if (item.conversationId && card) {
			const byAgent = actorId === item.requesterId;
			await append({
				conversationId: item.conversationId,
				topicId: card.topicId,
				actorId,
				onBehalfOfId: byAgent ? item.ownerId : null,
				type: "approval.resolved",
				payload: {
					workItemId: item.id,
					outcome,
					...(optionId ? { optionId } : {}),
				},
			});
		}
		return closed;
	});
	if (settled) notifyWorkItem(settled);
	return settled;
}

export type ApprovalRequest = {
	agentId: string;
	conversationId: string;
	/** 审批卡片落在哪个话题（发起请求的运行所在的话题）。 */
	topicId: string;
	/** 发起请求的运行。 */
	runId: string;
	runnerId: string;
	runnerName: string;
	capability: WorkItemPayload<"approval">["capability"];
	args: unknown;
	title: string;
	body: string;
	sourceEventId?: number | null;
	/** 外部助手的权限请求：所属任务（有的话）、工具调用与 agent 给出的选项。 */
	acp?: {
		taskId?: string;
		toolCall: AcpToolCall;
		options: AcpPermissionOption[];
	};
	/** 等待中触发即取消（本人发了新消息、停止了运行，或任务结束）。 */
	signal: AbortSignal;
	timeoutMs?: number;
};

/**
 * 代理请本人批准一次有风险的操作（审批的唯一入口：设备工具与外部助手的权限请求都经这里）：
 * 一个事务内建 approval 待办（处理人 = 代理的本人，提问人 = 代理）并在会话里落
 * `approval.requested`，提交后推给本人；然后等待本人的决定。10 分钟无人处理 → expired
 * （带选项时代为选拒绝）；等待中 signal 触发 → cancelled。
 * 不抛异常以外的失败：返回的一定是最终结局。
 */
export async function requestApproval(
	s: Scoped,
	input: ApprovalRequest,
): Promise<ApprovalDecision> {
	const agent = await requireAgentPrincipal(s, input.agentId);
	await requireConversation(s, input.conversationId, agent.id);
	const item = (await transactWithEvents(s, async (tx, append) => {
		const item = await createWorkItem(tx, {
			kind: "approval",
			payload: {
				runnerId: input.runnerId,
				capability: input.capability,
				args: input.args,
				runId: input.runId,
				...(input.acp ?? {}),
			},
			title: input.title,
			body: input.body,
			ownerId: agent.ownerId,
			requesterId: agent.id,
			conversationId: input.conversationId,
			sourceEventId: input.sourceEventId ?? null,
		});
		await append({
			conversationId: input.conversationId,
			topicId: input.topicId,
			actorId: agent.id,
			onBehalfOfId: agent.ownerId,
			type: "approval.requested",
			payload: {
				workItemId: item.id,
				runnerId: input.runnerId,
				runnerName: input.runnerName,
				capability: input.capability,
				args: input.args,
				runId: input.runId,
				...(input.acp ?? {}),
			},
		});
		return item;
	})) as ApprovalItem;
	notifyWorkItem(item);

	const { signal } = input;
	return new Promise<ApprovalDecision>((resolve) => {
		const finish = (decision: ApprovalDecision) => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			approvalWaiters.delete(item.id);
			resolve(decision);
		};
		approvalWaiters.set(item.id, finish);
		const settleBy = (decision: ApprovalDecision) => {
			settleApproval(s, item, decision, agent.id).then(
				(settled) => {
					if (settled) deliverApproval(item.id, decision);
				},
				(e) => {
					console.error("[approval] 了结审批失败", e);
					deliverApproval(item.id, decision);
				},
			);
		};
		const timer = setTimeout(
			() => settleBy(expiredDecision(input.acp?.options)),
			input.timeoutMs ?? APPROVAL_TIMEOUT_MS,
		);
		const onAbort = () => settleBy({ outcome: "cancelled" });
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * 运行结束后仍 open 的审批（等待者已不在，或进程重启后已没有等待者）：一律取消，actor 为发起的代理。
 */
export async function cancelRunApprovals(
	s: Scoped,
	runId: string,
): Promise<void> {
	const rows = await s.select(
		workItems,
		eq(workItems.kind, "approval"),
		eq(workItems.status, "open"),
		sql`${workItems.payload}->>'runId' = ${runId}`,
	);
	for (const row of rows) {
		const item = toWorkItem(row) as ApprovalItem;
		const decision: ApprovalDecision = { outcome: "cancelled" };
		if (await settleApproval(s, item, decision, item.requesterId))
			deliverApproval(item.id, decision);
	}
}
