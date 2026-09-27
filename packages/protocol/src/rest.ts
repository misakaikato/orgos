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
	TASK_STATES,
	TaskLogSchema,
	TaskSchema,
	TenantSchema,
	UserSchema,
	WORK_ITEM_STATUSES,
	type WorkItem,
	WorkItemSchema,
} from "./entities";
import { EventSchema, MESSAGE_MAX_LENGTH } from "./events";
import { DEVICE_NAME_MAX_LENGTH, RunnerSchema } from "./runner";

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
	WORK_ITEM_NOT_OPEN: "WORK_ITEM_NOT_OPEN",
	WORK_ITEM_ACTION_MISMATCH: "WORK_ITEM_ACTION_MISMATCH",
	NOT_IMPLEMENTED: "NOT_IMPLEMENTED",
	PAIRING_CODE_INVALID: "PAIRING_CODE_INVALID",
	ADAPTER_UNAVAILABLE: "ADAPTER_UNAVAILABLE",
	TASK_ENDED: "TASK_ENDED",
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

export const RESOLUTION_TEXT_MAX_LENGTH = 4000;

/**
 * `POST /api/work-items/:id/resolve`：动作须与待办的 kind 对应——
 * decision 用 answer / decline，approval 用 approve / deny，confirmation 用 confirm / reject。
 */
export const ResolveWorkItemRequestSchema = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("answer"),
		text: z.string().trim().min(1).max(RESOLUTION_TEXT_MAX_LENGTH),
		/** 同时把问题与答复存为本人的共享资料。 */
		saveAsNote: z.boolean().optional(),
	}),
	z.object({
		action: z.literal("decline"),
		text: z.string().trim().max(RESOLUTION_TEXT_MAX_LENGTH).optional(),
	}),
	z.object({
		action: z.enum(["approve", "deny"]),
		/** 带选项的审批（外部助手的权限请求）：选哪个选项；不给时取第一个同类选项。 */
		optionId: z.string().min(1).max(200).optional(),
	}),
	z.object({ action: z.enum(["confirm", "reject"]) }),
]);
export type ResolveWorkItemRequest = z.infer<
	typeof ResolveWorkItemRequestSchema
>;
export type ResolveAction = ResolveWorkItemRequest["action"];

/** 各 kind 可用的处理动作。 */
export const RESOLVE_ACTIONS_BY_KIND = {
	question: [],
	commitment: [],
	decision: ["answer", "decline"],
	approval: ["approve", "deny"],
	confirmation: ["confirm", "reject"],
} as const satisfies Record<WorkItem["kind"], readonly ResolveAction[]>;

export const WorkItemResponseSchema = z.object({
	workItem: WorkItemSchema,
});
export type WorkItemResponse = z.infer<typeof WorkItemResponseSchema>;

// ─────────────────────────── 代理组 ───────────────────────────

export const AGENT_DESCRIPTION_MAX_LENGTH = 2000;
export const DELEGATION_POLICY_MAX_LENGTH = 2000;

export const AgentListResponseSchema = z.object({
	items: z.array(AgentSchema),
});
export type AgentListResponse = z.infer<typeof AgentListResponseSchema>;

/** 新建一位助手（分身每人恰好一个，随入驻创建）。 */
export const CreateSpecialistRequestSchema = z.object({
	kind: z.literal("specialist").optional(),
	displayName: DisplayNameSchema,
	handle: HandleSchema,
	description: z.string().trim().max(AGENT_DESCRIPTION_MAX_LENGTH),
});

export const WORKSPACE_PATH_MAX_LENGTH = 4096;

/** 接入一位外部助手：在本人的一台设备上以某个适配器运行，限定在一个工作目录里。 */
export const CreateExternalAgentRequestSchema = z.object({
	kind: z.literal("external"),
	displayName: DisplayNameSchema,
	handle: HandleSchema,
	adapter: z.string().trim().min(1).max(64),
	runnerId: z.uuid(),
	/** 绝对路径，或相对设备工作目录的路径；必须在设备工作目录之内。 */
	workspace: z.string().trim().min(1).max(WORKSPACE_PATH_MAX_LENGTH),
	description: z.string().trim().max(AGENT_DESCRIPTION_MAX_LENGTH).optional(),
});

export const CreateAgentRequestSchema = z.union([
	CreateExternalAgentRequestSchema,
	CreateSpecialistRequestSchema,
]);
export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;
export type CreateSpecialistRequest = z.infer<
	typeof CreateSpecialistRequestSchema
>;
export type CreateExternalAgentRequest = z.infer<
	typeof CreateExternalAgentRequestSchema
>;

export const UpdateAgentRequestSchema = z.object({
	displayName: DisplayNameSchema.optional(),
	description: z.string().trim().max(AGENT_DESCRIPTION_MAX_LENGTH).optional(),
	/** 仅分身：本人写的对外授权政策。 */
	delegationPolicy: z
		.string()
		.trim()
		.max(DELEGATION_POLICY_MAX_LENGTH)
		.optional(),
	/** 仅助手：绑定到本人的一台设备（null 解绑）。 */
	runnerId: z.uuid().nullable().optional(),
});
export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequestSchema>;

export const AgentResponseSchema = z.object({ agent: AgentSchema });
export type AgentResponse = z.infer<typeof AgentResponseSchema>;

// ─────────────────────────── 任务 ───────────────────────────

/** `GET /api/tasks` 的查询参数：不给会话时是与我有关的任务（为我办、由我交办、我的代理在办）。 */
export const TasksQuerySchema = z.object({
	conversationId: z.uuid().optional(),
	state: z.enum(TASK_STATES).optional(),
});
export type TasksQuery = z.infer<typeof TasksQuerySchema>;

export const TaskListResponseSchema = z.object({
	items: z.array(TaskSchema),
});
export type TaskListResponse = z.infer<typeof TaskListResponseSchema>;

export const TaskResponseSchema = z.object({
	task: TaskSchema,
	/** 执行者（交办所在会话里未必有它，卡片据此显示团子与名字）。 */
	assignee: PrincipalSchema.optional(),
});
export type TaskResponse = z.infer<typeof TaskResponseSchema>;

export const TaskLogQuerySchema = z.object({
	after: z.coerce.number().int().min(0).default(0),
});
export type TaskLogQuery = z.infer<typeof TaskLogQuerySchema>;

export const TASK_LOG_PAGE_MAX = 500;

export const TaskLogResponseSchema = z.object({
	items: z.array(TaskLogSchema),
});
export type TaskLogResponse = z.infer<typeof TaskLogResponseSchema>;

/** "新任务"：在与外部助手的私聊里强制开一个新任务（当前未结束的任务随之完成）。 */
export const CreateTaskRequestSchema = z.object({
	conversationId: z.uuid(),
	goal: z
		.string()
		.max(MESSAGE_MAX_LENGTH)
		.refine((t) => t.trim().length > 0, "任务不能为空"),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;

// ─────────────────────────── 设备 ───────────────────────────

export const CreatePairingCodeResponseSchema = z.object({
	code: z.string(),
	expiresAt: z.iso.datetime(),
	/** 服务端所在仓库的目录：设备页据此给出可直接复制的 Runner 命令。 */
	repoDir: z.string(),
});
export type CreatePairingCodeResponse = z.infer<
	typeof CreatePairingCodeResponseSchema
>;

/** `POST /api/runners/pair`：凭配对码，无需登录。 */
export const PairRunnerRequestSchema = z.object({
	code: z.string().trim().min(1).max(64),
	name: z.string().trim().min(1).max(DEVICE_NAME_MAX_LENGTH),
	os: z.string().trim().min(1).max(64),
});
export type PairRunnerRequest = z.infer<typeof PairRunnerRequestSchema>;

export const PairRunnerResponseSchema = z.object({
	runnerId: z.uuid(),
	token: z.string(),
});
export type PairRunnerResponse = z.infer<typeof PairRunnerResponseSchema>;

export const RunnerListResponseSchema = z.object({
	items: z.array(RunnerSchema),
});
export type RunnerListResponse = z.infer<typeof RunnerListResponseSchema>;

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
