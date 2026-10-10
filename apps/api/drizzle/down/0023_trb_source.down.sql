-- Reverts 0023_trb_source.sql (ADR 0014 slice S4, #226).
-- Not part of the drizzle journal: run it by hand (psql) after rolling the application back, then
-- delete the row of migration 0023 from drizzle.__drizzle_migrations.
-- Loses the distinction between mirror rows and explicit grants. An explicit grant that shares its
-- key (user, node, role, use case) with a mirror row is deleted first (the old unique index allows one
-- row per key and the mirror row keeps the slot); every other grant stays as a plain row, which the
-- pre-0023 same-key rule, reconcile and trigger treat as a mirror row again: a grant on the user's
-- home node in a legacy role that global_roles does not list is then revoked by them.
DELETE FROM "tenant_role_bindings" g USING "tenant_role_bindings" m
	WHERE g."source" = 'grant' AND m."source" = 'mirror' AND g."user_id" = m."user_id"
	AND g."tenant_id" = m."tenant_id" AND g."role" = m."role"
	AND coalesce(g."use_case", '') = coalesce(m."use_case", '');
DROP INDEX IF EXISTS "trb_uq";
CREATE UNIQUE INDEX IF NOT EXISTS "trb_uq" ON "tenant_role_bindings" USING btree ("user_id","tenant_id","role",coalesce("use_case", ''));
ALTER TABLE "tenant_role_bindings" DROP CONSTRAINT IF EXISTS "trb_source_check";
ALTER TABLE "tenant_role_bindings" DROP COLUMN IF EXISTS "source";
-- trb_users_home_move as of 0019_trb_home_move.sql (no source column).
CREATE OR REPLACE FUNCTION "trb_users_home_move"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."tenant_id" IS NOT DISTINCT FROM OLD."tenant_id"
		AND NEW."global_roles" IS NOT DISTINCT FROM OLD."global_roles" THEN
		RETURN NEW;
	END IF;
	IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id" THEN
		DELETE FROM "tenant_role_bindings"
			WHERE "user_id" = NEW."id" AND "tenant_id" = OLD."tenant_id" AND "use_case" IS NULL
			AND "role" IN ('admin','agent-engineer','integrator','operator','auditor','viewer');
		INSERT INTO "tenant_role_bindings" ("id", "user_id", "tenant_id", "role", "inherit")
			SELECT gen_random_uuid(), NEW."id", NEW."tenant_id", r."role", false
			FROM (SELECT DISTINCT unnest(NEW."global_roles") AS "role") r
			WHERE r."role" IN ('admin','agent-engineer','integrator','operator','auditor','viewer')
			ON CONFLICT DO NOTHING;
	END IF;
	DELETE FROM "tenant_role_bindings"
		WHERE "user_id" = NEW."id" AND "tenant_id" = NEW."tenant_id" AND "use_case" IS NULL
		AND "role" IN ('admin','agent-engineer','integrator','operator','auditor','viewer')
		AND NOT ("role" = ANY (coalesce(NEW."global_roles", '{}'::text[])));
	RETURN NEW;
END;
$$;
