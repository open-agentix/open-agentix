CREATE TABLE "model_reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL,
	"run_id" uuid NOT NULL,
	"session_id" uuid,
	"agent_id" text NOT NULL,
	"team_id" uuid,
	"use_case" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"reserved_micros" bigint NOT NULL,
	"reserved_input_tokens" integer NOT NULL,
	"reserved_output_tokens" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"actual_micros" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "model_reservations_status" CHECK ("model_reservations"."status" in ('active', 'settled', 'expired')),
	CONSTRAINT "model_reservations_nonneg" CHECK ("model_reservations"."reserved_micros" >= 0 and "model_reservations"."reserved_input_tokens" >= 0 and "model_reservations"."reserved_output_tokens" >= 0 and ("model_reservations"."actual_micros" is null or "model_reservations"."actual_micros" >= 0))
);
--> statement-breakpoint
ALTER TABLE "cost_ledger" ADD COLUMN "usage_source" text DEFAULT 'provider' NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_ledger" ADD COLUMN "cache_read_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_ledger" ADD COLUMN "cache_write_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_ledger" ADD COLUMN "reservation_id" uuid;--> statement-breakpoint
ALTER TABLE "cost_ledger" ADD COLUMN "via" text DEFAULT 'in-process' NOT NULL;--> statement-breakpoint
ALTER TABLE "run_node_sessions" ADD COLUMN "model_token_jti" text;--> statement-breakpoint
ALTER TABLE "model_reservations" ADD CONSTRAINT "model_reservations_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_reservations_tenant_status_idx" ON "model_reservations" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "model_reservations_run_status_idx" ON "model_reservations" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "model_reservations_active_expiry_idx" ON "model_reservations" USING btree ("expires_at") WHERE status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "cost_ledger_reservation_uq" ON "cost_ledger" USING btree ("reservation_id") WHERE reservation_id is not null;--> statement-breakpoint
ALTER TABLE "cost_ledger" ADD CONSTRAINT "cost_ledger_cost_nonneg" CHECK ("cost_ledger"."cost_micros" >= 0);