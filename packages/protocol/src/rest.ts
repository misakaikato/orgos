/**
 * REST 出入参。服务端用这些 schema 校验入参，前端用同一份类型。
 */
import { z } from "zod";
import {
	AgentSchema,
	ConversationSchema,
	HandleSchema,
	NoteSchema,
	PERSONAL_NOTE_VISIBILITIES,
	PRINCIPAL_STATUSES,
	PrincipalSchema,
	RUNNER_VIAS,
	RunLogSchema,
	RunSchema,
	TASK_STATES,
	TaskLogSchema,
	TaskSchema,
	TenantSchema,
	TenantSettingsSchema,
	TOPIC_TITLE_MAX_LENGTH,
	TopicSchema,
	UserSchema,
	WORK_ITEM_STATUSES,
	type WorkItem,
	WorkItemSchema,
} from "./entities";
import { EventSchema, MESSAGE_MAX_LENGTH, MessageFormatSchema } from "./events";
import {
	EXTERNAL_AGENT_MODES,
	GATEWAY_PROTOCOLS,
	GROUP_ROUTINGS,
	ModelGroupSchema,
	ModelProviderSchema,
	ModelRefSchema,
	ProviderEndpointsSchema,
	ProviderNameSchema,
} from "./models";
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
	TASK_IN_PROGRESS: "TASK_IN_PROGRESS",
	MODEL_UNAVAILABLE: "MODEL_UNAVAILABLE",
	NAME_TAKEN: "NAME_TAKEN",
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
	/** 最近有活动的话题（会话列表的一行里显示它的名字）。 */
	lastTopic: z
		.object({ id: z.uuid(), title: z.string(), isMain: z.boolean() })
		.optional(),
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
	/** 只取某个话题的事件；缺省为主线。 */
	topicId: z.uuid().optional(),
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
	/**
	 * 这条消息请分身回答：两个真人的私聊里指向对方的分身；群聊里指向被 @ 的人的分身
	 * （群聊里没有 @ 任何人时 400）。
	 */
	askTwin: z.boolean().optional(),
	/** 发在哪个话题；缺省为主线。 */
	topicId: z.uuid().optional(),
	/** 正文格式，缺省 text；html 只接受代理经应用接口代发，人直接发 → 400。 */
	format: MessageFormatSchema.optional(),
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

/** `POST /api/conversations/:id/stop` 的查询参数：只停某个话题；缺省停整个会话。 */
export const StopQuerySchema = z.object({
	topicId: z.uuid().optional(),
});
export type StopQuery = z.infer<typeof StopQuerySchema>;

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
		/** 选的是第几个候选（从 0 起），text 须与该候选一致；自己写的答复不带。 */
		option: z.number().int().min(0).optional(),
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
	/** 选用不经审批、不限工作目录的适配器（pi、Hermes）时，本人须勾选确认。 */
	acknowledgeUnsupervised: z.boolean().optional(),
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
	/** 模型：本租户开放的 `厂商/模型` 或 `group/<id>`。 */
	model: ModelRefSchema.optional(),
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

/** "新任务"：在与自己代理的私聊里开一个任务话题，目标作为本人的第一条消息发出。 */
export const CreateTaskRequestSchema = z.object({
	conversationId: z.uuid(),
	goal: z
		.string()
		.max(MESSAGE_MAX_LENGTH)
		.refine((t) => t.trim().length > 0, "任务不能为空"),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;

// ─────────────────────────── 话题 ───────────────────────────

const TopicTitleSchema = z.string().trim().min(1).max(TOPIC_TITLE_MAX_LENGTH);

export const TopicListResponseSchema = z.object({
	items: z.array(TopicSchema),
});
export type TopicListResponse = z.infer<typeof TopicListResponseSchema>;

export const CreateTopicRequestSchema = z.object({ title: TopicTitleSchema });
export type CreateTopicRequest = z.infer<typeof CreateTopicRequestSchema>;

export const UpdateTopicRequestSchema = z.object({
	title: TopicTitleSchema.optional(),
	archived: z.boolean().optional(),
});
export type UpdateTopicRequest = z.infer<typeof UpdateTopicRequestSchema>;

export const TopicResponseSchema = z.object({ topic: TopicSchema });
export type TopicResponse = z.infer<typeof TopicResponseSchema>;

/** "转为任务"：目标缺省取该话题里本人最后一条消息；给了目标则作为本人的消息发出。 */
export const TopicToTaskRequestSchema = z.object({
	goal: z.string().trim().min(1).max(MESSAGE_MAX_LENGTH).optional(),
});
export type TopicToTaskRequest = z.infer<typeof TopicToTaskRequestSchema>;

/** "转成群聊"：以该话题为起点建新群（标题缺省为话题名）。 */
export const TopicToGroupRequestSchema = z.object({
	title: z.string().trim().min(1).max(GROUP_TITLE_MAX_LENGTH).optional(),
	memberIds: z.array(z.uuid()).max(100),
});
export type TopicToGroupRequest = z.infer<typeof TopicToGroupRequestSchema>;

/** 新群主线引用的原话题：只读的前置历史。 */
export const TopicSourceResponseSchema = z.object({
	topic: TopicSchema,
	/** 原话题所在会话的称呼（群名，或"某某与某某的私聊"）。 */
	conversationLabel: z.string(),
	members: z.array(PrincipalSchema),
	events: z.array(EventSchema),
});
export type TopicSourceResponse = z.infer<typeof TopicSourceResponseSchema>;

// ─────────────────────────── 运行记录 ───────────────────────────

export const RunsQuerySchema = z.object({
	agentId: z.uuid().optional(),
	topicId: z.uuid().optional(),
});
export type RunsQuery = z.infer<typeof RunsQuerySchema>;

export const RunListResponseSchema = z.object({ items: z.array(RunSchema) });
export type RunListResponse = z.infer<typeof RunListResponseSchema>;

export const RunResponseSchema = z.object({
	run: RunSchema,
	logs: z.array(RunLogSchema),
	usage: z.object({
		requests: z.number().int(),
		inputTokens: z.number().int(),
		outputTokens: z.number().int(),
		costMicroUsd: z.number().int(),
	}),
});
export type RunResponse = z.infer<typeof RunResponseSchema>;

// ─────────────────────────── 租户设置 ───────────────────────────

export const TenantSettingsResponseSchema = z.object({
	settings: TenantSettingsSchema,
});
export type TenantSettingsResponse = z.infer<
	typeof TenantSettingsResponseSchema
>;

export const UpdateTenantSettingsRequestSchema = z.object({
	allowUnsupervisedAdapters: z.boolean().optional(),
	defaultModel: ModelRefSchema.optional(),
	externalAgentMode: z.enum(EXTERNAL_AGENT_MODES).optional(),
	allowPersonalExternal: z.boolean().optional(),
});
export type UpdateTenantSettingsRequest = z.infer<
	typeof UpdateTenantSettingsRequestSchema
>;

// ─────────────────────────── 模型与厂商 ───────────────────────────

const ExposedModelsSchema = z.array(z.string().trim().min(1).max(200)).max(200);
/** key 只写不读：给了就替换，空串表示清除。 */
const ApiKeyInputSchema = z.string().trim().max(1000);

export const CreateModelProviderRequestSchema = z.object({
	name: ProviderNameSchema,
	preset: z.string().max(40).optional(),
	endpoints: ProviderEndpointsSchema,
	apiKey: ApiKeyInputSchema.optional(),
	exposedModels: ExposedModelsSchema.default([]),
});
export type CreateModelProviderRequest = z.input<
	typeof CreateModelProviderRequestSchema
>;

export const UpdateModelProviderRequestSchema = z.object({
	endpoints: ProviderEndpointsSchema.optional(),
	apiKey: ApiKeyInputSchema.optional(),
	exposedModels: ExposedModelsSchema.optional(),
});
export type UpdateModelProviderRequest = z.infer<
	typeof UpdateModelProviderRequestSchema
>;

export const ModelProviderResponseSchema = z.object({
	provider: ModelProviderSchema,
});
export type ModelProviderResponse = z.infer<typeof ModelProviderResponseSchema>;

/** 模型页：厂商、路由组与相关的租户设置（仅租户 owner）。 */
export const ModelAdminResponseSchema = z.object({
	providers: z.array(ModelProviderSchema),
	groups: z.array(ModelGroupSchema),
	settings: TenantSettingsSchema,
});
export type ModelAdminResponse = z.infer<typeof ModelAdminResponseSchema>;

/** 从厂商的 /models 拉到的模型 id；拉不到时 error 说明原因（界面改为手填）。 */
export const ProviderModelsResponseSchema = z.object({
	models: z.array(z.string()),
	error: z.string().optional(),
});
export type ProviderModelsResponse = z.infer<
	typeof ProviderModelsResponseSchema
>;

export const ProviderTestRequestSchema = z.object({
	/** 用哪个模型发最小请求；缺省取开放的第一个。 */
	model: z.string().trim().min(1).max(200).optional(),
});
export type ProviderTestRequest = z.infer<typeof ProviderTestRequestSchema>;

export const ProviderTestResultSchema = z.object({
	protocol: z.enum(GATEWAY_PROTOCOLS),
	ok: z.boolean(),
	latencyMs: z.number().int(),
	httpStatus: z.number().int(),
	/** 成功时是模型的回复，失败时是原因。 */
	message: z.string(),
});
export type ProviderTestResult = z.infer<typeof ProviderTestResultSchema>;

export const ProviderTestResponseSchema = z.object({
	results: z.array(ProviderTestResultSchema),
});
export type ProviderTestResponse = z.infer<typeof ProviderTestResponseSchema>;

const GroupMembersSchema = z.array(ModelRefSchema).min(1).max(20);

export const CreateModelGroupRequestSchema = z.object({
	name: z.string().trim().min(1).max(40),
	members: GroupMembersSchema,
	routing: z.enum(GROUP_ROUTINGS),
});
export type CreateModelGroupRequest = z.infer<
	typeof CreateModelGroupRequestSchema
>;

export const UpdateModelGroupRequestSchema = z.object({
	name: z.string().trim().min(1).max(40).optional(),
	members: GroupMembersSchema.optional(),
	routing: z.enum(GROUP_ROUTINGS).optional(),
});
export type UpdateModelGroupRequest = z.infer<
	typeof UpdateModelGroupRequestSchema
>;

export const ModelGroupResponseSchema = z.object({ group: ModelGroupSchema });
export type ModelGroupResponse = z.infer<typeof ModelGroupResponseSchema>;

/** 代理可选的模型（本租户开放的模型与路由组）。 */
export const ModelOptionSchema = z.object({
	ref: z.string(),
	label: z.string(),
	kind: z.enum(["model", "group"]),
});
export type ModelOption = z.infer<typeof ModelOptionSchema>;

export const ModelOptionsResponseSchema = z.object({
	options: z.array(ModelOptionSchema),
	defaultModel: z.string(),
});
export type ModelOptionsResponse = z.infer<typeof ModelOptionsResponseSchema>;

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
	/** 发起配对的是桌面客户端还是命令行 Runner。 */
	via: z.enum(RUNNER_VIAS).optional(),
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
	visibility: z.enum(PERSONAL_NOTE_VISIBILITIES).default("private"),
});
export type CreateNoteRequest = z.input<typeof CreateNoteRequestSchema>;

export const UpdateNoteRequestSchema = z.object({
	title: NoteTitleSchema.optional(),
	body: NoteBodySchema.optional(),
	visibility: z.enum(PERSONAL_NOTE_VISIBILITIES).optional(),
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
