-- Reverts 0018_tenant_role_bindings.sql (ADR 0014 slice S1).
-- Not part of the drizzle journal: run it by hand (psql) after rolling the application back,
-- then delete the row of migration 0018 from drizzle.__drizzle_migrations.
-- Safe because users.global_roles is mirrored (write-through) and still authoritative: the
-- rollback loses only inheritance flags, expiries, pentest bindings and restrictions, none of
-- which can be created before the next slices.
DROP TRIGGER IF EXISTS "trb_users_home_guard_trg" ON "users";
DROP FUNCTION IF EXISTS "trb_users_home_guard"();
DROP TRIGGER IF EXISTS "trb_same_org_trg" ON "tenant_role_bindings";
DROP FUNCTION IF EXISTS "trb_same_org"();
DROP TABLE IF EXISTS "tenant_role_restrictions";
DROP TABLE IF EXISTS "tenant_role_bindings";
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "authz_epoch";
