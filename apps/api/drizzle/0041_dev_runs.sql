-- ADR 0017 slice S5 (#248): personal secrets and development runs of draft revisions.
--
-- * runs: agent_version_id becomes nullable; agent_revision_id, stage ('production' | 'development') and
--   started_by (the user a development run acts as) are new. runs_stage_shape ties them together: a
--   production run has a version and no revision, a development run a revision, a starter and no
--   version. A trigger keeps these four columns immutable, so a run can never change stage.
-- * dev_run_definitions: the definition a development run executes, frozen at admission.
-- * cost_ledger.stage: development spend is counted against the development budget only.
-- * tenants.dev_monthly_budget_micros: the development budget of a node (NULL = 10 % of its cap).
-- Down path: drizzle/down/0041_dev_runs.down.sql
CREATE TABLE "dev_run_definitions" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"definition" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "agent_version_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_ledger" ADD COLUMN "stage" text DEFAULT 'production' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "agent_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "stage" text DEFAULT 'production' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "started_by" uuid;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "dev_monthly_budget_micros" bigint;--> statement-breakpoint
ALTER TABLE "dev_run_definitions" ADD CONSTRAINT "dev_run_definitions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_revision_id_agent_draft_revisions_id_fk" FOREIGN KEY ("agent_revision_id") REFERENCES "public"."agent_draft_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cost_tenant_stage_month_idx" ON "cost_ledger" USING btree ("tenant_id","stage","month");--> statement-breakpoint
CREATE INDEX "runs_dev_started_by_idx" ON "runs" USING btree ("started_by","status") WHERE stage = 'development';--> statement-breakpoint
ALTER TABLE "cost_ledger" ADD CONSTRAINT "cost_ledger_stage_check" CHECK ("cost_ledger"."stage" in ('production', 'development'));--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_stage_shape" CHECK (("runs"."stage" = 'production' and "runs"."agent_version_id" is not null and "runs"."agent_revision_id" is null) or ("runs"."stage" = 'development' and "runs"."agent_revision_id" is not null and "runs"."agent_version_id" is null and "runs"."started_by" is not null));
--> statement-breakpoint
CREATE FUNCTION oax_run_stage_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.stage IS DISTINCT FROM OLD.stage OR NEW.agent_version_id IS DISTINCT FROM OLD.agent_version_id
     OR NEW.agent_revision_id IS DISTINCT FROM OLD.agent_revision_id OR NEW.started_by IS DISTINCT FROM OLD.started_by THEN
    RAISE EXCEPTION 'the stage, the executed version or revision and the starter of a run are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER runs_stage_immutable BEFORE UPDATE ON runs FOR EACH ROW EXECUTE FUNCTION oax_run_stage_immutable();
