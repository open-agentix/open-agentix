-- ADR 0015 / slice S2 (#207): trace identity of a run. Additive: three nullable columns, two shape
-- checks and an immutability trigger; no backfill (runs created before this migration keep NULL and
-- have no trace). Down path: drizzle/down/0020_run_trace_identity.down.sql
-- * runs.trace_id / runs.trace_root_span_id: random ids written once when the run row is created.
--   Both or neither, W3C shape, not all zero. Not unique and not indexed on purpose: the ids are
--   looked up through the run id, never the other way round.
-- * run_node_sessions.trace_context: reserved for slice S4 (traceparent of the dispatching span).
-- * runs_trace_identity_immutable: the ids never change once the row exists, whatever code path
--   updates the row (an older application version, psql).
ALTER TABLE "run_node_sessions" ADD COLUMN "trace_context" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "trace_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "trace_root_span_id" text;--> statement-breakpoint
ALTER TABLE "run_node_sessions" ADD CONSTRAINT "run_node_sessions_trace_context_shape" CHECK ("run_node_sessions"."trace_context" is null or "run_node_sessions"."trace_context" ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$');--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_trace_ids_shape" CHECK (("runs"."trace_id" is null) = ("runs"."trace_root_span_id" is null) and ("runs"."trace_id" is null or ("runs"."trace_id" ~ '^[0-9a-f]{32}$' and "runs"."trace_id" <> repeat('0', 32) and "runs"."trace_root_span_id" ~ '^[0-9a-f]{16}$' and "runs"."trace_root_span_id" <> repeat('0', 16))))--> statement-breakpoint
CREATE OR REPLACE FUNCTION "runs_trace_identity_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."trace_id" IS DISTINCT FROM OLD."trace_id"
		OR NEW."trace_root_span_id" IS DISTINCT FROM OLD."trace_root_span_id" THEN
		RAISE EXCEPTION 'runs.trace_id and runs.trace_root_span_id are immutable' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "runs_trace_identity_immutable_trg" ON "runs";--> statement-breakpoint
CREATE TRIGGER "runs_trace_identity_immutable_trg" BEFORE UPDATE OF "trace_id", "trace_root_span_id" ON "runs"
	FOR EACH ROW EXECUTE FUNCTION "runs_trace_identity_immutable"();
