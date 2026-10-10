-- Reverts 0025_approvals_consumed_at.sql (ADR 0016 slice S4, #234).
-- Not part of the drizzle journal: run it by hand (psql) after rolling the application back, then
-- delete the row of migration 0025 from drizzle.__drizzle_migrations.
-- Loses only the "used" marker of approvals; an older build never reads it. Re-applying 0025 starts
-- with every approval unused, which only matters for approvals that are still open.
BEGIN;
ALTER TABLE "approvals" DROP COLUMN IF EXISTS "consumed_at";
COMMIT;
