/**
 * 会话事件：每种 type 一个 Zod 载荷。`events` 表只追加，线上形态见 EventSchema。
 */
import { z } from "zod";
import { AcpPermissionOptionSchema, AcpToolCallSchema } from "./acp";
import {
	APPROVAL_OUTCOMES,
	NEGOTIATION_OUTCOMES,
	NEGOTIATION_STATUSES,
	TASK_STATES,
	TaskArtifactSchema,
} from "./entities";

export const MESSAGE_MAX_LENGTH = 8000;

export const MessagePostedPayloadSchema = z.object({
	text: z.string(),
	/** 被 @ 的主体 id。 */
	mentions: z.array(z.uuid()),
	/** 发送者切到"问分身"：私聊里指向对方的分身，群聊里指向被 @ 的人的分身。 */
	askTwin: z.boolean().optional(),
});

export const AgentActionPayloadSchema = z.object({
	tool: z.string(),
	summary: z.string(),
	ok: z.boolean(),
});

export const EscalationCreatedPayloadSchema = z.object({
	workItemId: z.uuid(),
	question: z.string(),
	/** 协商中分身请本人拍板（need_owner）时：所在的协商会话。 */
	negotiationConversationId: z.uuid().optional(),
});

export const EscalationResolvedPayloadSchema = z.object({
	workItemId: z.uuid(),
	action: z.string(),
	text: z.string().optional(),
});

export const NegotiationStepPayloadSchema = z.object({
	step: z.number().int(),
	status: z.enum(NEGOTIATION_STATUSES),
	message: z.string(),
	proposal: z.unknown().optional(),
});

/** 落在两位本人的私聊里，界面为协商卡片。 */
export const NegotiationStartedPayloadSchema = z.object({
	negotiationConversationId: z.uuid(),
	goal: z.string(),
});

export const NegotiationEndedPayloadSchema = z.object({
	outcome: z.enum(NEGOTIATION_OUTCOMES),
	proposal: z.unknown().optional(),
});

export const ConfirmationResolvedPayloadSchema = z.object({
	workItemId: z.uuid(),
	action: z.enum(["confirm", "reject"]),
});

export const MemberJoinedPayloadSchema = z.object({
	principalId: z.uuid(),
});

/** 退群（本人退出或被移出；人的分身随之一起退）。 */
export const MemberLeftPayloadSchema = z.object({
	principalId: z.uuid(),
});

/** 话题已转成群聊：落在原话题里，指向新群。 */
export const TopicMovedPayloadSchema = z.object({
	conversationId: z.uuid(),
	title: z.string(),
});

/** 代理要在本人的设备上做有风险的操作，等本人批准（界面为审批卡片）。 */
export const ApprovalRequestedPayloadSchema = z.object({
	workItemId: z.uuid(),
	runnerId: z.uuid(),
	/** 发起时的设备名（设备改名或吊销后卡片仍能显示）。 */
	runnerName: z.string(),
	capability: z.string(),
	args: z.unknown(),
	/** 外部助手的权限请求：所属任务、工具调用与可选的选项。 */
	taskId: z.uuid().optional(),
	/** 发起请求的那次运行。 */
	runId: z.uuid().optional(),
	toolCall: AcpToolCallSchema.optional(),
	options: z.array(AcpPermissionOptionSchema).optional(),
});

export const ApprovalResolvedPayloadSchema = z.object({
	workItemId: z.uuid(),
	outcome: z.enum(APPROVAL_OUTCOMES),
	optionId: z.string().optional(),
});

/** 在交办所在的会话里建了一个任务（界面为随状态更新的任务卡片）。 */
export const TaskCreatedPayloadSchema = z.object({
	taskId: z.uuid(),
	title: z.string(),
});

export const TaskUpdatedPayloadSchema = z.object({
	taskId: z.uuid(),
	state: z.enum(TASK_STATES),
	summary: z.string().optional(),
});

export const TaskEndedPayloadSchema = z.object({
	taskId: z.uuid(),
	state: z.enum(TASK_STATES),
	summary: z.string(),
	artifacts: z.array(TaskArtifactSchema),
});

const eventBase = {
	id: z.number().int(),
	tenantId: z.uuid(),
	conversationId: z.uuid().nullable(),
	seq: z.number().int().nullable(),
	actorId: z.uuid(),
	onBehalfOfId: z.uuid().nullable(),
	createdAt: z.iso.datetime(),
	/** 事件所在的话题（服务端总是给出；旧客户端可忽略）。 */
	topicId: z.uuid().optional(),
};

export const EventSchema = z.discriminatedUnion("type", [
	z.object({
		...eventBase,
		type: z.literal("message.posted"),
		payload: MessagePostedPayloadSchema,
	}),
	z.object({
		...eventBase,
		type: z.literal("agent.action"),
		payload: AgentActionPayloadSchema,
	}),
	z.object({
		...eventBase,
		type: z.literal("escalation.created"),
		payload: EscalationCreatedPayloadSchema,
	}),
	z.object({
		...eventBase,
		type: z.literal("escalation.resolved"),
		payload: EscalationResolvedPayloadSchema,
	}),
	z.object({
		...eventBase,
		type: z.literal("negotiation.step"),
		payload: NegotiationStepPayloadSchema,
	}),
	z.object({
		...eventBase,
		type: z.literal("negotiation.started"),
		payload: NegotiationStartedPayloadSchema,
	}),
	z.object({
		...eventBase,
		type: z.literal("negotiation.ended"),
		payload: NegotiationEndedPayloadSchema,
	}),
	z.object({
		...eventBase,
		type: z.literal("confirmation.resolved"),
		payload: ConfirmationResolvedPayloadSchema,
	}),
	z.object({
		...eventBase,
		type: z.literal("member.joined"),
		payload: MemberJoinedPayloadSchema,
	}),
	z.object({
		...eventBase,
		type: z.literal("member.left"),
		payload: MemberLeftPayloadSchema,
	}),
	z.object({
		...eventBase,
		type: z.literal("topic.moved"),
		payload: TopicMovedPayloadSchema,
	}),
	z.object({
		...eventBase,
		type: z.literal("approval.requested"),
		payload: ApprovalRequestedPayloadSchema,
	}),
	z.object({
		...eventBase,
		type: z.literal("approval.resolved"),
		payload: ApprovalResolvedPayloadSchema,
	}),
	z.object({
		...eventBase,
		type: z.literal("task.created"),
		payload: TaskCreatedPayloadSchema,
	}),
	z.object({
		...eventBase,
		type: z.literal("task.updated"),
		payload: TaskUpdatedPayloadSchema,
	}),
	z.object({
		...eventBase,
		type: z.literal("task.ended"),
		payload: TaskEndedPayloadSchema,
	}),
]);
export type Event = z.infer<typeof EventSchema>;
export type EventType = Event["type"];
export type EventPayload<T extends EventType> = Extract<
	Event,
	{ type: T }
>["payload"];

/** 写入事件前的形态：类型与载荷成对校验。 */
export type EventDraft = {
	[T in EventType]: { type: T; payload: EventPayload<T> };
}[EventType];

/** 各事件类型的载荷 schema（写入事件前按此校验）。 */
export const EVENT_PAYLOAD_SCHEMAS: { [T in EventType]: z.ZodType } = {
	"message.posted": MessagePostedPayloadSchema,
	"agent.action": AgentActionPayloadSchema,
	"escalation.created": EscalationCreatedPayloadSchema,
	"escalation.resolved": EscalationResolvedPayloadSchema,
	"negotiation.step": NegotiationStepPayloadSchema,
	"negotiation.started": NegotiationStartedPayloadSchema,
	"negotiation.ended": NegotiationEndedPayloadSchema,
	"confirmation.resolved": ConfirmationResolvedPayloadSchema,
	"member.joined": MemberJoinedPayloadSchema,
	"member.left": MemberLeftPayloadSchema,
	"topic.moved": TopicMovedPayloadSchema,
	"approval.requested": ApprovalRequestedPayloadSchema,
	"approval.resolved": ApprovalResolvedPayloadSchema,
	"task.created": TaskCreatedPayloadSchema,
	"task.updated": TaskUpdatedPayloadSchema,
	"task.ended": TaskEndedPayloadSchema,
};
