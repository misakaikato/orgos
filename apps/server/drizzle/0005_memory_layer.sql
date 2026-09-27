-- 记忆层：记忆条目、画像、提炼作业、本人的类别授权；系统运行（记忆提炼、画像整理）的运行记录与模型调用不挂代理。每条语句都可重复执行。
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "disclosure_rules" (
	"tenant_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"category" text NOT NULL,
	"allowed" boolean NOT NULL,
	CONSTRAINT "disclosure_rules_owner_id_category_pk" PRIMARY KEY("owner_id","category")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"category" text NOT NULL,
	"entities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scope" jsonb NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" real DEFAULT 0.8 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"superseded_by_id" uuid,
	"owner_corrected" boolean DEFAULT false NOT NULL,
	"created_by_run_id" uuid,
	"embedding" real[],
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"topic_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"event_id" bigint,
	"through_event_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"subject_kind" text DEFAULT 'person' NOT NULL,
	"project_key" text,
	"content" text NOT NULL,
	"item_ids" uuid[] NOT NULL,
	"sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_requests" ALTER COLUMN "agent_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "agent_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "conversation_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "topic_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "acting_for_id" DROP NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "disclosure_rules" ADD CONSTRAINT "disclosure_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "disclosure_rules" ADD CONSTRAINT "disclosure_rules_owner_id_principals_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_subject_id_principals_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_superseded_by_id_memory_items_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."memory_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_created_by_run_id_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "memory_jobs" ADD CONSTRAINT "memory_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "memory_jobs" ADD CONSTRAINT "memory_jobs_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "memory_jobs" ADD CONSTRAINT "memory_jobs_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "memory_profiles" ADD CONSTRAINT "memory_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "memory_profiles" ADD CONSTRAINT "memory_profiles_subject_id_principals_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_items_subject_idx" ON "memory_items" USING btree ("subject_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_items_tenant_status_idx" ON "memory_items" USING btree ("tenant_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_jobs_due_idx" ON "memory_jobs" USING btree ("status","run_after");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_jobs_topic_idx" ON "memory_jobs" USING btree ("topic_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memory_profiles_person_unique" ON "memory_profiles" USING btree ("subject_id") WHERE "memory_profiles"."subject_kind" = 'person';
