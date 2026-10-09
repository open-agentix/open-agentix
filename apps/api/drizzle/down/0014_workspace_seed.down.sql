-- Reverts 0014_workspace_seed.sql (the workspace seed columns of run_node_sessions; the seed is
-- transient data, nothing is lost that a rerun would not recreate).
-- Not part of the drizzle journal: run it by hand (psql) after rolling the application back,
-- then delete the row of migration 0014 from drizzle.__drizzle_migrations.
BEGIN;
ALTER TABLE "run_node_sessions" DROP COLUMN "workspace_seed_fetched_at";
ALTER TABLE "run_node_sessions" DROP COLUMN "workspace_seed_sha256";
ALTER TABLE "run_node_sessions" DROP COLUMN "workspace_seed";
COMMIT;
