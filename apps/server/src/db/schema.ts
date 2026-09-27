/**
 * 业务表。better-auth 的 user / session / account / verification 在 ./auth-schema.ts（生成物，不手改）。
 *
 * 所有业务表都带 tenant_id（删除租户时级联清理），查询一律经 `@/db/scope` 的 `scoped(tenantId)`。
 * `events` 只追加：代码中不存在更新或删除事件行的路径。
 */
import {
	AGENT_ROLES,
	CONVERSATION_KINDS,
	CONVERSATION_MEMBER_ROLES,
	DEFAULT_AGENT_MODEL,
	MEMBER_ROLES,
	NOTE_VISIBILITIES,
	PRINCIPAL_KINDS,
	PRINCIPAL_STATUSES,
	RUNNER_STATUSES,
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

export const agents = pgTable("agents", {
	principalId: uuid("principal_id")
		.primaryKey()
		.references(() => principals.id),
	tenantId: tenantId(),
	role: text("role", { enum: AGENT_ROLES }).notNull(),
	description: text("description").notNull().default(""),
	delegationPolicy: text("delegation_policy").notNull().default(""),
	model: text("model").notNull().default(DEFAULT_AGENT_MODEL),
	runnerId: uuid("runner_id").references(() => runners.id),
	createdAt: createdAt(),
	updatedAt: updatedAt(),
});

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
		seq: integer("seq"),
		type: text("type").notNull(),
		actorId: uuid("actor_id")
			.notNull()
			.references(() => principals.id),
		onBehalfOfId: uuid("on_behalf_of_id").references(() => principals.id),
		payload: jsonb("payload").notNull(),
		createdAt: createdAt(),
	},
	(t) => [unique("events_conversation_seq_unique").on(t.conversationId, t.seq)],
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
	],
);
