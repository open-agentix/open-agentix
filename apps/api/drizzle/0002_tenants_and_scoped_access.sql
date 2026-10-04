CREATE TABLE "agent_role_bindings" (
	"user_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "agent_role_bindings_user_id_agent_id_role_pk" PRIMARY KEY("user_id","agent_id","role")
);
--> statement-breakpoint
CREATE TABLE "change_checks" (
	"source_id" uuid PRIMARY KEY NOT NULL,
	"digest" text NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"changed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guidelines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid,
	"scope" text NOT NULL,
	"scope_id" uuid,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"content" text NOT NULL,
	"rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"monthly_budget_micros" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "scope" text DEFAULT 'platform' NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "scope_id" uuid;--> statement-breakpoint
ALTER TABLE "cost_ledger" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_ledger" ADD COLUMN "step_seq" integer;--> statement-breakpoint
ALTER TABLE "cost_ledger" ADD COLUMN "use_case" text;--> statement-breakpoint
ALTER TABLE "event_sources" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "policies" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_role_bindings" ADD CONSTRAINT "agent_role_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_role_bindings" ADD CONSTRAINT "agent_role_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_role_bindings_agent_idx" ON "agent_role_bindings" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "guidelines_scope_name_version_uq" ON "guidelines" USING btree ("scope","name","version");--> statement-breakpoint
CREATE INDEX "guidelines_scope_idx" ON "guidelines" USING btree ("scope","scope_id");--> statement-breakpoint
CREATE INDEX "cost_tenant_month_idx" ON "cost_ledger" USING btree ("tenant_id","month");--> statement-breakpoint
CREATE INDEX "cost_use_case_month_idx" ON "cost_ledger" USING btree ("use_case","month");--> statement-breakpoint
CREATE INDEX "runs_tenant_created_idx" ON "runs" USING btree ("tenant_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
INSERT INTO "tenants" ("id", "slug", "name") VALUES ('00000000-0000-4000-8000-000000000001', 'default', 'Default') ON CONFLICT DO NOTHING;
