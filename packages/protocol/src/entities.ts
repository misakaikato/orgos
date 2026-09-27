/**
 * 实体的线上形态（REST 出参、WS 帧共用）。枚举值数组同时是数据库列的取值来源。
 */
import { z } from "zod";

export const MEMBER_ROLES = ["owner", "member"] as const;
export const PRINCIPAL_KINDS = ["human", "agent"] as const;
export const AGENT_ROLES = ["front", "specialist"] as const;
export const CONVERSATION_KINDS = ["dm", "group", "negotiation"] as const;
export const CONVERSATION_MEMBER_ROLES = ["member", "observer"] as const;
export const WORK_ITEM_KINDS = [
	"question",
	"commitment",
	"decision",
	"approval",
	"confirmation",
] as const;
export const WORK_ITEM_STATUSES = ["open", "done", "cancelled"] as const;
export const NOTE_VISIBILITIES = ["private", "shared"] as const;
export const RUNNER_STATUSES = ["online", "offline"] as const;
/** 人的在线状态；忙碌与离开时，别人在私聊里发给他的消息由他的分身先回复。 */
export const PRINCIPAL_STATUSES = ["available", "busy", "away"] as const;
export type PrincipalStatus = (typeof PRINCIPAL_STATUSES)[number];

export const DEFAULT_AGENT_MODEL = "deepseek-v4-flash";

/** 人的 handle：小写字母开头，2–31 位小写字母、数字、连字符。 */
export const HANDLE_RE = /^[a-z][a-z0-9-]{1,30}$/;

export const HandleSchema = z.string().regex(HANDLE_RE);

export const TenantSchema = z.object({
	id: z.uuid(),
	name: z.string(),
	/** 仅 owner 可见。 */
	inviteCode: z.string().optional(),
});
export type Tenant = z.infer<typeof TenantSchema>;

export const PrincipalSchema = z.object({
	id: z.uuid(),
	tenantId: z.uuid(),
	kind: z.enum(PRINCIPAL_KINDS),
	userId: z.string().nullable(),
	ownerId: z.uuid().nullable(),
	handle: z.string(),
	displayName: z.string(),
	createdAt: z.iso.datetime(),
	/** 仅人有：在线状态。 */
	status: z.enum(PRINCIPAL_STATUSES).optional(),
});
export type Principal = z.infer<typeof PrincipalSchema>;

export const AgentSchema = z.object({
	principal: PrincipalSchema,
	role: z.enum(AGENT_ROLES),
	description: z.string(),
	delegationPolicy: z.string(),
	model: z.string(),
	runnerId: z.uuid().nullable(),
	updatedAt: z.iso.datetime(),
});
export type Agent = z.infer<typeof AgentSchema>;

export const UserSchema = z.object({
	id: z.string(),
	email: z.string(),
	name: z.string(),
});
export type User = z.infer<typeof UserSchema>;

export const ConversationSchema = z.object({
	id: z.uuid(),
	tenantId: z.uuid(),
	kind: z.enum(CONVERSATION_KINDS),
	title: z.string().nullable(),
	createdBy: z.uuid(),
	createdAt: z.iso.datetime(),
	lastSeq: z.number().int(),
});
export type Conversation = z.infer<typeof ConversationSchema>;

// ─────────────────────────── 协商 ───────────────────────────

export const NEGOTIATION_STATUSES = [
	"continue",
	"agree",
	"reject",
	"need_owner",
] as const;
export const NEGOTIATION_STATES = [
	"running",
	"waiting_owner",
	"ended",
] as const;
export const NEGOTIATION_OUTCOMES = [
	"agreed",
	"rejected",
	"exhausted",
] as const;
export const NEGOTIATION_MAX_STEPS = 8;

/** `conversations.negotiation`（kind=negotiation 时）。 */
export const NegotiationStateSchema = z.object({
	initiatorAgentId: z.uuid(),
	responderAgentId: z.uuid(),
	goal: z.string(),
	step: z.number().int().min(0),
	maxSteps: z.number().int().min(1),
	state: z.enum(NEGOTIATION_STATES),
	lastProposal: z.unknown().optional(),
	/** 提出 lastProposal 的代理：只有另一方 agree 同一 proposal 才算达成。 */
	lastProposalBy: z.uuid().optional(),
	/** 发起方本人让分身去协商的那个会话：结束时分身在这里回一句结果摘要。 */
	originConversationId: z.uuid().optional(),
});
export type NegotiationState = z.infer<typeof NegotiationStateSchema>;

// ─────────────────────────── 待办 ───────────────────────────

/** 各 kind 的 `work_items.payload`。 */
export const WORK_ITEM_PAYLOAD_SCHEMAS = {
	question: z.object({}),
	commitment: z.object({}),
	decision: z.object({
		question: z.string(),
		askedById: z.uuid(),
		/** 协商中分身请本人拍板时：答复后恢复该协商。 */
		negotiationConversationId: z.uuid().optional(),
	}),
	approval: z.object({
		runnerId: z.uuid(),
		capability: z.string(),
		args: z.unknown(),
	}),
	confirmation: z.object({
		negotiationConversationId: z.uuid(),
		proposal: z.unknown(),
	}),
} as const satisfies Record<(typeof WORK_ITEM_KINDS)[number], z.ZodType>;

/** decision 待办处理后的 `work_items.resolution`。 */
export const DecisionResolutionSchema = z.object({
	action: z.enum(["answer", "decline"]),
	text: z.string().optional(),
	/** 勾选"存为共享资料"时写入的资料。 */
	noteId: z.uuid().optional(),
});
export type DecisionResolution = z.infer<typeof DecisionResolutionSchema>;

/**
 * approval 待办的结局：本人批准 / 拒绝，10 分钟无人处理即过期，
 * 等待中的运行被本人的新消息或"停止"打断即取消。
 */
export const APPROVAL_OUTCOMES = [
	"approve",
	"deny",
	"expired",
	"cancelled",
] as const;
export type ApprovalOutcome = (typeof APPROVAL_OUTCOMES)[number];
/** 审批待办从建立起最长等待本人处理的时间。 */
export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

/** approval 待办了结后的 `work_items.resolution`。 */
export const ApprovalResolutionSchema = z.object({
	outcome: z.enum(APPROVAL_OUTCOMES),
});
export type ApprovalResolution = z.infer<typeof ApprovalResolutionSchema>;

/** confirmation 待办被本人处理后的 `work_items.resolution`（另一方驳回而作废的待办没有 resolution）。 */
export const ConfirmationResolutionSchema = z.object({
	action: z.enum(["confirm", "reject"]),
});
export type ConfirmationResolution = z.infer<
	typeof ConfirmationResolutionSchema
>;

const workItemBase = {
	id: z.uuid(),
	tenantId: z.uuid(),
	title: z.string(),
	body: z.string(),
	ownerId: z.uuid(),
	requesterId: z.uuid(),
	status: z.enum(WORK_ITEM_STATUSES),
	conversationId: z.uuid().nullable(),
	sourceEventId: z.number().int().nullable(),
	resolution: z.unknown().nullable(),
	dueAt: z.iso.datetime().nullable(),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
};

export const WorkItemSchema = z.discriminatedUnion("kind", [
	z.object({
		...workItemBase,
		kind: z.literal("question"),
		payload: WORK_ITEM_PAYLOAD_SCHEMAS.question,
	}),
	z.object({
		...workItemBase,
		kind: z.literal("commitment"),
		payload: WORK_ITEM_PAYLOAD_SCHEMAS.commitment,
	}),
	z.object({
		...workItemBase,
		kind: z.literal("decision"),
		payload: WORK_ITEM_PAYLOAD_SCHEMAS.decision,
	}),
	z.object({
		...workItemBase,
		kind: z.literal("approval"),
		payload: WORK_ITEM_PAYLOAD_SCHEMAS.approval,
	}),
	z.object({
		...workItemBase,
		kind: z.literal("confirmation"),
		payload: WORK_ITEM_PAYLOAD_SCHEMAS.confirmation,
	}),
]);
export type WorkItem = z.infer<typeof WorkItemSchema>;
export type WorkItemKind = WorkItem["kind"];
export type WorkItemPayload<K extends WorkItemKind> = Extract<
	WorkItem,
	{ kind: K }
>["payload"];
/** 写入待办前的形态：kind 与载荷成对校验。 */
export type WorkItemDraft = {
	[K in WorkItemKind]: { kind: K; payload: WorkItemPayload<K> };
}[WorkItemKind];

// ─────────────────────────── 资料与记忆 ───────────────────────────

/** 本人写的资料与代理写的记忆同表：authorId 是代理时即记忆。 */
export const NoteSchema = z.object({
	id: z.uuid(),
	ownerId: z.uuid(),
	authorId: z.uuid(),
	title: z.string(),
	body: z.string(),
	visibility: z.enum(NOTE_VISIBILITIES),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
});
export type Note = z.infer<typeof NoteSchema>;
