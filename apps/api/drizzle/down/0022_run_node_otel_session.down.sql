-- Reverts 0022_run_node_otel_session.sql (ADR 0015 slice S4, #209).
-- Not part of the drizzle journal: run it by hand (psql) after rolling the application back, then
-- delete the row of migration 0022 from drizzle.__drizzle_migrations.
-- Loses only the not yet emitted node events of sessions that are still running; sessions that
-- already ended have been turned into spans (or dropped) and keep nothing here.
BEGIN;
ALTER TABLE "run_node_sessions" DROP CONSTRAINT IF EXISTS "run_node_sessions_otel_session_shape";
ALTER TABLE "run_node_sessions" DROP COLUMN IF EXISTS "otel_session";
COMMIT;
