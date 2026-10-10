-- ADR 0014 / W13-6 slice S2 (#227): the authz epoch of an organisation (tenants.authz_epoch of the
-- root, column added by 0018) is bumped by the database itself whenever something that can change
-- what a cached principal may do changes, whatever code path made the change (the application, the
-- reconcile, trb_users_home_move, an older application version, psql). The application compares the
-- epoch on every request and rebuilds a cached principal built under an older one. Additive and
-- idempotent. Down path: drizzle/down/0020_authz_epoch.down.sql
--
-- Bumped (the epoch of the organisation root, in the same transaction as the change):
--   tenant_role_bindings   insert, update, delete (statement level, once per statement and root)
--   users                  update of tenant_id, global_roles, platform_admin, disabled; delete
--   team_members           insert, update, delete
--   agent_role_bindings    insert, update, delete
--   tenants                insert / delete of a child; update of slug, parent_id, root_id, path
--                          (the cached tree snapshot is keyed by the epoch)
CREATE OR REPLACE FUNCTION "authz_bump_roots"(roots uuid[]) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
	IF roots IS NULL OR cardinality(roots) = 0 THEN
		RETURN;
	END IF;
	UPDATE "tenants" SET "authz_epoch" = "authz_epoch" + 1 WHERE "id" = ANY (roots);
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "authz_bump_trb_stmt"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	PERFORM "authz_bump_roots"(ARRAY(
		SELECT DISTINCT t."root_id" FROM "changed_rows" c JOIN "tenants" t ON t."id" = c."tenant_id"));
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "authz_bump_trb_update_stmt"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	PERFORM "authz_bump_roots"(ARRAY(
		SELECT DISTINCT t."root_id" FROM (
			SELECT "tenant_id" FROM "old_rows" UNION SELECT "tenant_id" FROM "new_rows") c
		JOIN "tenants" t ON t."id" = c."tenant_id"));
	RETURN NULL;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "authz_epoch_trb_ins" ON "tenant_role_bindings";--> statement-breakpoint
CREATE TRIGGER "authz_epoch_trb_ins" AFTER INSERT ON "tenant_role_bindings" REFERENCING NEW TABLE AS "changed_rows" FOR EACH STATEMENT EXECUTE FUNCTION "authz_bump_trb_stmt"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "authz_epoch_trb_del" ON "tenant_role_bindings";--> statement-breakpoint
CREATE TRIGGER "authz_epoch_trb_del" AFTER DELETE ON "tenant_role_bindings" REFERENCING OLD TABLE AS "changed_rows" FOR EACH STATEMENT EXECUTE FUNCTION "authz_bump_trb_stmt"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "authz_epoch_trb_upd" ON "tenant_role_bindings";--> statement-breakpoint
CREATE TRIGGER "authz_epoch_trb_upd" AFTER UPDATE ON "tenant_role_bindings" REFERENCING OLD TABLE AS "old_rows" NEW TABLE AS "new_rows" FOR EACH STATEMENT EXECUTE FUNCTION "authz_bump_trb_update_stmt"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "authz_bump_user"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		PERFORM "authz_bump_roots"(ARRAY(SELECT "root_id" FROM "tenants" WHERE "id" = OLD."tenant_id"));
		RETURN OLD;
	END IF;
	IF NEW."tenant_id" IS NOT DISTINCT FROM OLD."tenant_id"
		AND NEW."global_roles" IS NOT DISTINCT FROM OLD."global_roles"
		AND NEW."platform_admin" IS NOT DISTINCT FROM OLD."platform_admin"
		AND NEW."disabled" IS NOT DISTINCT FROM OLD."disabled" THEN
		RETURN NEW;
	END IF;
	PERFORM "authz_bump_roots"(ARRAY(
		SELECT DISTINCT "root_id" FROM "tenants" WHERE "id" IN (OLD."tenant_id", NEW."tenant_id")));
	RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "authz_epoch_users_upd" ON "users";--> statement-breakpoint
CREATE TRIGGER "authz_epoch_users_upd" AFTER UPDATE OF "tenant_id", "global_roles", "platform_admin", "disabled" ON "users" FOR EACH ROW EXECUTE FUNCTION "authz_bump_user"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "authz_epoch_users_del" ON "users";--> statement-breakpoint
CREATE TRIGGER "authz_epoch_users_del" AFTER DELETE ON "users" FOR EACH ROW EXECUTE FUNCTION "authz_bump_user"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "authz_bump_team_member"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	team uuid;
BEGIN
	IF TG_OP = 'DELETE' THEN team := OLD."team_id"; ELSE team := NEW."team_id"; END IF;
	PERFORM "authz_bump_roots"(ARRAY(
		SELECT t."root_id" FROM "teams" x JOIN "tenants" t ON t."id" = x."tenant_id" WHERE x."id" = team));
	RETURN NULL;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "authz_epoch_team_members_trg" ON "team_members";--> statement-breakpoint
CREATE TRIGGER "authz_epoch_team_members_trg" AFTER INSERT OR UPDATE OR DELETE ON "team_members" FOR EACH ROW EXECUTE FUNCTION "authz_bump_team_member"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "authz_bump_agent_binding"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	agent uuid;
BEGIN
	IF TG_OP = 'DELETE' THEN agent := OLD."agent_id"; ELSE agent := NEW."agent_id"; END IF;
	PERFORM "authz_bump_roots"(ARRAY(
		SELECT t."root_id" FROM "agents" x JOIN "tenants" t ON t."id" = x."tenant_id" WHERE x."id" = agent));
	RETURN NULL;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "authz_epoch_agent_role_bindings_trg" ON "agent_role_bindings";--> statement-breakpoint
CREATE TRIGGER "authz_epoch_agent_role_bindings_trg" AFTER INSERT OR UPDATE OR DELETE ON "agent_role_bindings" FOR EACH ROW EXECUTE FUNCTION "authz_bump_agent_binding"();--> statement-breakpoint
-- The conditions live in the function, not in the trigger definitions (UPDATE OF / WHEN): a column
-- list or WHEN clause would make the triggers depend on tenants.parent_id, root_id, path and slug
-- and block the documented revert of migration 0013.
CREATE OR REPLACE FUNCTION "authz_bump_tenant"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF OLD."parent_id" IS NOT NULL THEN
			PERFORM "authz_bump_roots"(ARRAY(SELECT "id" FROM "tenants" WHERE "id" = OLD."root_id"));
		END IF;
		RETURN NULL;
	END IF;
	IF TG_OP = 'UPDATE' THEN
		IF OLD."slug" IS NOT DISTINCT FROM NEW."slug" AND OLD."parent_id" IS NOT DISTINCT FROM NEW."parent_id"
			AND OLD."root_id" IS NOT DISTINCT FROM NEW."root_id" AND OLD."path" IS NOT DISTINCT FROM NEW."path" THEN
			RETURN NULL;
		END IF;
		PERFORM "authz_bump_roots"(ARRAY(
			SELECT DISTINCT "id" FROM "tenants" WHERE "id" IN (OLD."root_id", NEW."root_id")));
		RETURN NULL;
	END IF;
	IF NEW."parent_id" IS NOT NULL THEN
		PERFORM "authz_bump_roots"(ARRAY[NEW."root_id"]);
	END IF;
	RETURN NULL;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "authz_epoch_tenants_ins" ON "tenants";--> statement-breakpoint
CREATE TRIGGER "authz_epoch_tenants_ins" AFTER INSERT ON "tenants" FOR EACH ROW EXECUTE FUNCTION "authz_bump_tenant"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "authz_epoch_tenants_del" ON "tenants";--> statement-breakpoint
CREATE TRIGGER "authz_epoch_tenants_del" AFTER DELETE ON "tenants" FOR EACH ROW EXECUTE FUNCTION "authz_bump_tenant"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "authz_epoch_tenants_upd" ON "tenants";--> statement-breakpoint
CREATE TRIGGER "authz_epoch_tenants_upd" AFTER UPDATE ON "tenants" FOR EACH ROW EXECUTE FUNCTION "authz_bump_tenant"();
