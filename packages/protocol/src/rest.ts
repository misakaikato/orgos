/**
 * REST 出入参。服务端用这些 schema 校验入参，前端用同一份类型。
 */
import { z } from "zod";
import {
	AgentSchema,
	ConversationSchema,
	HandleSchema,
	NOTE_VISIBILITIES,
	NoteSchema,
	PRINCIPAL_STATUSES,
	PrincipalSchema,
	TenantSchema,
	UserSchema,
	WORK_ITEM_STATUSES,
	WorkItemSchema,
} from "./entities";
import { EventSchema, MESSAGE_MAX_LENGTH } from "./events";

/** 统一错误体：`{ error: { code, message } }`。 */
export const ErrorBodySchema = z.object({
	error: z.object({
		code: z.string(),
		message: z.string(),
	}),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

export const ERROR_CODES = {
	BAD_REQUEST: "BAD_REQUEST",
	UNAUTHORIZED: "UNAUTHORIZED",
	FORBIDDEN: "FORBIDDEN",
	NOT_FOUND: "NOT_FOUND",
	NOT_ONBOARDED: "NOT_ONBOARDED",
	ALREADY_ONBOARDED: "ALREADY_ONBOARDED",
	HANDLE_TAKEN: "HANDLE_TAKEN",
	INVITE_CODE_INVALID: "INVITE_CODE_INVALID",
	AGENT_NOT_REACHABLE: "AGENT_NOT_REACHABLE",
	ALREADY_MEMBER: "ALREADY_MEMBER",
	INTERNAL: "INTERNAL",
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

const DisplayNameSchema = z.string().trim().min(1).max(40);

export const OnboardingRequestSchema = z.discriminatedUnion("mode", [
	z.object({
		mode: z.literal("create"),
		orgName: z.string().trim().min(1).max(60),
		displayName: DisplayNameSchema,
		handle: HandleSchema,
	}),
	z.object({
		mode: z.literal("join"),
		inviteCode: z.string().trim().min(1).max(64),
		displayName: DisplayNameSchema,
		handle: HandleSchema,
	}),
]);
export type OnboardingRequest = z.infer<typeof OnboardingRequestSchema>;

export const OnboardingResponseSchema = z.object({
	tenant: TenantSchema,
	principal: PrincipalSchema,
	agents: z.array(AgentSchema).length(2),
});
export type OnboardingResponse = z.infer<typeof OnboardingResponseSchema>;

export const MeResponseSchema = z.object({
	user: UserSchema,
	tenant: TenantSchema,
	principal: PrincipalSchema,
	agents: z.array(AgentSchema),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const UpdateStatusRequestSchema = z.object({
	status: z.enum(PRINCIPAL_STATUSES),
});
export type UpdateStatusRequest = z.infer<typeof UpdateStatusRequestSchema>;

export const UpdateStatusResponseSchema = z.object({
	principal: PrincipalSchema,
});
export type UpdateStatusResponse = z.infer<typeof UpdateStatusResponseSchema>;

export const DirectoryResponseSchema = z.object({
	people: z.array(
		z.object({
			principal: PrincipalSchema,
			front: PrincipalSchema,
		}),
	),
});
export type DirectoryResponse = z.infer<typeof DirectoryResponseSchema>;

// ─────────────────────────── 会话 ───────────────────────────

export const ConversationSummarySchema = z.object({
	conversation: ConversationSchema,
	members: z.array(PrincipalSchema),
	lastEvent: EventSchema.optional(),
	/** 他人发来、我尚未读到的消息数。 */
	unread: z.number().int(),
	/** 我在该会话里已读到的 seq。 */
	lastReadSeq: z.number().int().optional(),
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

export const ConversationListResponseSchema = z.object({
	items: z.array(ConversationSummarySchema),
});
export type ConversationListResponse = z.infer<
	typeof ConversationListResponseSchema
>;

export const GROUP_TITLE_MAX_LENGTH = 60;

export const CreateConversationRequestSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("dm"),
		withPrincipalId: z.uuid(),
	}),
	z.object({
		kind: z.literal("group"),
		title: z.string().trim().min(1).max(GROUP_TITLE_MAX_LENGTH),
		memberIds: z.array(z.uuid()).max(100),
	}),
]);
export type CreateConversationRequest = z.infer<
	typeof CreateConversationRequestSchema
>;

export const CreateConversationResponseSchema = z.object({
	conversation: ConversationSchema,
});
export type CreateConversationResponse = z.infer<
	typeof CreateConversationResponseSchema
>;

export const EVENTS_PAGE_MAX = 200;

/** `GET /api/conversations/:id/events` 的查询参数（字符串经 coerce 转数字）。 */
export const EventsQuerySchema = z.object({
	after: z.coerce.number().int().min(0).default(0),
	limit: z.coerce.number().int().min(1).max(EVENTS_PAGE_MAX).default(100),
});
export type EventsQuery = z.infer<typeof EventsQuerySchema>;

export const EventsResponseSchema = z.object({
	items: z.array(EventSchema),
});
export type EventsResponse = z.infer<typeof EventsResponseSchema>;

export const PostMessageRequestSchema = z.object({
	text: z
		.string()
		.max(MESSAGE_MAX_LENGTH)
		.refine((t) => t.trim().length > 0, "消息不能为空"),
	mentions: z.array(z.uuid()).max(50).optional(),
	/** 仅在两个真人的私聊中有效：这条消息请对方的分身回答。 */
	askTwin: z.boolean().optional(),
});
export type PostMessageRequest = z.infer<typeof PostMessageRequestSchema>;

export const PostMessageResponseSchema = z.object({
	event: EventSchema,
});
export type PostMessageResponse = z.infer<typeof PostMessageResponseSchema>;

export const AddMemberRequestSchema = z.object({
	principalId: z.uuid(),
});
export type AddMemberRequest = z.infer<typeof AddMemberRequestSchema>;

export const MarkReadRequestSchema = z.object({
	seq: z.number().int().min(0),
});
export type MarkReadRequest = z.infer<typeof MarkReadRequestSchema>;

// ─────────────────────────── 待办 ───────────────────────────

/** `GET /api/work-items` 的查询参数。 */
export const WorkItemsQuerySchema = z.object({
	status: z.enum(WORK_ITEM_STATUSES).default("open"),
});
export type WorkItemsQuery = z.infer<typeof WorkItemsQuerySchema>;

export const WorkItemListResponseSchema = z.object({
	items: z.array(WorkItemSchema),
});
export type WorkItemListResponse = z.infer<typeof WorkItemListResponseSchema>;

// ─────────────────────────── 代理组 ───────────────────────────

export const AGENT_DESCRIPTION_MAX_LENGTH = 2000;
export const DELEGATION_POLICY_MAX_LENGTH = 2000;

export const AgentListResponseSchema = z.object({
	items: z.array(AgentSchema),
});
export type AgentListResponse = z.infer<typeof AgentListResponseSchema>;

/** 新建的代理一律是助手（分身每人恰好一个，随入驻创建）。 */
export const CreateAgentRequestSchema = z.object({
	displayName: DisplayNameSchema,
	handle: HandleSchema,
	description: z.string().trim().max(AGENT_DESCRIPTION_MAX_LENGTH),
});
export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;

export const UpdateAgentRequestSchema = z.object({
	displayName: DisplayNameSchema.optional(),
	description: z.string().trim().max(AGENT_DESCRIPTION_MAX_LENGTH).optional(),
	/** 仅分身：本人写的对外授权政策。 */
	delegationPolicy: z
		.string()
		.trim()
		.max(DELEGATION_POLICY_MAX_LENGTH)
		.optional(),
});
export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequestSchema>;

export const AgentResponseSchema = z.object({ agent: AgentSchema });
export type AgentResponse = z.infer<typeof AgentResponseSchema>;

// ─────────────────────────── 资料 ───────────────────────────

export const NOTE_TITLE_MAX_LENGTH = 120;
export const NOTE_BODY_MAX_LENGTH = 8000;

const NoteTitleSchema = z.string().trim().min(1).max(NOTE_TITLE_MAX_LENGTH);
const NoteBodySchema = z.string().max(NOTE_BODY_MAX_LENGTH);

export const NoteListResponseSchema = z.object({
	items: z.array(NoteSchema),
});
export type NoteListResponse = z.infer<typeof NoteListResponseSchema>;

export const CreateNoteRequestSchema = z.object({
	title: NoteTitleSchema,
	body: NoteBodySchema,
	visibility: z.enum(NOTE_VISIBILITIES).default("private"),
});
export type CreateNoteRequest = z.input<typeof CreateNoteRequestSchema>;

export const UpdateNoteRequestSchema = z.object({
	title: NoteTitleSchema.optional(),
	body: NoteBodySchema.optional(),
	visibility: z.enum(NOTE_VISIBILITIES).optional(),
});
export type UpdateNoteRequest = z.infer<typeof UpdateNoteRequestSchema>;

export const NoteResponseSchema = z.object({ note: NoteSchema });
export type NoteResponse = z.infer<typeof NoteResponseSchema>;

// ─────────────────────────── 用量 ───────────────────────────

export const AgentUsageSchema = z.object({
	agentId: z.uuid(),
	requests: z.number().int(),
	inputTokens: z.number().int(),
	outputTokens: z.number().int(),
	/** 未定价或计量解析失败的请求不计入。 */
	costMicroUsd: z.number().int(),
});
export type AgentUsage = z.infer<typeof AgentUsageSchema>;

export const UsageResponseSchema = z.object({
	byAgent: z.array(AgentUsageSchema),
});
export type UsageResponse = z.infer<typeof UsageResponseSchema>;

// ─────────────────────────── 模拟台（仅 ORGOS_DEV=1） ───────────────────────────

export const MODEL_MODES = ["real", "mock"] as const;

export const DevInfoResponseSchema = z.object({
	modelMode: z.enum(MODEL_MODES),
	model: z.string(),
});
export type DevInfoResponse = z.infer<typeof DevInfoResponseSchema>;

export const DevSessionRequestSchema = z.object({
	handle: HandleSchema,
});
export type DevSessionRequest = z.infer<typeof DevSessionRequestSchema>;

export const DevSessionResponseSchema = z.object({
	token: z.string(),
	principal: PrincipalSchema,
});
export type DevSessionResponse = z.infer<typeof DevSessionResponseSchema>;

export const DemoPersonSchema = z.object({
	handle: z.string(),
	displayName: z.string(),
	title: z.string(),
});
export type DemoPerson = z.infer<typeof DemoPersonSchema>;

export const DemoCountsSchema = z.object({
	people: z.number().int(),
	conversations: z.number().int(),
	events: z.number().int(),
	openWorkItems: z.number().int(),
	notes: z.number().int(),
});
export type DemoCounts = z.infer<typeof DemoCountsSchema>;

export const ResetDemoResponseSchema = z.object({
	counts: DemoCountsSchema,
});
export type ResetDemoResponse = z.infer<typeof ResetDemoResponseSchema>;

/** `GET /api/dev/people`：模拟台可扮演的演示人物。 */
export const DemoPeopleResponseSchema = z.object({
	people: z.array(DemoPersonSchema),
});
export type DemoPeopleResponse = z.infer<typeof DemoPeopleResponseSchema>;
