-- Reverts 0015_agent_summary_fields.sql (the denormalised use case of agents and the two indexes of
-- the agent list; the value is derived from agent versions and drafts, so nothing is lost).
-- Not part of the drizzle journal: run it by hand (psql) after rolling the application back,
-- then delete the row of migration 0015 from drizzle.__drizzle_migrations.
BEGIN;
DROP INDEX "agents_tenant_use_case_idx";
DROP INDEX "agents_tenant_created_idx";
ALTER TABLE "agents" DROP COLUMN "use_case";
COMMIT;
