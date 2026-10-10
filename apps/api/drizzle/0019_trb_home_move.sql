-- ADR 0014 / W13-6 slice S1 follow-up (#216): the database keeps the bindings mirror from granting
-- more than users.global_roles, whatever code path (an older application version, SCIM/LDAP sync,
-- psql) changed the user row, in the same statement. Additive, idempotent.
-- Down path: drizzle/down/0019_trb_home_move.down.sql
--
-- Fires on UPDATE OF tenant_id, global_roles and returns at once when neither value changed.
-- The legacy key of a role is (user, home node, role, no use case) for one of the six roles.
-- * Home change inside the organisation: every legacy-key row of the OLD home node is removed,
--   whatever its shape (a row there either was the mirror, or stood in for a legacy role, or was
--   stale by definition); rows with a use case and pentest rows stay. The new home gets the rows
--   of global_roles, exactly like the backfill of 0018.
-- * Same-key rule on the (new) home node: a legacy-key row whose role is not in global_roles is
--   removed, whatever its shape, so a role taken away through the column alone can never stay
--   bound. Roles added through the column alone are left to the application and the reconcile
--   (a missing row grants less, never more).
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
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trb_users_home_move_trg" ON "users";--> statement-breakpoint
CREATE TRIGGER "trb_users_home_move_trg" AFTER UPDATE OF "tenant_id", "global_roles" ON "users" FOR EACH ROW EXECUTE FUNCTION "trb_users_home_move"();
