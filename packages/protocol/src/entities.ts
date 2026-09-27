/**
 * 实体的线上形态（REST 出参、WS 帧共用）。枚举值数组同时是数据库列的取值来源。
 */
import { z } from "zod";
import { AcpPermissionOptionSchema, AcpToolCallSchema } from "./acp";
import { EXTERNAL_AGENT_MODES } from "./models";

export const MEMBER_ROLES = ["owner", "member"] as const;
export const PRINCIPAL_KINDS = ["human", "agent"] as const;
export const AGENT_ROLES = ["front", "specialist"] as const;
/** 代理由谁驱动：orgos 自己的运行循环，或经设备 Runner 以 ACP 接入的外部 agent。 */
export const AGENT_ENGINES = ["builtin", "acp"] as const;
export type AgentEngine = (typeof AGENT_ENGINES)[number];
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

/** 新租户的默认模型（模型引用：`厂商/模型` 或 `group/<id>`）。 */
export const DEFAULT_AGENT_MODEL = "deepseek/deepseek-v4-flash";

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
	/** 缺省为 builtin。 */
	engine: z.enum(AGENT_ENGINES).optional(),
	/** 外部助手：适配器（ACP_ADAPTERS 的 id）与设备上的工作目录。 */
	adapter: z.string().nullable().optional(),
	workspace: z.string().nullable().optional(),
});
export type Agent = z.infer<typeof AgentSchema>;

/** 外部助手（经 ACP 接入）：只替本人干活，只在与本人的私聊里接活。 */
export function isExternalAgent(agent: Pick<Agent, "engine">): boolean {
	return agent.engine === "acp";
}

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
	/** 发起协商的那个话题（在 originConversationId 里）。 */
	originTopicId: z.uuid().optional(),
	/** 两位本人私聊里放协商卡片的话题：上报与确认都落在这里。 */
	cardTopicId: z.uuid().optional(),
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
		/** 外部助手的权限请求：所属任务、请求的工具调用与 agent 给出的选项（所选选项原样回给 agent）。 */
		taskId: z.uuid().optional(),
		/** 发起请求的那次运行：运行结束时仍未处理的审批随之取消。 */
		runId: z.uuid().optional(),
		toolCall: AcpToolCallSchema.optional(),
		options: z.array(AcpPermissionOptionSchema).optional(),
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
	/** 带选项的审批：本人选的（或过期时代为选的拒绝）选项。 */
	optionId: z.string().optional(),
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

// ─────────────────────────── 任务 ───────────────────────────

/**
 * 任务：交给某个执行者、有边界的一件事（外部助手的一次会话，或代理之间的一次交办）。
 * 状态机对齐 A2A 的任务定义。
 */
export const TASK_STATES = [
	"submitted",
	"working",
	"input_required",
	"awaiting_approval",
	"completed",
	"failed",
	"canceled",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TASK_ENDED_STATES: ReadonlySet<TaskState> = new Set([
	"completed",
	"failed",
	"canceled",
]);

export function isTaskEnded(state: TaskState): boolean {
	return TASK_ENDED_STATES.has(state);
}

/** 允许的状态迁移（唯一定义处）；结束态不再迁移。 */
export const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
	submitted: ["working", "failed", "canceled"],
	working: [
		"input_required",
		"awaiting_approval",
		"completed",
		"failed",
		"canceled",
	],
	awaiting_approval: ["working", "completed", "failed", "canceled"],
	input_required: ["working", "completed", "failed", "canceled"],
	completed: [],
	failed: [],
	canceled: [],
};

export function canTransition(from: TaskState, to: TaskState): boolean {
	return TASK_TRANSITIONS[from].includes(to);
}

/** 外部任务无活动多久后自动完成。 */
export const TASK_IDLE_COMPLETE_MS = 24 * 60 * 60 * 1000;

export const TASK_LOG_KINDS = [
	"prompt",
	"agent_text",
	"tool_call",
	"tool_result",
	"permission",
	"state",
	"error",
] as const;
export type TaskLogKind = (typeof TASK_LOG_KINDS)[number];

export const TASK_ARTIFACT_KINDS = ["file", "diff", "link"] as const;

export const TaskArtifactSchema = z.object({
	kind: z.enum(TASK_ARTIFACT_KINDS),
	label: z.string(),
	ref: z.string(),
});
export type TaskArtifact = z.infer<typeof TaskArtifactSchema>;

export const TaskSchema = z.object({
	id: z.uuid(),
	tenantId: z.uuid(),
	conversationId: z.uuid(),
	/** 任务所在的话题（kind=task）。 */
	topicId: z.uuid().optional(),
	requesterId: z.uuid(),
	assigneeId: z.uuid(),
	onBehalfOfId: z.uuid(),
	title: z.string(),
	goal: z.string(),
	state: z.enum(TASK_STATES),
	engine: z.enum(AGENT_ENGINES),
	adapter: z.string().nullable(),
	runnerId: z.uuid().nullable(),
	workspace: z.string().nullable(),
	externalSessionId: z.string().nullable(),
	/** 进行中是最新进度，结束后是结果。 */
	resultSummary: z.string().nullable(),
	artifacts: z.array(TaskArtifactSchema),
	costMicroUsd: z.number().int().nullable(),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
	endedAt: z.iso.datetime().nullable(),
});
export type Task = z.infer<typeof TaskSchema>;

/** 各 kind 的 `task_logs.payload`（写入前按此校验；字段一律宽容，外部 agent 的内容按不可信输入对待）。 */
export const TASK_LOG_PAYLOAD_SCHEMAS = {
	/** 交给执行者的一段话（首次交办或追问）。 */
	prompt: z.object({ text: z.string(), byId: z.uuid().optional() }),
	/** 执行者说的一段话（流式片段在 Runner 侧合并后记一条）。 */
	agent_text: z.object({ text: z.string() }),
	tool_call: z.object({
		toolCallId: z.string().optional(),
		title: z.string(),
		kind: z.string().optional(),
		input: z.unknown().optional(),
	}),
	tool_result: z.object({
		toolCallId: z.string().optional(),
		title: z.string().optional(),
		ok: z.boolean(),
		output: z.string().optional(),
		/** 写了哪个文件（相对工作目录），用于产出列表。 */
		path: z.string().optional(),
	}),
	permission: z.object({
		title: z.string(),
		/** 请求时带的选项；决定后记所选选项与结局。 */
		options: z.array(AcpPermissionOptionSchema).optional(),
		optionId: z.string().nullable().optional(),
		outcome: z.string().optional(),
		/** 无需再问本人（本话题内已始终允许、或同一命令刚在权限请求里批准过）。 */
		auto: z.string().optional(),
		input: z.unknown().optional(),
	}),
	state: z.object({
		state: z.string(),
		sessionId: z.string().optional(),
		agentName: z.string().optional(),
		note: z.string().optional(),
	}),
	error: z.object({ message: z.string(), fatal: z.boolean().optional() }),
} as const satisfies Record<TaskLogKind, z.ZodType>;

export type TaskLogPayload<K extends TaskLogKind> = z.infer<
	(typeof TASK_LOG_PAYLOAD_SCHEMAS)[K]
>;

export const TaskLogSchema = z.object({
	id: z.number().int(),
	taskId: z.uuid(),
	seq: z.number().int(),
	kind: z.enum(TASK_LOG_KINDS),
	payload: z.unknown(),
	createdAt: z.iso.datetime(),
	/** 产生这条记录的运行。 */
	runId: z.uuid().nullable().optional(),
});
export type TaskLog = z.infer<typeof TaskLogSchema>;

/** 一次运行的过程记录：服务于任务的运行记在任务名下（taskId 非空），否则只记在运行名下。 */
export const RunLogSchema = TaskLogSchema.extend({
	taskId: z.uuid().nullable(),
});
export type RunLog = z.infer<typeof RunLogSchema>;

/** 任务标题：目标的第一行，最多 40 字。 */
export const TASK_TITLE_MAX_CHARS = 40;

export function taskTitleOf(goal: string): string {
	const line = goal.trim().split("\n", 1)[0]?.trim() ?? "";
	const chars = Array.from(line);
	return chars.length > TASK_TITLE_MAX_CHARS
		? `${chars.slice(0, TASK_TITLE_MAX_CHARS).join("")}…`
		: line || "任务";
}

// ─────────────────────────── 话题 ───────────────────────────

/**
 * 话题：会话内一条独立的上下文。每个会话恰好一个主线（isMain）；任务 = 带状态的话题（kind=task）。
 */
export const TOPIC_KINDS = ["chat", "task"] as const;
export type TopicKind = (typeof TOPIC_KINDS)[number];

export const TOPIC_TITLE_MAX_LENGTH = 60;
export const MAIN_TOPIC_TITLE = "主线";

export const TopicSchema = z.object({
	id: z.uuid(),
	tenantId: z.uuid(),
	conversationId: z.uuid(),
	title: z.string(),
	kind: z.enum(TOPIC_KINDS),
	/** kind=task：当前（或最近一次）的任务。 */
	taskId: z.uuid().nullable(),
	isMain: z.boolean(),
	createdBy: z.uuid(),
	archivedAt: z.iso.datetime().nullable(),
	createdAt: z.iso.datetime(),
	lastEventAt: z.iso.datetime(),
	/** 由另一个话题转成群聊时：新群主线引用的原话题（只读前置历史）。 */
	sourceTopicId: z.uuid().nullable().optional(),
	/** 已转成群聊：转去的群。 */
	movedToConversationId: z.uuid().nullable().optional(),
	/** 任务话题的任务状态（话题栏的状态点）。 */
	taskState: z.enum(TASK_STATES).nullable().optional(),
	/** 话题列表里：他人发来、在我已读位置之后的消息数（话题栏的未读点）。 */
	unread: z.number().int().optional(),
});
export type Topic = z.infer<typeof TopicSchema>;

/** 任务话题在话题栏上的三种状态点。 */
export type TopicTaskPhase = "active" | "attention" | "done";

export function topicTaskPhase(state: TaskState): TopicTaskPhase {
	if (isTaskEnded(state)) return "done";
	return state === "input_required" || state === "awaiting_approval"
		? "attention"
		: "active";
}

// ─────────────────────────── 运行记录 ───────────────────────────

/** 一次代理运行（内置循环的一次运行，或外部 agent 的一轮）。 */
export const RUN_STATES = [
	"running",
	"completed",
	"failed",
	"canceled",
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const RunSchema = z.object({
	id: z.uuid(),
	tenantId: z.uuid(),
	agentId: z.uuid(),
	conversationId: z.uuid(),
	topicId: z.uuid(),
	taskId: z.uuid().nullable(),
	/** 由什么触发：`event:<id>`、`work_item:<id>`、`run:<id>`（被转交）、`negotiation:<id>`。 */
	trigger: z.string(),
	actingForId: z.uuid(),
	engine: z.enum(AGENT_ENGINES),
	state: z.enum(RUN_STATES),
	startedAt: z.iso.datetime(),
	endedAt: z.iso.datetime().nullable(),
	summary: z.string().nullable(),
	/** 外部 agent 的这一轮所在的 ACP 会话。 */
	externalSessionId: z.string().nullable(),
});
export type Run = z.infer<typeof RunSchema>;

// ─────────────────────────── 租户设置 ───────────────────────────

export const TenantSettingsSchema = z.object({
	/** 允许选用不经 orgos 审批、不限工作目录的外部适配器（pi、Hermes）。仅租户 owner 可改。 */
	allowUnsupervisedAdapters: z.boolean(),
	/** 新代理的默认模型。 */
	defaultModel: z.string().optional(),
	/** 外部助手的模式：enterprise 经网关、用任务令牌；personal 用设备上自己的登录。 */
	externalAgentMode: z.enum(EXTERNAL_AGENT_MODES).optional(),
	/** 允许外部助手使用个人模式。 */
	allowPersonalExternal: z.boolean().optional(),
});
export type TenantSettings = z.infer<typeof TenantSettingsSchema>;
