-- Reverts 0016_agent_disable.sql (agent disable/enable, UX slice A7).
-- Not part of the drizzle journal: run it by hand (psql) after rolling the application back,
-- then delete the row of migration 0016 from drizzle.__drizzle_migrations.
-- Disabled agents become enabled again when the columns are dropped; export them first if needed:
--   SELECT id, disabled_at, disabled_by, disabled_reason FROM agents WHERE disabled_at IS NOT NULL;
BEGIN;
ALTER TABLE "agents" DROP CONSTRAINT "agents_disabled_reason_len";
ALTER TABLE "agents" DROP COLUMN "disabled_reason";
ALTER TABLE "agents" DROP COLUMN "disabled_by";
ALTER TABLE "agents" DROP COLUMN "disabled_at";
COMMIT;
