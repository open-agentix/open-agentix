-- Reverts 0021_authz_epoch.sql (ADR 0014 slice S2, #227).
-- Not part of the drizzle journal: run it by hand (psql) after rolling the application back, then
-- delete the row of migration 0021 from drizzle.__drizzle_migrations. Loses no data: tenants.authz_epoch
-- stays (column of 0018) but nothing bumps it any more, so an application version that compares the
-- epoch would no longer see revocations made outside it.
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
