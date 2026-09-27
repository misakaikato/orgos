/**
 * 会话事件：每种 type 一个 Zod 载荷。`events` 表只追加，线上形态见 EventSchema。
 */
import { z } from "zod";
import { NEGOTIATION_OUTCOMES, NEGOTIATION_STATUSES } from "./entities";

export const MESSAGE_MAX_LENGTH = 8000;

export const MessagePostedPayloadSchema = z.object({
	text: z.string(),
	/** 被 @ 的主体 id。 */
	mentions: z.array(z.uuid()),
});

export const AgentActionPayloadSchema = z.object({
	tool: z.string(),
	summary: z.string(),
	ok: z.boolean(),
});

export const EscalationCreatedPayloadSchema = z.object({
	workItemId: z.uuid(),
	question: z.string(),
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

const eventBase = {
	id: z.number().int(),
	tenantId: z.uuid(),
	conversationId: z.uuid().nullable(),
	seq: z.number().int().nullable(),
	actorId: z.uuid(),
	onBehalfOfId: z.uuid().nullable(),
	createdAt: z.iso.datetime(),
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
	"negotiation.ended": NegotiationEndedPayloadSchema,
	"confirmation.resolved": ConfirmationResolvedPayloadSchema,
	"member.joined": MemberJoinedPayloadSchema,
};
