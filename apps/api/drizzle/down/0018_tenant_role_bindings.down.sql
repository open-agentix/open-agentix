-- Reverts 0018_tenant_role_bindings.sql (ADR 0014 slice S1).
-- Not part of the drizzle journal: run it by hand (psql) after rolling the application back,
-- then delete the row of migration 0018 from drizzle.__drizzle_migrations.
-- Safe because users.global_roles is mirrored (write-through) and still authoritative: the
-- rollback loses only inheritance flags, expiries, pentest bindings and restrictions, none of
-- which can be created before the next slices.
-- Run 0020_authz_epoch.down.sql and 0019_trb_home_move.down.sql first if they were applied (this also
-- drops their objects: the epoch triggers read tenants.authz_epoch, which goes away here).
DROP TRIGGER IF EXISTS "authz_epoch_trb_ins" ON "tenant_role_bindings";
DROP TRIGGER IF EXISTS "authz_epoch_trb_del" ON "tenant_role_bindings";
DROP TRIGGER IF EXISTS "authz_epoch_trb_upd" ON "tenant_role_bindings";
DROP TRIGGER IF EXISTS "authz_epoch_users_upd" ON "users";
DROP TRIGGER IF EXISTS "authz_epoch_users_del" ON "users";
DROP TRIGGER IF EXISTS "authz_epoch_team_members_trg" ON "team_members";
DROP TRIGGER IF EXISTS "authz_epoch_agent_role_bindings_trg" ON "agent_role_bindings";
DROP TRIGGER IF EXISTS "authz_epoch_tenants_ins" ON "tenants";
DROP TRIGGER IF EXISTS "authz_epoch_tenants_del" ON "tenants";
DROP TRIGGER IF EXISTS "authz_epoch_tenants_upd" ON "tenants";
DROP TRIGGER IF EXISTS "authz_epoch_teams_trg" ON "teams";
DROP TRIGGER IF EXISTS "authz_epoch_agents_trg" ON "agents";
DROP FUNCTION IF EXISTS "authz_bump_agent_owner"();
DROP FUNCTION IF EXISTS "authz_bump_team_owner"();
DROP FUNCTION IF EXISTS "authz_bump_tenant"();
DROP FUNCTION IF EXISTS "authz_bump_agent_binding"();
DROP FUNCTION IF EXISTS "authz_bump_team_member"();
DROP FUNCTION IF EXISTS "authz_bump_user"();
DROP FUNCTION IF EXISTS "authz_bump_trb_update_stmt"();
DROP FUNCTION IF EXISTS "authz_bump_trb_stmt"();
DROP FUNCTION IF EXISTS "authz_bump_roots"(uuid[]);
DROP TRIGGER IF EXISTS "trb_users_home_move_trg" ON "users";
DROP FUNCTION IF EXISTS "trb_users_home_move"();
DROP TRIGGER IF EXISTS "trb_users_home_guard_trg" ON "users";
DROP FUNCTION IF EXISTS "trb_users_home_guard"();
DROP TRIGGER IF EXISTS "trb_same_org_trg" ON "tenant_role_bindings";
DROP FUNCTION IF EXISTS "trb_same_org"();
DROP TABLE IF EXISTS "tenant_role_restrictions";
DROP TABLE IF EXISTS "tenant_role_bindings";
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "authz_epoch";
