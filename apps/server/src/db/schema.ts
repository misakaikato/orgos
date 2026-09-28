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
	EXTERNAL_AGENT_MODES,
	GATEWAY_PROTOCOLS,
	GROUP_ROUTINGS,
	MEMBER_ROLES,
	MEMORY_CATEGORIES,
	MEMORY_JOB_STATUSES,
	MEMORY_JOB_TRIGGERS,
	MEMORY_KINDS,
	MEMORY_STATUSES,
	type MemoryEntity,
	type MemoryScope,
	type MemorySource,
	NOTE_VISIBILITIES,
	PRINCIPAL_KINDS,
	PRINCIPAL_STATUSES,
	type ProviderEndpoints,
	RUN_STATES,
	RUNNER_STATUSES,
	RUNNER_VIAS,
	TASK_LOG_KINDS,
	TASK_STATES,
	TOPIC_KINDS,
	UNIT_MEMBER_ROLES,
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
	real,
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
				or (${t.kind} = 'unit' and ${t.userId} is null and ${t.ownerId} is null)
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
		/** 来源：desktop（桌面客户端内置）或 cli（命令行）；较早配对的为空。 */
		via: text("via", { enum: RUNNER_VIAS }),
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
		/** 为空：系统运行（记忆提炼、画像整理）的调用。 */
		agentId: uuid("agent_id").references(() => principals.id),
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
		/** 服务于哪个任务（外部 agent 的任务令牌、或内置运行所服务的任务）。 */
		taskId: uuid("task_id").references((): PgColumn => tasks.id),
		/** 调用方说的协议与发给上游的协议（相同即直通）。 */
		protocolIn: text("protocol_in", { enum: GATEWAY_PROTOCOLS }).notNull(),
		protocolOut: text("protocol_out", { enum: GATEWAY_PROTOCOLS }).notNull(),
		/** 经路由组时：哪个组（一次请求内的每次切换各一行）。 */
		groupId: uuid("group_id"),
		createdAt: createdAt(),
	},
	(t) => [
		index("llm_requests_agent_idx").on(t.agentId),
		index("llm_requests_task_idx").on(t.taskId),
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
		/** 为空：系统运行（记忆提炼、画像整理），模型调用计量挂在它名下。 */
		agentId: uuid("agent_id").references(() => principals.id),
		/** 代理运行必有；系统运行在话题上提炼时有，整理画像时为空。 */
		conversationId: uuid("conversation_id").references(() => conversations.id),
		topicId: uuid("topic_id").references(() => topics.id),
		taskId: uuid("task_id").references(() => tasks.id),
		trigger: text("trigger").notNull(),
		/** 为谁办；系统运行为空。 */
		actingForId: uuid("acting_for_id").references(() => principals.id),
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
	defaultModel: text("default_model").notNull().default(DEFAULT_AGENT_MODEL),
	externalAgentMode: text("external_agent_mode", { enum: EXTERNAL_AGENT_MODES })
		.notNull()
		.default("enterprise"),
	allowPersonalExternal: boolean("allow_personal_external")
		.notNull()
		.default(false),
	updatedAt: updatedAt(),
});

/**
 * 模型厂商：本租户的一家上游。key 以 AES-256-GCM 加密存放（`@/gateway/secret`），接口与日志永不回显明文；
 * 本机推理服务可以没有 key。name 用在模型引用 `name/model` 里，建好后不改。
 */
export const modelProviders = pgTable(
	"model_providers",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		tenantId: tenantId(),
		name: text("name").notNull(),
		preset: text("preset"),
		endpoints: jsonb("endpoints").$type<ProviderEndpoints>().notNull(),
		keyCiphertext: text("key_ciphertext"),
		exposedModels: text("exposed_models")
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [unique("model_providers_tenant_name_unique").on(t.tenantId, t.name)],
);

/** 路由组：一组 `厂商/模型`，order 依次尝试、rotate 每次轮换。 */
export const modelGroups = pgTable("model_groups", {
	id: uuid("id").primaryKey().defaultRandom(),
	tenantId: tenantId(),
	name: text("name").notNull(),
	members: text("members").array().notNull(),
	routing: text("routing", { enum: GROUP_ROUTINGS }).notNull(),
	createdAt: createdAt(),
});

/**
 * 任务令牌：外部 agent 在企业模式下调用网关的唯一凭据。库里只存哈希；绑定租户、代理（及其本人）、
 * 该话题的外部会话。外部会话关闭时吊销；话题里任务的开始与结束不影响它。
 */
export const gatewayTokens = pgTable(
	"gateway_tokens",
	{
		tokenHash: text("token_hash").primaryKey(),
		tenantId: tenantId(),
		agentId: uuid("agent_id")
			.notNull()
			.references(() => principals.id),
		onBehalfOfId: uuid("on_behalf_of_id")
			.notNull()
			.references(() => principals.id),
		conversationId: uuid("conversation_id")
			.notNull()
			.references(() => conversations.id),
		topicId: uuid("topic_id")
			.notNull()
			.references(() => topics.id),
		runnerId: uuid("runner_id")
			.notNull()
			.references(() => runners.id),
		createdAt: createdAt(),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
	},
	(t) => [index("gateway_tokens_topic_idx").on(t.topicId)],
);

// ─────────────────────────── 记忆层 ───────────────────────────

/**
 * 记忆条目（第 1 层）：从会话、任务、答复里提炼出的陈述句，带出处与可见范围。
 * 不删除：被取代时 status=superseded 并链到新条目，本人撤回时 status=retracted。
 */
export const memoryItems = pgTable(
	"memory_items",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		tenantId: tenantId(),
		/** 这条记忆关于谁。 */
		subjectId: uuid("subject_id")
			.notNull()
			.references(() => principals.id),
		kind: text("kind", { enum: MEMORY_KINDS }).notNull(),
		content: text("content").notNull(),
		category: text("category", { enum: MEMORY_CATEGORIES }).notNull(),
		entities: jsonb("entities").$type<MemoryEntity[]>().notNull().default([]),
		scope: jsonb("scope").$type<MemoryScope>().notNull(),
		sources: jsonb("sources").$type<MemorySource[]>().notNull().default([]),
		confidence: real("confidence").notNull().default(0.8),
		status: text("status", { enum: MEMORY_STATUSES })
			.notNull()
			.default("active"),
		supersededById: uuid("superseded_by_id").references(
			(): PgColumn => memoryItems.id,
		),
		ownerCorrected: boolean("owner_corrected").notNull().default(false),
		createdByRunId: uuid("created_by_run_id").references(() => runs.id),
		/** 预留给向量检索（本期不建索引、不写入）。 */
		embedding: real("embedding").array(),
		validFrom: timestamp("valid_from", { withTimezone: true })
			.defaultNow()
			.notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [
		index("memory_items_subject_idx").on(t.subjectId, t.status),
		index("memory_items_tenant_status_idx").on(t.tenantId, t.status),
	],
);

/** 画像的一段：由哪些条目整理而来（检索时只拼接对方看得到全部条目的段落）。 */
export type MemoryProfileSection = {
	heading: string;
	text: string;
	itemIds: string[];
};

/** 画像（第 2 层）：按人的"当前状态"页，按段记录来源条目。 */
export const memoryProfiles = pgTable(
	"memory_profiles",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		tenantId: tenantId(),
		subjectId: uuid("subject_id")
			.notNull()
			.references(() => principals.id),
		subjectKind: text("subject_kind", { enum: ["person", "project"] })
			.notNull()
			.default("person"),
		projectKey: text("project_key"),
		content: text("content").notNull(),
		itemIds: uuid("item_ids").array().notNull(),
		sections: jsonb("sections")
			.$type<MemoryProfileSection[]>()
			.notNull()
			.default([]),
		builtAt: timestamp("built_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(t) => [
		uniqueIndex("memory_profiles_person_unique")
			.on(t.subjectId)
			.where(sql`${t.subjectKind} = 'person'`),
	],
);

/**
 * 提炼作业：后台执行器按 runAfter 拉取，单租户串行、可重试。
 * 话题的提炼进度 = 该话题已完成作业的最大 throughEventId。
 */
export const memoryJobs = pgTable(
	"memory_jobs",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		tenantId: tenantId(),
		topicId: uuid("topic_id")
			.notNull()
			.references(() => topics.id),
		trigger: text("trigger", { enum: MEMORY_JOB_TRIGGERS }).notNull(),
		status: text("status", { enum: MEMORY_JOB_STATUSES })
			.notNull()
			.default("pending"),
		runAfter: timestamp("run_after", { withTimezone: true })
			.defaultNow()
			.notNull(),
		attempts: integer("attempts").notNull().default(0),
		error: text("error"),
		/** resolution：写 decision 条目所依据的事件（答复或协商结束）。 */
		eventId: bigint("event_id", { mode: "number" }).references(() => events.id),
		/** 本作业提炼到的最后一条事件。 */
		throughEventId: bigint("through_event_id", { mode: "number" }),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [
		index("memory_jobs_due_idx").on(t.status, t.runAfter),
		index("memory_jobs_topic_idx").on(t.topicId, t.status),
	],
);

/** 本人的类别授权：没有行即取默认值（前八类可对外，后六类禁止）。 */
export const disclosureRules = pgTable(
	"disclosure_rules",
	{
		tenantId: tenantId(),
		ownerId: uuid("owner_id")
			.notNull()
			.references(() => principals.id),
		category: text("category", { enum: MEMORY_CATEGORIES }).notNull(),
		allowed: boolean("allowed").notNull(),
	},
	(t) => [primaryKey({ columns: [t.ownerId, t.category] })],
);

// ─────────────────────────── 组织结构 ───────────────────────────

/**
 * 组织单元（部门）：principals.kind='unit' 的扩展行。负责人（headId）是唯一的决策人，
 * 其成员行的 role 恒为 head（经 `@/services/org` 同步）。建单元时同一事务建它的分身与单元群。
 */
export const orgUnits = pgTable(
	"org_units",
	{
		principalId: uuid("principal_id")
			.primaryKey()
			.references(() => principals.id),
		tenantId: tenantId(),
		parentId: uuid("parent_id").references(
			(): PgColumn => orgUnits.principalId,
		),
		headId: uuid("head_id")
			.notNull()
			.references(() => principals.id),
		/** 章程：负责人写给单元分身的对外政策（自然语言）。 */
		charter: text("charter").notNull().default(""),
		/** 单元群：成员随单元成员变动。 */
		groupConversationId: uuid("group_conversation_id").references(
			() => conversations.id,
		),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [
		index("org_units_parent_idx").on(t.parentId),
		uniqueIndex("org_units_group_unique").on(t.groupConversationId),
	],
);

export const unitMemberships = pgTable(
	"unit_memberships",
	{
		unitId: uuid("unit_id")
			.notNull()
			.references(() => orgUnits.principalId),
		principalId: uuid("principal_id")
			.notNull()
			.references(() => principals.id),
		tenantId: tenantId(),
		role: text("role", { enum: UNIT_MEMBER_ROLES }).notNull(),
		isPrimary: boolean("is_primary").notNull().default(false),
		createdAt: createdAt(),
	},
	(t) => [
		primaryKey({ columns: [t.unitId, t.principalId] }),
		index("unit_memberships_principal_idx").on(t.principalId),
	],
);
