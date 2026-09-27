/**
 * 待办（"待我处理"）：处理人必为人。写入只经本文件，写入前按 kind 校验载荷。
 */
import {
	WORK_ITEM_PAYLOAD_SCHEMAS,
	type WORK_ITEM_STATUSES,
	type WorkItem,
	type WorkItemDraft,
} from "@orgos/protocol";
import { desc, eq } from "drizzle-orm";
import { principals, workItems } from "@/db/schema";
import type { Scoped } from "@/db/scope";
import { badRequest } from "@/lib/errors";
import { toWorkItem } from "@/lib/serialize";
import { requireAgentPrincipal } from "@/services/agent-events";
import { requireConversation } from "@/services/conversations";
import { transactWithEvents } from "@/services/events";

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
 * 代理把超出授权的问题转给本人：一个事务内建 decision 待办（处理人 = 代理的本人，
 * 提问人 = requesterId）并在会话里落 `escalation.created`。
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
		at?: Date;
	},
): Promise<WorkItem> {
	const agent = await requireAgentPrincipal(s, input.agentId);
	await requireConversation(s, input.conversationId, agent.id);
	return transactWithEvents(s, async (tx, append) => {
		const item = await createWorkItem(tx, {
			kind: "decision",
			payload: { question: input.question, askedById: input.requesterId },
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
			payload: { workItemId: item.id, question: input.question },
			at: input.at,
		});
		return item;
	});
}
