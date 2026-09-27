/**
 * 待办（"待我处理"）：处理人必为人。写入只经本文件，写入前按 kind 校验载荷。
 */
import {
	type ConfirmationResolution,
	type DecisionResolution,
	ERROR_CODES,
	RESOLVE_ACTIONS_BY_KIND,
	type ResolveWorkItemRequest,
	WORK_ITEM_PAYLOAD_SCHEMAS,
	type WORK_ITEM_STATUSES,
	type WorkItem,
	type WorkItemDraft,
} from "@orgos/protocol";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { events, principals, workItems } from "@/db/schema";
import type { PrincipalRow, Scoped } from "@/db/scope";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { toWorkItem } from "@/lib/serialize";
import { isUuid } from "@/lib/uuid";
import { browserHub } from "@/realtime/browser-hub";
import { requireAgentPrincipal } from "@/services/agent-events";
import { requireConversation } from "@/services/conversations";
import { transactWithEvents } from "@/services/events";
import { createNote } from "@/services/notes";

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
 * 代理把超出授权的问题转给本人（上报的唯一入口）：一个事务内建 decision 待办
 * （处理人 = 代理的本人，提问人 = requesterId）并在会话里落 `escalation.created`，
 * 提交后把待办推给本人。
 */
export async function escalateToOwner(
	s: Scoped,
	input: {
		agentId: string;
		conversationId: string;
		requesterId: string;
		question: string;
		title: string;
		sourceEventId?: number | null;
		/** 协商中请本人拍板：答复后恢复该协商而不是在会话里回复。 */
		negotiationConversationId?: string;
		at?: Date;
	},
): Promise<WorkItem> {
	const agent = await requireAgentPrincipal(s, input.agentId);
	const negotiation = input.negotiationConversationId
		? { negotiationConversationId: input.negotiationConversationId }
		: {};
	await requireConversation(s, input.conversationId, agent.id);
	const item = await transactWithEvents(s, async (tx, append) => {
		const item = await createWorkItem(tx, {
			kind: "decision",
			payload: {
				question: input.question,
				askedById: input.requesterId,
				...negotiation,
			},
			title: input.title,
			body: input.question,
			ownerId: agent.ownerId,
			requesterId: input.requesterId,
			conversationId: input.conversationId,
			sourceEventId: input.sourceEventId ?? null,
		});
		await append({
			conversationId: input.conversationId,
			actorId: agent.id,
			onBehalfOfId: agent.ownerId,
			type: "escalation.created",
			payload: {
				workItemId: item.id,
				question: input.question,
				...negotiation,
			},
			at: input.at,
		});
		return item;
	});
	notifyWorkItem(item);
	return item;
}

/** 上报了这条 decision 待办的代理（取自会话里对应的 `escalation.created`）。 */
export async function escalatingAgentOf(
	s: Scoped,
	item: WorkItem,
): Promise<string | null> {
	if (!item.conversationId) return null;
	const [row] = await s.executor
		.select({ actorId: events.actorId })
		.from(events)
		.where(
			s.where(
				events,
				eq(events.conversationId, item.conversationId),
				eq(events.type, "escalation.created"),
				sql`${events.payload}->>'workItemId' = ${item.id}`,
			),
		)
		.limit(1);
	return row?.actorId ?? null;
}

export const NOTE_TITLE_MAX_CHARS = 30;

function noteTitleOf(question: string): string {
	return Array.from(question.trim()).slice(0, NOTE_TITLE_MAX_CHARS).join("");
}

/**
 * 本人处理一条待办。不存在、跨租户、不是我的 → 404；动作与 kind 不符 → 400；
 * 已处理 → 409。approval 的 approve / deny 返回 400 NOT_IMPLEMENTED。提交后推 work_item 帧。
 *
 * - decision：待办置 done 并写入 resolution；answer 且 saveAsNote 时以本人为作者写一条共享资料
 *   （标题取问题前 30 字）；在原会话落 `escalation.resolved`。恢复上报代理的运行由调用方交给调度器。
 * - confirmation：在协商会话落 `confirmation.resolved`，待办置 done；reject 时同一协商里
 *   另一方仍未处理的确认待办置 cancelled。同一协商的处理经协商会话的行锁串行。
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
	throw new AppError(
		400,
		ERROR_CODES.NOT_IMPLEMENTED,
		"这类待办的处理还未开放",
	);
}

function notOpen(): AppError {
	return new AppError(409, ERROR_CODES.WORK_ITEM_NOT_OPEN, "待办已处理");
}

/** 把仍为 open 的待办置为 done；已被别人或并发请求处理过 → 409。 */
async function closeOpen(
	tx: Scoped,
	id: string,
	resolution: unknown,
): Promise<WorkItem> {
	const [updated] = await tx.executor
		.update(workItems)
		.set({ status: "done", resolution })
		.where(
			tx.where(
				workItems,
				and(eq(workItems.id, id), eq(workItems.status, "open")),
			),
		)
		.returning();
	if (!updated) throw notOpen();
	return toWorkItem(updated);
}

async function resolveDecision(
	s: Scoped,
	me: PrincipalRow,
	item: Extract<WorkItem, { kind: "decision" }>,
	req: Extract<ResolveWorkItemRequest, { action: "answer" | "decline" }>,
): Promise<WorkItem> {
	const text = req.text?.trim() || undefined;
	const resolved = await transactWithEvents(s, async (tx, append) => {
		let noteId: string | undefined;
		if (req.action === "answer" && req.saveAsNote && text) {
			const note = await createNote(tx, {
				ownerId: me.id,
				authorId: me.id,
				title: noteTitleOf(item.payload.question),
				body: `问：${item.payload.question}\n答：${text}`,
				visibility: "shared",
			});
			noteId = note.id;
		}
		const resolution: DecisionResolution = {
			action: req.action,
			...(text ? { text } : {}),
			...(noteId ? { noteId } : {}),
		};
		const updated = await closeOpen(tx, item.id, resolution);
		if (item.conversationId) {
			await append({
				conversationId: item.conversationId,
				actorId: me.id,
				type: "escalation.resolved",
				payload: {
					workItemId: item.id,
					action: req.action,
					...(text ? { text } : {}),
				},
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
