/**
 * 业务表。better-auth 的 user / session / account / verification 在 ./auth-schema.ts（生成物，不手改）。
 *
 * 所有业务表都带 tenant_id（删除租户时级联清理），查询一律经 `@/db/scope` 的 `scoped(tenantId)`。
 * `events` 只追加：代码中不存在更新或删除事件行的路径。
 */
import {
	AGENT_ENGINES,
	AGENT_ROLES,
	CONVERSATION_KINDS,
	CONVERSATION_MEMBER_ROLES,
	DEFAULT_AGENT_MODEL,
	MEMBER_ROLES,
	NOTE_VISIBILITIES,
	PRINCIPAL_KINDS,
	PRINCIPAL_STATUSES,
	RUN_STATES,
	RUNNER_STATUSES,
	TASK_LOG_KINDS,
	TASK_STATES,
	TOPIC_KINDS,
	WORK_ITEM_KINDS,
	WORK_ITEM_STATUSES,
} from "@orgos/protocol";
import { sql } from "drizzle-orm";
import {
	bigint,
	bigserial,
	boolean,
	check,
	index,
	integer,
	jsonb,
	type PgColumn,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { user } from "@/db/auth-schema";

export * from "@/db/auth-schema";

const createdAt = () =>
	timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = () =>
	timestamp("updated_at", { withTimezone: true })
		.defaultNow()
		.$onUpdate(() => new Date())
		.notNull();

export const tenants = pgTable("tenants", {
	id: uuid("id").primaryKey().defaultRandom(),
	name: text("name").notNull(),
	inviteCode: text("invite_code").notNull().unique(),
	createdAt: createdAt(),
});

const tenantId = () =>
	uuid("tenant_id")
		.notNull()
		.references(() => tenants.id, { onDelete: "cascade" });

export const members = pgTable("members", {
	id: uuid("id").primaryKey().defaultRandom(),
	tenantId: tenantId(),
	userId: text("user_id")
		.notNull()
		.unique()
		.references(() => user.id),
	role: text("role", { enum: MEMBER_ROLES }).notNull(),
	createdAt: createdAt(),
});

export const principals = pgTable(
	"principals",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		tenantId: tenantId(),
		kind: text("kind", { enum: PRINCIPAL_KINDS }).notNull(),
		userId: text("user_id").references(() => user.id),
		ownerId: uuid("owner_id").references((): PgColumn => principals.id),
		handle: text("handle").notNull(),
		displayName: text("display_name").notNull(),
		/** 仅人有意义；代理行保持默认值。 */
		status: text("status", { enum: PRINCIPAL_STATUSES })
			.notNull()
			.default("available"),
		createdAt: createdAt(),
	},
	(t) => [
		unique("principals_tenant_handle_unique").on(t.tenantId, t.handle),
		check(
			"principals_kind_identity_check",
			sql`(${t.kind} = 'human' and ${t.userId} is not null and ${t.ownerId} is null)
				or (${t.kind} = 'agent' and ${t.userId} is null and ${t.ownerId} is not null)`,
		),
		index("principals_owner_idx").on(t.ownerId),
	],
);

export const runners = pgTable(
	"runners",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		tenantId: tenantId(),
		ownerId: uuid("owner_id")
			.notNull()
			.references(() => principals.id),
		name: text("name").notNull(),
		os: text("os").notNull(),
		tokenHash: text("token_hash").notNull().unique(),
		capabilities: jsonb("capabilities").notNull().default([]),
		workspace: text("workspace"),
		status: text("status", { enum: RUNNER_STATUSES })
			.notNull()
			.default("offline"),
		lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
		createdAt: createdAt(),
	},
	(t) => [index("runners_owner_idx").on(t.ownerId)],
);

export const agents = pgTable(
	"agents",
	{
		principalId: uuid("principal_id")
			.primaryKey()
			.references(() => principals.id),
		tenantId: tenantId(),
		role: text("role", { enum: AGENT_ROLES }).notNull(),
		description: text("description").notNull().default(""),
		delegationPolicy: text("delegation_policy").notNull().default(""),
		model: text("model").notNull().default(DEFAULT_AGENT_MODEL),
		runnerId: uuid("runner_id").references(() => runners.id),
		/** builtin：orgos 的运行循环；acp：经设备 Runner 以 ACP 接入的外部 agent。 */
		engine: text("engine", { enum: AGENT_ENGINES })
			.notNull()
			.default("builtin"),
		/** 外部助手的适配器（ACP_ADAPTERS 的 id）与设备上的工作目录。 */
		adapter: text("adapter"),
		workspace: text("workspace"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [
		check(
			"agents_acp_binding_check",
			sql`${t.engine} <> 'acp' or (${t.runnerId} is not null and ${t.adapter} is not null and ${t.workspace} is not null)`,
		),
	],
);

export const conversations = pgTable(
	"conversations",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		tenantId: tenantId(),
		kind: text("kind", { enum: CONVERSATION_KINDS }).notNull(),
		title: text("title"),
		createdBy: uuid("created_by")
			.notNull()
			.references(() => principals.id),
		negotiation: jsonb("negotiation"),
		createdAt: createdAt(),
		lastSeq: integer("last_seq").notNull().default(0),
	},
	(t) => [index("conversations_tenant_idx").on(t.tenantId)],
);

export const conversationMembers = pgTable(
	"conversation_members",
	{
		conversationId: uuid("conversation_id")
			.notNull()
			.references(() => conversations.id),
		principalId: uuid("principal_id")
			.notNull()
			.references(() => principals.id),
		tenantId: tenantId(),
		role: text("role", { enum: CONVERSATION_MEMBER_ROLES }).notNull(),
		joinedAt: timestamp("joined_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		lastReadSeq: integer("last_read_seq").notNull().default(0),
	},
	(t) => [
		primaryKey({ columns: [t.conversationId, t.principalId] }),
		index("conversation_members_principal_idx").on(t.principalId),
	],
);

export const events = pgTable(
	"events",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		tenantId: tenantId(),
		conversationId: uuid("conversation_id").references(() => conversations.id),
		/** 事件所在的话题：代理运行只读当前话题的事件。 */
		topicId: uuid("topic_id")
			.notNull()
			.references((): PgColumn => topics.id),
		seq: integer("seq"),
		type: text("type").notNull(),
		actorId: uuid("actor_id")
			.notNull()
			.references(() => principals.id),
		onBehalfOfId: uuid("on_behalf_of_id").references(() => principals.id),
		payload: jsonb("payload").notNull(),
		createdAt: createdAt(),
	},
	(t) => [
		unique("events_conversation_seq_unique").on(t.conversationId, t.seq),
		index("events_topic_idx").on(t.topicId, t.id),
		index("events_actor_created_idx").on(t.actorId, t.createdAt),
	],
);

export const workItems = pgTable(
	"work_items",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		tenantId: tenantId(),
		kind: text("kind", { enum: WORK_ITEM_KINDS }).notNull(),
		title: text("title").notNull(),
		body: text("body").notNull(),
		ownerId: uuid("owner_id")
			.notNull()
			.references(() => principals.id),
		requesterId: uuid("requester_id")
			.notNull()
			.references(() => principals.id),
		status: text("status", { enum: WORK_ITEM_STATUSES })
			.notNull()
			.default("open"),
		conversationId: uuid("conversation_id").references(() => conversations.id),
		sourceEventId: bigint("source_event_id", { mode: "number" }).references(
			() => events.id,
		),
		payload: jsonb("payload").notNull().default({}),
		resolution: jsonb("resolution"),
		dueAt: timestamp("due_at", { withTimezone: true }),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [index("work_items_owner_status_idx").on(t.ownerId, t.status)],
);

export const notes = pgTable(
	"notes",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		tenantId: tenantId(),
		ownerId: uuid("owner_id")
			.notNull()
			.references(() => principals.id),
		authorId: uuid("author_id")
			.notNull()
			.references(() => principals.id),
		title: text("title").notNull(),
		body: text("body").notNull(),
		visibility: text("visibility", { enum: NOTE_VISIBILITIES })
			.notNull()
			.default("private"),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [index("notes_owner_idx").on(t.ownerId)],
);

export const pairingCodes = pgTable("pairing_codes", {
	codeHash: text("code_hash").primaryKey(),
	tenantId: tenantId(),
	ownerId: uuid("owner_id")
		.notNull()
		.references(() => principals.id),
	expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	usedAt: timestamp("used_at", { withTimezone: true }),
});

export const llmRequests = pgTable(
	"llm_requests",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		tenantId: tenantId(),
		agentId: uuid("agent_id")
			.notNull()
			.references(() => principals.id),
		onBehalfOfId: uuid("on_behalf_of_id").references(() => principals.id),
		conversationId: uuid("conversation_id").references(() => conversations.id),
		/** 这次调用属于哪次运行。 */
		runId: uuid("run_id").references((): PgColumn => runs.id),
		provider: text("provider").notNull(),
		model: text("model").notNull(),
		inputTokens: integer("input_tokens"),
		outputTokens: integer("output_tokens"),
		cacheReadTokens: integer("cache_read_tokens"),
		costMicroUsd: bigint("cost_micro_usd", { mode: "number" }),
		durationMs: integer("duration_ms").notNull(),
		httpStatus: integer("http_status").notNull(),
		parseError: boolean("parse_error").notNull().default(false),
		createdAt: createdAt(),
	},
	(t) => [
		index("llm_requests_agent_idx").on(t.agentId),
		index("llm_requests_conversation_idx").on(t.conversationId),
		index("llm_requests_run_idx").on(t.runId),
	],
);

/**
 * 任务：交给某个执行者、有边界的一件事（状态机对齐 A2A）。外部助手的一次会话、
 * 代理之间的一次交办都是任务；聊天里只放任务卡片，过程进 task_logs。
 */
export const tasks = pgTable(
	"tasks",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		tenantId: tenantId(),
		conversationId: uuid("conversation_id")
			.notNull()
			.references(() => conversations.id),
		/** 任务所在的话题（kind=task）：一个任务恰好对应一个话题。 */
		topicId: uuid("topic_id")
			.notNull()
			.references((): PgColumn => topics.id),
		requesterId: uuid("requester_id")
			.notNull()
			.references(() => principals.id),
		assigneeId: uuid("assignee_id")
			.notNull()
			.references(() => principals.id),
		onBehalfOfId: uuid("on_behalf_of_id")
			.notNull()
			.references(() => principals.id),
		title: text("title").notNull(),
		goal: text("goal").notNull(),
		state: text("state", { enum: TASK_STATES }).notNull().default("submitted"),
		engine: text("engine", { enum: AGENT_ENGINES }).notNull(),
		adapter: text("adapter"),
		runnerId: uuid("runner_id").references(() => runners.id),
		workspace: text("workspace"),
		externalSessionId: text("external_session_id"),
		resultSummary: text("result_summary"),
		artifacts: jsonb("artifacts").notNull().default([]),
		costMicroUsd: bigint("cost_micro_usd", { mode: "number" }),
		/** 已分配的最大日志 seq（task_logs.seq 在任务内连续）。 */
		lastLogSeq: integer("last_log_seq").notNull().default(0),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
		endedAt: timestamp("ended_at", { withTimezone: true }),
	},
	(t) => [
		index("tasks_conversation_idx").on(t.conversationId),
		index("tasks_assignee_state_idx").on(t.assigneeId, t.state),
	],
);

/** 过程记录：只追加。任务的过程即其运行的记录。 */
export const taskLogs = pgTable(
	"task_logs",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		tenantId: tenantId(),
		/** 服务于任务的运行记在任务名下（seq 在任务内连续）；否则为空，seq 在运行内连续。 */
		taskId: uuid("task_id").references(() => tasks.id),
		runId: uuid("run_id").references((): PgColumn => runs.id),
		seq: integer("seq").notNull(),
		kind: text("kind", { enum: TASK_LOG_KINDS }).notNull(),
		payload: jsonb("payload").notNull(),
		createdAt: createdAt(),
	},
	(t) => [
		unique("task_logs_task_seq_unique").on(t.taskId, t.seq),
		uniqueIndex("task_logs_run_seq_unique")
			.on(t.runId, t.seq)
			.where(sql`${t.taskId} is null`),
		index("task_logs_run_idx").on(t.runId),
		check(
			"task_logs_owner_check",
			sql`${t.taskId} is not null or ${t.runId} is not null`,
		),
	],
);

/**
 * 话题：会话内一条独立的上下文。每个会话恰好一个主线（建会话时同一事务建立）；
 * 任务 = 带状态的话题（kind=task，taskId 指向当前或最近一次的任务）。
 */
export const topics = pgTable(
	"topics",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		tenantId: tenantId(),
		conversationId: uuid("conversation_id")
			.notNull()
			.references(() => conversations.id),
		title: text("title").notNull(),
		kind: text("kind", { enum: TOPIC_KINDS }).notNull().default("chat"),
		taskId: uuid("task_id").references((): PgColumn => tasks.id),
		isMain: boolean("is_main").notNull().default(false),
		createdBy: uuid("created_by")
			.notNull()
			.references(() => principals.id),
		archivedAt: timestamp("archived_at", { withTimezone: true }),
		/** 转成群聊时：新群主线引用的原话题。 */
		sourceTopicId: uuid("source_topic_id").references(
			(): PgColumn => topics.id,
		),
		/** 已转成群聊：转去的群。 */
		movedToConversationId: uuid("moved_to_conversation_id").references(
			() => conversations.id,
		),
		createdAt: createdAt(),
		lastEventAt: timestamp("last_event_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(t) => [
		uniqueIndex("topics_one_main_per_conversation")
			.on(t.conversationId)
			.where(sql`${t.isMain}`),
		index("topics_conversation_idx").on(t.conversationId, t.lastEventAt),
	],
);

/**
 * 运行记录：代理的每一次运行（内置循环的一次运行、外部 agent 的一轮）一行。
 * 写入只经 `@/services/runs`。
 */
export const runs = pgTable(
	"runs",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		tenantId: tenantId(),
		agentId: uuid("agent_id")
			.notNull()
			.references(() => principals.id),
		conversationId: uuid("conversation_id")
			.notNull()
			.references(() => conversations.id),
		topicId: uuid("topic_id")
			.notNull()
			.references(() => topics.id),
		taskId: uuid("task_id").references(() => tasks.id),
		trigger: text("trigger").notNull(),
		actingForId: uuid("acting_for_id")
			.notNull()
			.references(() => principals.id),
		engine: text("engine", { enum: AGENT_ENGINES }).notNull(),
		state: text("state", { enum: RUN_STATES }).notNull().default("running"),
		startedAt: timestamp("started_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		endedAt: timestamp("ended_at", { withTimezone: true }),
		summary: text("summary"),
		externalSessionId: text("external_session_id"),
		/** 不服务于任务的运行：已分配的最大日志 seq。 */
		lastLogSeq: integer("last_log_seq").notNull().default(0),
	},
	(t) => [
		index("runs_agent_idx").on(t.agentId, t.startedAt),
		index("runs_topic_idx").on(t.topicId, t.startedAt),
	],
);

/** 压缩检查点：某代理在某话题里，afterEventId 及之前的事件由 summary 代替。 */
export const compactions = pgTable(
	"compactions",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		tenantId: tenantId(),
		topicId: uuid("topic_id")
			.notNull()
			.references(() => topics.id),
		agentId: uuid("agent_id")
			.notNull()
			.references(() => principals.id),
		summary: text("summary").notNull(),
		afterEventId: bigint("after_event_id", { mode: "number" })
			.notNull()
			.references(() => events.id),
		createdAt: createdAt(),
	},
	(t) => [index("compactions_topic_agent_idx").on(t.topicId, t.agentId)],
);

/** 租户级设置：每租户至多一行，没有行即全部取默认值。 */
export const tenantSettings = pgTable("tenant_settings", {
	tenantId: uuid("tenant_id")
		.primaryKey()
		.references(() => tenants.id, { onDelete: "cascade" }),
	allowUnsupervisedAdapters: boolean("allow_unsupervised_adapters")
		.notNull()
		.default(false),
	updatedAt: updatedAt(),
});
