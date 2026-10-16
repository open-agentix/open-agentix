-- Reverts 0036_grantor_unknown.sql (ADR 0017 slice S2b, #343).
-- Not part of the drizzle journal: run it by hand (psql) after rolling the application back, then
-- delete the row of migration 0036 from drizzle.__drizzle_migrations. It DROPS the columns
-- users.created_by and grantor_unknown (the distinction between "nobody granted this" and "grantor
-- unknown" is lost, and so is the recorded creator of local accounts); no grant, binding or user is
-- removed. Granted_by values that the migration attributed from the audit chain stay. The
-- home-move trigger goes back to the definition of 0030.
DROP TRIGGER IF EXISTS "users_mark_grantor_unknown" ON "users";
DROP FUNCTION IF EXISTS "oax_mark_grantor_unknown"();
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
			AND "role" IN ('admin','agent-developer','agent-maintainer','integrator','operator','auditor','viewer');
		INSERT INTO "tenant_role_bindings" ("id", "user_id", "tenant_id", "role", "inherit", "source")
			SELECT gen_random_uuid(), NEW."id", NEW."tenant_id", r."role", false, 'mirror'
			FROM (SELECT DISTINCT unnest(NEW."global_roles") AS "role") r
			WHERE r."role" IN ('admin','agent-developer','agent-maintainer','integrator','operator','auditor','viewer')
			ON CONFLICT DO NOTHING;
	END IF;
	DELETE FROM "tenant_role_bindings"
		WHERE "user_id" = NEW."id" AND "tenant_id" = NEW."tenant_id" AND "use_case" IS NULL
		AND "source" = 'mirror'
		AND "role" IN ('admin','agent-developer','agent-maintainer','integrator','operator','auditor','viewer')
		AND NOT ("role" = ANY (coalesce(NEW."global_roles", '{}'::text[])));
	RETURN NEW;
END;
$$;
ALTER TABLE "agent_role_bindings" DROP COLUMN IF EXISTS "grantor_unknown";
ALTER TABLE "team_members" DROP COLUMN IF EXISTS "grantor_unknown";
ALTER TABLE "tenant_role_bindings" DROP COLUMN IF EXISTS "grantor_unknown";
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_created_by_users_id_fk";
ALTER TABLE "users" DROP COLUMN IF EXISTS "created_by";
