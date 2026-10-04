CREATE TABLE "run_node_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"tenant_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL,
	"node_id" text NOT NULL,
	"steps" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"credentials_issued" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"handover" jsonb,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "secret_refs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "run_node_sessions" ADD CONSTRAINT "run_node_sessions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_node_sessions_node_uq" ON "run_node_sessions" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "run_node_sessions_run_idx" ON "run_node_sessions" USING btree ("run_id");
--> statement-breakpoint
-- The default tenant keeps today's behaviour (every configured secret is reachable); every other
-- tenant starts with an empty allowlist, i.e. the credential broker hands out nothing (fail closed).
UPDATE "tenants" SET "secret_refs" = '["*"]'::jsonb WHERE "id" = '00000000-0000-4000-8000-000000000001';
