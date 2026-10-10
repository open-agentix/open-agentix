-- Reverts 0020_run_trace_identity.sql (ADR 0015 slice S2, #207).
-- Not part of the drizzle journal: run it by hand (psql) after rolling the application back, then
-- delete the row of migration 0020 from drizzle.__drizzle_migrations.
-- Loses only the trace identity of runs (their trace ids): audit entries keep payload.otel, which is
-- part of their hashed payload, so the chain stays valid. Export the ids first if they are needed:
--   SELECT id, trace_id, trace_root_span_id FROM runs WHERE trace_id IS NOT NULL;
BEGIN;
DROP TRIGGER IF EXISTS "runs_trace_identity_immutable_trg" ON "runs";
DROP FUNCTION IF EXISTS "runs_trace_identity_immutable"();
ALTER TABLE "runs" DROP CONSTRAINT IF EXISTS "runs_trace_ids_shape";
ALTER TABLE "run_node_sessions" DROP CONSTRAINT IF EXISTS "run_node_sessions_trace_context_shape";
ALTER TABLE "runs" DROP COLUMN IF EXISTS "trace_root_span_id";
ALTER TABLE "runs" DROP COLUMN IF EXISTS "trace_id";
ALTER TABLE "run_node_sessions" DROP COLUMN IF EXISTS "trace_context";
COMMIT;
