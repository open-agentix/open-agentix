-- ADR 0014 / W13-6 slice S1 follow-up (#216): when a user's home tenant changes inside the
-- organisation, the mirror rows of the old home node move with it, in the same statement, whatever
-- code path (or older application version, or psql) changed users.tenant_id. Additive, idempotent.
-- Down path: drizzle/down/0019_trb_home_move.down.sql
-- Only mirror-shaped rows (non-inheriting, non-expiring, no use case, one of the six roles) on the
-- OLD home node are removed; every other binding of the user stays. The new home gets the rows of
-- users.global_roles (the source of truth), exactly like the backfill of 0018.
CREATE OR REPLACE FUNCTION "trb_users_home_move"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."tenant_id" IS NOT DISTINCT FROM OLD."tenant_id" THEN
		RETURN NEW;
	END IF;
	DELETE FROM "tenant_role_bindings"
		WHERE "user_id" = NEW."id" AND "tenant_id" = OLD."tenant_id"
		AND "inherit" = false AND "use_case" IS NULL AND "expires_at" IS NULL
		AND "role" IN ('admin','agent-engineer','integrator','operator','auditor','viewer');
	INSERT INTO "tenant_role_bindings" ("id", "user_id", "tenant_id", "role", "inherit")
		SELECT gen_random_uuid(), NEW."id", NEW."tenant_id", r."role", false
		FROM (SELECT DISTINCT unnest(NEW."global_roles") AS "role") r
		WHERE r."role" IN ('admin','agent-engineer','integrator','operator','auditor','viewer')
		ON CONFLICT DO NOTHING;
	RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trb_users_home_move_trg" ON "users";--> statement-breakpoint
CREATE TRIGGER "trb_users_home_move_trg" AFTER UPDATE OF "tenant_id" ON "users" FOR EACH ROW EXECUTE FUNCTION "trb_users_home_move"();
