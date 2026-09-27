-- 企业模型网关：厂商与路由组、任务令牌、租户默认模型与外部助手模式、按任务与协议计量。每条语句都可重复执行。
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gateway_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"on_behalf_of_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"topic_id" uuid NOT NULL,
	"runner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"members" text[] NOT NULL,
	"routing" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"preset" text,
	"endpoints" jsonb NOT NULL,
	"key_ciphertext" text,
	"exposed_models" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_providers_tenant_name_unique" UNIQUE("tenant_id","name")
);
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "model" SET DEFAULT 'deepseek/deepseek-v4-flash';
--> statement-breakpoint
ALTER TABLE "llm_requests" ADD COLUMN IF NOT EXISTS "task_id" uuid;
--> statement-breakpoint
ALTER TABLE "llm_requests" ADD COLUMN IF NOT EXISTS "protocol_in" text NOT NULL DEFAULT 'openai';
--> statement-breakpoint
ALTER TABLE "llm_requests" ALTER COLUMN "protocol_in" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "llm_requests" ADD COLUMN IF NOT EXISTS "protocol_out" text NOT NULL DEFAULT 'openai';
--> statement-breakpoint
ALTER TABLE "llm_requests" ALTER COLUMN "protocol_out" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "llm_requests" ADD COLUMN IF NOT EXISTS "group_id" uuid;
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN IF NOT EXISTS "default_model" text DEFAULT 'deepseek/deepseek-v4-flash' NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN IF NOT EXISTS "external_agent_mode" text DEFAULT 'enterprise' NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN IF NOT EXISTS "allow_personal_external" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "gateway_tokens" ADD CONSTRAINT "gateway_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "gateway_tokens" ADD CONSTRAINT "gateway_tokens_agent_id_principals_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "gateway_tokens" ADD CONSTRAINT "gateway_tokens_on_behalf_of_id_principals_id_fk" FOREIGN KEY ("on_behalf_of_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "gateway_tokens" ADD CONSTRAINT "gateway_tokens_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "gateway_tokens" ADD CONSTRAINT "gateway_tokens_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "gateway_tokens" ADD CONSTRAINT "gateway_tokens_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "model_groups" ADD CONSTRAINT "model_groups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "model_providers" ADD CONSTRAINT "model_providers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gateway_tokens_topic_idx" ON "gateway_tokens" USING btree ("topic_id");
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "llm_requests" ADD CONSTRAINT "llm_requests_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_requests_task_idx" ON "llm_requests" USING btree ("task_id");
--> statement-breakpoint
-- 代理的模型统一为模型引用（厂商/模型）：此前只接 DeepSeek，裸模型 id 即 DeepSeek 的模型。
UPDATE "agents" SET "model" = 'deepseek/' || "model" WHERE position('/' in "model") = 0;
