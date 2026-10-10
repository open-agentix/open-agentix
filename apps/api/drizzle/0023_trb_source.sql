-- ADR 0014 / W13-6 slice S4 (#226): mirror rows get their own key. `tenant_role_bindings.source`
-- is 'mirror' for the rows that mirror users.global_roles (one slot per legacy role on the user's
-- home node, maintained by the application, the reconcile and the trigger below) and 'grant' for
-- every row created through the role-binding API. `source` is part of trb_uq, and the same-key
-- rule, the reconcile, the global_roles mirror writes and trb_users_home_move now touch
-- `source = 'mirror'` only, so an explicit grant survives an unrelated global_roles change and a
-- home move. Additive and idempotent. Down path: drizzle/down/0023_trb_source.down.sql
ALTER TABLE "tenant_role_bindings" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'mirror' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_role_bindings" DROP CONSTRAINT IF EXISTS "trb_source_check";--> statement-breakpoint
ALTER TABLE "tenant_role_bindings" ADD CONSTRAINT "trb_source_check" CHECK ("tenant_role_bindings"."source" in ('mirror','grant'));--> statement-breakpoint
-- A row the mirror cannot have written (inheriting, expiring, with a use case, pentest, or not on
-- the user's home node) was created by something else and is an explicit grant. Existing mirror-shaped
-- rows stay 'mirror' (the default above).
UPDATE "tenant_role_bindings" b SET "source" = 'grant'
WHERE b."source" = 'mirror' AND (
	b."inherit" OR b."expires_at" IS NOT NULL OR b."use_case" IS NOT NULL
	OR b."role" NOT IN ('admin','agent-engineer','integrator','operator','auditor','viewer')
	OR b."tenant_id" IS DISTINCT FROM (SELECT u."tenant_id" FROM "users" u WHERE u."id" = b."user_id"));--> statement-breakpoint
DROP INDEX IF EXISTS "trb_uq";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trb_uq" ON "tenant_role_bindings" USING btree ("user_id","tenant_id","role",coalesce("use_case", ''),"source");--> statement-breakpoint
-- Same trigger as 0019, restricted to mirror rows (explicit grants are never removed or created here).
-- Home move inside the organisation: mirror rows of the legacy key on the OLD home node are removed,
-- the new home node gets the rows of global_roles; explicit grants stay where they are (the guard
-- trb_users_home_guard still refuses a move to another organisation while any binding of the old
-- one exists). Same-key rule: a mirror row whose role is not in global_roles is removed.
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
