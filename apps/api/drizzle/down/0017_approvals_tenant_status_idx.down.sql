-- Reverts 0017_approvals_tenant_status_idx.sql (UX slice A3).
-- Not part of the drizzle journal: run it by hand (psql) after rolling the application back,
-- then delete the row of migration 0017 from drizzle.__drizzle_migrations.
DROP INDEX IF EXISTS "approvals_tenant_status_idx";
