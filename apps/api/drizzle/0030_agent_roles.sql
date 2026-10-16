-- ADR 0017 slice S10 (#290): the fixed roles `agent-developer` and `agent-maintainer`, and the
-- outright rename of `agent-engineer` to `agent-maintainer` (follow-up decision F2: no alias,
-- breaking, acceptable before 1.0). Every stored `agent-engineer` becomes `agent-maintainer`:
-- users.global_roles and the mirror rows, explicit node bindings (tenant_role_bindings), role
-- restrictions, team members, agent bindings and the approver roles of approvals that are still
-- pending. The old role plus the new agent permissions is exactly what `agent-maintainer` holds
-- (packages/core/src/rbac.ts), so nobody gains or loses anything beyond that. Afterwards the check
-- constraints refuse `agent-engineer`. Published agent versions are immutable and keep their text.
-- Down path: drizzle/down/0030_agent_roles.down.sql
ALTER TABLE "tenant_role_bindings" DROP CONSTRAINT IF EXISTS "trb_role_check";--> statement-breakpoint
ALTER TABLE "tenant_role_restrictions" DROP CONSTRAINT IF EXISTS "trr_role_check";--> statement-breakpoint
-- The mirror trigger of 0023 with the new legacy role set. It must be replaced before users is
-- updated below: it would otherwise delete the renamed mirror rows (role no longer in its list).
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
$$;--> statement-breakpoint
UPDATE "tenant_role_bindings" SET "role" = 'agent-maintainer' WHERE "role" = 'agent-engineer';--> statement-breakpoint
UPDATE "tenant_role_restrictions" SET "role" = 'agent-maintainer' WHERE "role" = 'agent-engineer';--> statement-breakpoint
UPDATE "team_members" SET "role" = 'agent-maintainer' WHERE "role" = 'agent-engineer';--> statement-breakpoint
UPDATE "agent_role_bindings" SET "role" = 'agent-maintainer' WHERE "role" = 'agent-engineer';--> statement-breakpoint
UPDATE "users" SET "global_roles" = array_replace("global_roles", 'agent-engineer', 'agent-maintainer') WHERE 'agent-engineer' = ANY ("global_roles");--> statement-breakpoint
UPDATE "approvals" SET "approver_roles" = array_replace("approver_roles", 'agent-engineer', 'agent-maintainer') WHERE "status" = 'pending' AND 'agent-engineer' = ANY ("approver_roles");--> statement-breakpoint
ALTER TABLE "tenant_role_bindings" ADD CONSTRAINT "trb_role_check" CHECK ("tenant_role_bindings"."role" in ('admin','agent-developer','agent-maintainer','integrator','operator','auditor','viewer','pentest'));--> statement-breakpoint
ALTER TABLE "tenant_role_restrictions" ADD CONSTRAINT "trr_role_check" CHECK ("tenant_role_restrictions"."role" in ('admin','agent-developer','agent-maintainer','integrator','operator','auditor','viewer','pentest'));
