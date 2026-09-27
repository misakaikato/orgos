-- 任务与外部助手：tasks / task_logs（只追加），代理增加 engine / adapter / workspace。
CREATE TABLE "task_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_logs_task_seq_unique" UNIQUE("task_id","seq")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"requester_id" uuid NOT NULL,
	"assignee_id" uuid NOT NULL,
	"on_behalf_of_id" uuid NOT NULL,
	"title" text NOT NULL,
	"goal" text NOT NULL,
	"state" text DEFAULT 'submitted' NOT NULL,
	"engine" text NOT NULL,
	"adapter" text,
	"runner_id" uuid,
	"workspace" text,
	"external_session_id" text,
	"result_summary" text,
	"artifacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cost_micro_usd" bigint,
	"last_log_seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "engine" text DEFAULT 'builtin' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "adapter" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "workspace" text;--> statement-breakpoint
ALTER TABLE "task_logs" ADD CONSTRAINT "task_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_logs" ADD CONSTRAINT "task_logs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_requester_id_principals_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_principals_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_on_behalf_of_id_principals_id_fk" FOREIGN KEY ("on_behalf_of_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_conversation_idx" ON "tasks" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "tasks_assignee_state_idx" ON "tasks" USING btree ("assignee_id","state");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_acp_binding_check" CHECK ("agents"."engine" <> 'acp' or ("agents"."runner_id" is not null and "agents"."adapter" is not null and "agents"."workspace" is not null));