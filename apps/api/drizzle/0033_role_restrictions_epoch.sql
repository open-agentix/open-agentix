-- ADR 0014 / W13-6 slice S9 (#194): role restrictions are read with the principal's grants (the
-- loader picks the restrictions that can narrow a user's bindings), so a change to
-- tenant_role_restrictions can change what a cached principal may do. Like every other change of
-- the grants (migration 0021), the database bumps the authz epoch of the organisation root itself,
-- in the same transaction and whatever code path made the change (the application, psql, a
-- cascade). Reuses the statement-level functions of 0021 (the table has the same tenant_id column).
-- Additive and idempotent; no schema change, no data change. Down path:
-- drizzle/down/0033_role_restrictions_epoch.down.sql
DROP TRIGGER IF EXISTS "authz_epoch_trr_ins" ON "tenant_role_restrictions";--> statement-breakpoint
CREATE TRIGGER "authz_epoch_trr_ins" AFTER INSERT ON "tenant_role_restrictions" REFERENCING NEW TABLE AS "changed_rows" FOR EACH STATEMENT EXECUTE FUNCTION "authz_bump_trb_stmt"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "authz_epoch_trr_del" ON "tenant_role_restrictions";--> statement-breakpoint
CREATE TRIGGER "authz_epoch_trr_del" AFTER DELETE ON "tenant_role_restrictions" REFERENCING OLD TABLE AS "changed_rows" FOR EACH STATEMENT EXECUTE FUNCTION "authz_bump_trb_stmt"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "authz_epoch_trr_upd" ON "tenant_role_restrictions";--> statement-breakpoint
CREATE TRIGGER "authz_epoch_trr_upd" AFTER UPDATE ON "tenant_role_restrictions" REFERENCING OLD TABLE AS "old_rows" NEW TABLE AS "new_rows" FOR EACH STATEMENT EXECUTE FUNCTION "authz_bump_trb_update_stmt"();
