-- Reverts 0030_agent_roles.sql (ADR 0017 slice S10, #290).
-- Not part of the drizzle journal: run it by hand (psql) after rolling the application back, then
-- delete the row of migration 0030 from drizzle.__drizzle_migrations.
-- Refuses (and changes nothing) while any `agent-developer` binding exists: the old role set cannot
-- express it, and mapping it to another role would silently change what the person may do. Remove
-- or change those bindings first. Otherwise every `agent-maintainer` becomes `agent-engineer`
-- again (global roles and mirror rows, node bindings, restrictions, team members, agent bindings and
-- pending approvals). The old application then holds exactly the permissions the role had before.
BEGIN;
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "tenant_role_bindings" WHERE "role" = 'agent-developer')
		OR EXISTS (SELECT 1 FROM "tenant_role_restrictions" WHERE "role" = 'agent-developer')
		OR EXISTS (SELECT 1 FROM "team_members" WHERE "role" = 'agent-developer')
		OR EXISTS (SELECT 1 FROM "agent_role_bindings" WHERE "role" = 'agent-developer')
		OR EXISTS (SELECT 1 FROM "users" WHERE 'agent-developer' = ANY ("global_roles")) THEN
		RAISE EXCEPTION 'agent-developer bindings exist: remove them before reverting migration 0030';
	END IF;
END
$$;
ALTER TABLE "tenant_role_bindings" DROP CONSTRAINT IF EXISTS "trb_role_check";
ALTER TABLE "tenant_role_restrictions" DROP CONSTRAINT IF EXISTS "trr_role_check";
-- trb_users_home_move as of 0023_trb_source.sql.
CREATE OR REPLACE FUNCTION "trb_users_home_move"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."tenant_id" IS NOT DISTINCT FROM OLD."tenant_id"
		AND NEW."global_roles" IS NOT DISTINCT FROM OLD."global_roles" THEN
		RETURN NEW;
	END IF;
	IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id" THEN
		DELETE FROM "tenant_role_bindings"
			WHERE "user_id" = NEW."id" AND "tenant_id" = OLD."tenant_id" AND "use_case" IS NULL
			AND "source" = 'mirror'
			AND "role" IN ('admin','agent-engineer','integrator','operator','auditor','viewer');
		INSERT INTO "tenant_role_bindings" ("id", "user_id", "tenant_id", "role", "inherit", "source")
			SELECT gen_random_uuid(), NEW."id", NEW."tenant_id", r."role", false, 'mirror'
			FROM (SELECT DISTINCT unnest(NEW."global_roles") AS "role") r
			WHERE r."role" IN ('admin','agent-engineer','integrator','operator','auditor','viewer')
			ON CONFLICT DO NOTHING;
	END IF;
	DELETE FROM "tenant_role_bindings"
		WHERE "user_id" = NEW."id" AND "tenant_id" = NEW."tenant_id" AND "use_case" IS NULL
		AND "source" = 'mirror'
		AND "role" IN ('admin','agent-engineer','integrator','operator','auditor','viewer')
		AND NOT ("role" = ANY (coalesce(NEW."global_roles", '{}'::text[])));
	RETURN NEW;
END;
$$;
UPDATE "tenant_role_bindings" SET "role" = 'agent-engineer' WHERE "role" = 'agent-maintainer';
UPDATE "tenant_role_restrictions" SET "role" = 'agent-engineer' WHERE "role" = 'agent-maintainer';
UPDATE "team_members" SET "role" = 'agent-engineer' WHERE "role" = 'agent-maintainer';
UPDATE "agent_role_bindings" SET "role" = 'agent-engineer' WHERE "role" = 'agent-maintainer';
UPDATE "users" SET "global_roles" = array_replace("global_roles", 'agent-maintainer', 'agent-engineer') WHERE 'agent-maintainer' = ANY ("global_roles");
UPDATE "approvals" SET "approver_roles" = array_replace("approver_roles", 'agent-maintainer', 'agent-engineer') WHERE "status" = 'pending' AND 'agent-maintainer' = ANY ("approver_roles");
ALTER TABLE "tenant_role_bindings" ADD CONSTRAINT "trb_role_check" CHECK ("tenant_role_bindings"."role" in ('admin','agent-engineer','integrator','operator','auditor','viewer','pentest'));
ALTER TABLE "tenant_role_restrictions" ADD CONSTRAINT "trr_role_check" CHECK ("tenant_role_restrictions"."role" in ('admin','agent-engineer','integrator','operator','auditor','viewer','pentest'));
COMMIT;
