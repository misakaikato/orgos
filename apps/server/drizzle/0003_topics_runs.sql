-- 会话内话题、运行记录、压缩检查点、租户设置。每条语句都可重复执行。
CREATE TABLE IF NOT EXISTS "compactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"topic_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"after_event_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"topic_id" uuid NOT NULL,
	"task_id" uuid,
	"trigger" text NOT NULL,
	"acting_for_id" uuid NOT NULL,
	"engine" text NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"summary" text,
	"external_session_id" text,
	"last_log_seq" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"allow_unsupervised_adapters" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"title" text NOT NULL,
	"kind" text DEFAULT 'chat' NOT NULL,
	"task_id" uuid,
	"is_main" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"archived_at" timestamp with time zone,
	"source_topic_id" uuid,
	"moved_to_conversation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_event_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_logs" ALTER COLUMN "task_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "topic_id" uuid;
--> statement-breakpoint
ALTER TABLE "llm_requests" ADD COLUMN IF NOT EXISTS "run_id" uuid;
--> statement-breakpoint
ALTER TABLE "task_logs" ADD COLUMN IF NOT EXISTS "run_id" uuid;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "topic_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "compactions" ADD CONSTRAINT "compactions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "compactions" ADD CONSTRAINT "compactions_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "compactions" ADD CONSTRAINT "compactions_agent_id_principals_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "compactions" ADD CONSTRAINT "compactions_after_event_id_events_id_fk" FOREIGN KEY ("after_event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "runs" ADD CONSTRAINT "runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_id_principals_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "runs" ADD CONSTRAINT "runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "runs" ADD CONSTRAINT "runs_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "runs" ADD CONSTRAINT "runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "runs" ADD CONSTRAINT "runs_acting_for_id_principals_id_fk" FOREIGN KEY ("acting_for_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "topics" ADD CONSTRAINT "topics_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "topics" ADD CONSTRAINT "topics_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "topics" ADD CONSTRAINT "topics_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "topics" ADD CONSTRAINT "topics_created_by_principals_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "topics" ADD CONSTRAINT "topics_source_topic_id_topics_id_fk" FOREIGN KEY ("source_topic_id") REFERENCES "public"."topics"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "topics" ADD CONSTRAINT "topics_moved_to_conversation_id_conversations_id_fk" FOREIGN KEY ("moved_to_conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "events" ADD CONSTRAINT "events_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "llm_requests" ADD CONSTRAINT "llm_requests_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "task_logs" ADD CONSTRAINT "task_logs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tasks" ADD CONSTRAINT "tasks_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "task_logs" ADD CONSTRAINT "task_logs_owner_check" CHECK ("task_logs"."task_id" is not null or "task_logs"."run_id" is not null);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "compactions_topic_agent_idx" ON "compactions" USING btree ("topic_id","agent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runs_agent_idx" ON "runs" USING btree ("agent_id","started_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runs_topic_idx" ON "runs" USING btree ("topic_id","started_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "topics_one_main_per_conversation" ON "topics" USING btree ("conversation_id") WHERE "topics"."is_main";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "topics_conversation_idx" ON "topics" USING btree ("conversation_id","last_event_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_topic_idx" ON "events" USING btree ("topic_id","id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_actor_created_idx" ON "events" USING btree ("actor_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_requests_run_idx" ON "llm_requests" USING btree ("run_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "task_logs_run_seq_unique" ON "task_logs" USING btree ("run_id","seq") WHERE "task_logs"."task_id" is null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_logs_run_idx" ON "task_logs" USING btree ("run_id");
--> statement-breakpoint
-- 每个会话恰好一个主线话题。
INSERT INTO "topics" ("tenant_id", "conversation_id", "title", "kind", "is_main", "created_by", "created_at", "last_event_at")
SELECT c."tenant_id", c."id", '主线', 'chat', true, c."created_by", c."created_at",
	coalesce((SELECT max(e."created_at") FROM "events" AS e WHERE e."conversation_id" = c."id"), c."created_at")
FROM "conversations" AS c
WHERE NOT EXISTS (
	SELECT 1 FROM "topics" AS t WHERE t."conversation_id" = c."id" AND t."is_main"
);
--> statement-breakpoint
-- 已有的任务各成一个任务话题（留在原会话里）。
INSERT INTO "topics" ("tenant_id", "conversation_id", "title", "kind", "task_id", "is_main", "created_by", "created_at", "last_event_at")
SELECT k."tenant_id", k."conversation_id", k."title", 'task', k."id", false, k."requester_id", k."created_at", k."updated_at"
FROM "tasks" AS k
WHERE k."topic_id" IS NULL
	AND NOT EXISTS (SELECT 1 FROM "topics" AS t WHERE t."task_id" = k."id" AND t."kind" = 'task');
--> statement-breakpoint
UPDATE "tasks" AS k
SET "topic_id" = t."id"
FROM "topics" AS t
WHERE k."topic_id" IS NULL AND t."task_id" = k."id" AND t."kind" = 'task';
--> statement-breakpoint
-- 历史事件：任务卡片与外部助手的权限审批归入任务话题，其余归入主线。
UPDATE "events" AS e
SET "topic_id" = k."topic_id"
FROM "tasks" AS k
WHERE e."topic_id" IS NULL
	AND e."type" IN ('task.created', 'task.updated', 'task.ended', 'approval.requested')
	AND e."payload"->>'taskId' = k."id"::text
	AND k."conversation_id" = e."conversation_id";
--> statement-breakpoint
UPDATE "events" AS e
SET "topic_id" = r."topic_id"
FROM "events" AS r
WHERE e."topic_id" IS NULL
	AND e."type" = 'approval.resolved'
	AND r."type" = 'approval.requested'
	AND r."topic_id" IS NOT NULL
	AND r."conversation_id" = e."conversation_id"
	AND r."payload"->>'workItemId' = e."payload"->>'workItemId';
--> statement-breakpoint
UPDATE "events" AS e
SET "topic_id" = t."id"
FROM "topics" AS t
WHERE e."topic_id" IS NULL AND t."conversation_id" = e."conversation_id" AND t."is_main";
--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "topic_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "topic_id" SET NOT NULL;
--> statement-breakpoint
-- 群聊：每位成员的分身随本人在群里。
INSERT INTO "conversation_members" ("conversation_id", "principal_id", "tenant_id", "role", "joined_at")
SELECT c."id", twin."id", c."tenant_id", 'member', m."joined_at"
FROM "conversations" AS c
JOIN "conversation_members" AS m ON m."conversation_id" = c."id" AND m."role" = 'member'
JOIN "principals" AS h ON h."id" = m."principal_id" AND h."kind" = 'human'
JOIN "principals" AS twin ON twin."owner_id" = h."id" AND twin."kind" = 'agent'
JOIN "agents" AS a ON a."principal_id" = twin."id" AND a."role" = 'front'
WHERE c."kind" = 'group'
ON CONFLICT ("conversation_id", "principal_id") DO NOTHING;
