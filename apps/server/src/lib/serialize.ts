/**
 * 数据库行 → 协议形态（@orgos/protocol 的实体 schema）。
 */
import {
	type Agent,
	type Conversation,
	type Event,
	type Principal,
	type Run,
	type RunLog,
	type Task,
	TaskArtifactSchema,
	type TaskLog,
	type Tenant,
	type Topic,
	type WorkItem,
} from "@orgos/protocol";
import { z } from "zod";
import type {
	agents,
	conversations,
	events,
	principals,
	runs,
	taskLogs,
	tasks,
	tenants,
	topics,
	workItems,
} from "@/db/schema";

type PrincipalRow = typeof principals.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type TenantRow = typeof tenants.$inferSelect;
type ConversationRow = typeof conversations.$inferSelect;
type EventRow = typeof events.$inferSelect;
type WorkItemRow = typeof workItems.$inferSelect;

export function toPrincipal(row: PrincipalRow): Principal {
	return {
		id: row.id,
		tenantId: row.tenantId,
		kind: row.kind,
		userId: row.userId,
		ownerId: row.ownerId,
		handle: row.handle,
		displayName: row.displayName,
		createdAt: row.createdAt.toISOString(),
		...(row.kind === "human" ? { status: row.status } : {}),
	};
}

export function toAgent(principal: PrincipalRow, agent: AgentRow): Agent {
	return {
		principal: toPrincipal(principal),
		role: agent.role,
		description: agent.description,
		delegationPolicy: agent.delegationPolicy,
		model: agent.model,
		runnerId: agent.runnerId,
		updatedAt: agent.updatedAt.toISOString(),
		engine: agent.engine,
		adapter: agent.adapter,
		workspace: agent.workspace,
	};
}

/** 邀请码只给 owner 看。 */
export function toTenant(row: TenantRow, withInviteCode: boolean): Tenant {
	return withInviteCode
		? { id: row.id, name: row.name, inviteCode: row.inviteCode }
		: { id: row.id, name: row.name };
}

export function toConversation(row: ConversationRow): Conversation {
	return {
		id: row.id,
		tenantId: row.tenantId,
		kind: row.kind,
		title: row.title,
		createdBy: row.createdBy,
		createdAt: row.createdAt.toISOString(),
		lastSeq: row.lastSeq,
	};
}

/**
 * 事件行只经 `@/services/events` 写入，写入前已按 type 校验载荷，
 * 故 type 与 payload 的配对在此成立。
 */
export function toEvent(row: EventRow): Event {
	return {
		id: row.id,
		tenantId: row.tenantId,
		conversationId: row.conversationId,
		seq: row.seq,
		type: row.type,
		actorId: row.actorId,
		onBehalfOfId: row.onBehalfOfId,
		payload: row.payload,
		createdAt: row.createdAt.toISOString(),
		topicId: row.topicId,
	} as Event;
}

/**
 * 待办行只经 `@/services/work-items` 写入，写入前已按 kind 校验载荷，
 * 故 kind 与 payload 的配对在此成立。
 */
export function toWorkItem(row: WorkItemRow): WorkItem {
	return {
		id: row.id,
		tenantId: row.tenantId,
		kind: row.kind,
		title: row.title,
		body: row.body,
		ownerId: row.ownerId,
		requesterId: row.requesterId,
		status: row.status,
		conversationId: row.conversationId,
		sourceEventId: row.sourceEventId,
		payload: row.payload,
		resolution: row.resolution ?? null,
		dueAt: row.dueAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	} as WorkItem;
}

type TaskRow = typeof tasks.$inferSelect;
type TaskLogRow = typeof taskLogs.$inferSelect;

const ArtifactsSchema = z.array(TaskArtifactSchema).catch([]);

export function toTask(row: TaskRow): Task {
	return {
		id: row.id,
		tenantId: row.tenantId,
		conversationId: row.conversationId,
		topicId: row.topicId,
		requesterId: row.requesterId,
		assigneeId: row.assigneeId,
		onBehalfOfId: row.onBehalfOfId,
		title: row.title,
		goal: row.goal,
		state: row.state,
		engine: row.engine,
		adapter: row.adapter,
		runnerId: row.runnerId,
		workspace: row.workspace,
		externalSessionId: row.externalSessionId,
		resultSummary: row.resultSummary,
		artifacts: ArtifactsSchema.parse(row.artifacts),
		costMicroUsd: row.costMicroUsd,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		endedAt: row.endedAt?.toISOString() ?? null,
	};
}

/** 日志行只经 `@/services/tasks` 写入，写入前已按 kind 校验载荷。 */
export function toRunLog(row: TaskLogRow): RunLog {
	return {
		id: row.id,
		taskId: row.taskId,
		runId: row.runId,
		seq: row.seq,
		kind: row.kind,
		payload: row.payload,
		createdAt: row.createdAt.toISOString(),
	};
}

/** 任务名下的日志行（taskId 非空）。 */
export function toTaskLog(row: TaskLogRow & { taskId: string }): TaskLog {
	return { ...toRunLog(row), taskId: row.taskId };
}

type TopicRow = typeof topics.$inferSelect;

export function toTopic(
	row: TopicRow,
	taskState: Topic["taskState"] = null,
): Topic {
	return {
		id: row.id,
		tenantId: row.tenantId,
		conversationId: row.conversationId,
		title: row.title,
		kind: row.kind,
		taskId: row.taskId,
		isMain: row.isMain,
		createdBy: row.createdBy,
		archivedAt: row.archivedAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString(),
		lastEventAt: row.lastEventAt.toISOString(),
		sourceTopicId: row.sourceTopicId,
		movedToConversationId: row.movedToConversationId,
		taskState,
	};
}

type RunRow = typeof runs.$inferSelect;

/** 代理的运行（系统运行没有代理，不经这里对外）。 */
export type AgentRunRow = RunRow & {
	agentId: string;
	actingForId: string;
	conversationId: string;
	topicId: string;
};

export function isAgentRun(row: RunRow): row is AgentRunRow {
	return (
		row.agentId !== null &&
		row.actingForId !== null &&
		row.conversationId !== null &&
		row.topicId !== null
	);
}

export function toRun(row: AgentRunRow): Run {
	return {
		id: row.id,
		tenantId: row.tenantId,
		agentId: row.agentId,
		conversationId: row.conversationId,
		topicId: row.topicId,
		taskId: row.taskId,
		trigger: row.trigger,
		actingForId: row.actingForId,
		engine: row.engine,
		state: row.state,
		startedAt: row.startedAt.toISOString(),
		endedAt: row.endedAt?.toISOString() ?? null,
		summary: row.summary,
		externalSessionId: row.externalSessionId,
	};
}
