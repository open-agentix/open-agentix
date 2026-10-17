-- Reverts 0041_dev_runs.sql (ADR 0017 slice S5, #248).
-- Not part of the drizzle journal: run it by hand (psql) after rolling the application back, then
-- delete the row of migration 0041 from drizzle.__drizzle_migrations. It DELETES every development
-- run with its steps, approvals, node sessions, model reservations, issuance records, cost lines and
-- frozen definition (older code cannot read a run without a published version), drops the new
-- columns and the development budget of the nodes. Production runs are not touched. Run it before
-- the down script of 0040.
DROP TRIGGER IF EXISTS runs_stage_immutable ON runs;
DROP FUNCTION IF EXISTS oax_run_stage_immutable();
DELETE FROM model_reservations WHERE run_id IN (SELECT id FROM runs WHERE stage = 'development');
DELETE FROM run_node_sessions WHERE run_id IN (SELECT id FROM runs WHERE stage = 'development');
DELETE FROM approvals WHERE run_id IN (SELECT id FROM runs WHERE stage = 'development');
DELETE FROM run_steps WHERE run_id IN (SELECT id FROM runs WHERE stage = 'development');
DELETE FROM run_secret_issuances WHERE run_id IN (SELECT id FROM runs WHERE stage = 'development');
DELETE FROM cost_ledger WHERE stage = 'development';
DROP TABLE IF EXISTS dev_run_definitions;
DELETE FROM runs WHERE stage = 'development';
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_stage_shape;
DROP INDEX IF EXISTS runs_dev_started_by_idx;
ALTER TABLE runs DROP COLUMN IF EXISTS started_by;
ALTER TABLE runs DROP COLUMN IF EXISTS stage;
ALTER TABLE runs DROP COLUMN IF EXISTS agent_revision_id;
ALTER TABLE runs ALTER COLUMN agent_version_id SET NOT NULL;
DROP INDEX IF EXISTS cost_tenant_stage_month_idx;
ALTER TABLE cost_ledger DROP CONSTRAINT IF EXISTS cost_ledger_stage_check;
ALTER TABLE cost_ledger DROP COLUMN IF EXISTS stage;
ALTER TABLE tenants DROP COLUMN IF EXISTS dev_monthly_budget_micros;
