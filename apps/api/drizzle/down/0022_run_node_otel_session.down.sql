-- Reverts 0022_run_node_otel_session.sql (ADR 0015 slice S4, #209).
-- Not part of the drizzle journal: run it by hand (psql) after rolling the application back, then
-- delete the row of migration 0022 from drizzle.__drizzle_migrations.
-- Drops the telemetry state of every session: the kept node events and the dropped counter. The
-- spans of sessions that already ended were emitted at their end and are not affected; events of
-- sessions that are still running are lost (their span would have no events). Nothing else reads
-- the column.
BEGIN;
ALTER TABLE "run_node_sessions" DROP CONSTRAINT IF EXISTS "run_node_sessions_otel_session_shape";
ALTER TABLE "run_node_sessions" DROP COLUMN IF EXISTS "otel_session";
COMMIT;
