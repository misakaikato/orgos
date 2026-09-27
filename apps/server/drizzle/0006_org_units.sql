-- 组织结构：单元（部门）成为一种主体；单元表、成员表；principals 的身份约束改为三分支
-- （human ⇔ userId 非空且 ownerId 空；unit ⇔ 二者皆空；agent ⇔ userId 空且 ownerId 非空）。每条语句都可重复执行。
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "org_units" (
	"principal_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"parent_id" uuid,
	"head_id" uuid NOT NULL,
	"charter" text DEFAULT '' NOT NULL,
	"group_conversation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "unit_memberships" (
	"unit_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"role" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unit_memberships_unit_id_principal_id_pk" PRIMARY KEY("unit_id","principal_id")
);
--> statement-breakpoint
ALTER TABLE "principals" DROP CONSTRAINT IF EXISTS "principals_kind_identity_check";
--> statement-breakpoint
ALTER TABLE "principals" ADD CONSTRAINT "principals_kind_identity_check" CHECK (("principals"."kind" = 'human' and "principals"."user_id" is not null and "principals"."owner_id" is null)
	or ("principals"."kind" = 'unit' and "principals"."user_id" is null and "principals"."owner_id" is null)
	or ("principals"."kind" = 'agent' and "principals"."user_id" is null and "principals"."owner_id" is not null));
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "org_units" ADD CONSTRAINT "org_units_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "org_units" ADD CONSTRAINT "org_units_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "org_units" ADD CONSTRAINT "org_units_parent_id_org_units_principal_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."org_units"("principal_id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "org_units" ADD CONSTRAINT "org_units_head_id_principals_id_fk" FOREIGN KEY ("head_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "org_units" ADD CONSTRAINT "org_units_group_conversation_id_conversations_id_fk" FOREIGN KEY ("group_conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "unit_memberships" ADD CONSTRAINT "unit_memberships_unit_id_org_units_principal_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."org_units"("principal_id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "unit_memberships" ADD CONSTRAINT "unit_memberships_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "unit_memberships" ADD CONSTRAINT "unit_memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_units_parent_idx" ON "org_units" USING btree ("parent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "org_units_group_unique" ON "org_units" USING btree ("group_conversation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "unit_memberships_principal_idx" ON "unit_memberships" USING btree ("principal_id");
