-- Reverts 0033_role_restrictions_epoch.sql (ADR 0014 slice S9, #194).
-- Not part of the drizzle journal: run it by hand (psql) after rolling the application back, then
-- delete the row of migration 0033 from drizzle.__drizzle_migrations. Loses no data. Without the
-- triggers a change of tenant_role_restrictions no longer bumps the authz epoch, so an application
-- version that reads restrictions would keep serving cached principals until their TTL.
DROP TRIGGER IF EXISTS "authz_epoch_trr_ins" ON "tenant_role_restrictions";
DROP TRIGGER IF EXISTS "authz_epoch_trr_del" ON "tenant_role_restrictions";
DROP TRIGGER IF EXISTS "authz_epoch_trr_upd" ON "tenant_role_restrictions";
