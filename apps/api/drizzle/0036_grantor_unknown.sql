-- ADR 0017 slice S2b (#343, findings 1 and 5): what rule A4 needs to follow a grant chain and to
-- tell "nobody granted this" from "we do not know who granted this".
--
-- * users.created_by: the account that created a local account (the user API). Accounts made by a
--   contributor of a review are contributor-made.
-- * grantor_unknown on tenant_role_bindings, team_members and agent_role_bindings: `granted_by is
--   null` with the flag false means nobody granted the row (identity provider, bootstrap, the
--   platform flag); with the flag true it means the grantor is not known. Rows from before the
--   grantor was recorded are attributed from the audit chain where it shows who did it and are
--   marked unknown where it does not; rows of identity-provider accounts and of the bootstrap
--   administrator stay "nobody". Deleting a user marks the rows it granted as unknown instead of
--   leaving an anonymous clean row behind. The home-move trigger marks the rows it creates unknown.
-- Down path: drizzle/down/0036_grantor_unknown.down.sql
ALTER TABLE "users" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_role_bindings" ADD COLUMN "grantor_unknown" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "team_members" ADD COLUMN "grantor_unknown" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_role_bindings" ADD COLUMN "grantor_unknown" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Who created each local account, from the audit chain (`user.created`, actor = the creator).
UPDATE "users" u SET "created_by" = a.actor_id
FROM (
	SELECT DISTINCT ON (l."target") l."target" AS target_id,
		CASE WHEN l."actor" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN l."actor"::uuid END AS actor_id
	FROM "audit_log" l
	WHERE l."action" = 'user.created'
	ORDER BY l."target", l."seq"
) a
WHERE a.target_id = u."id"::text AND a.actor_id IS NOT NULL AND a.actor_id <> u."id"
	AND EXISTS (SELECT 1 FROM "users" c WHERE c."id" = a.actor_id);--> statement-breakpoint
-- The grantor columns are not read by the resolver: keep the authz epoch where it is while the
-- rows are attributed (the update triggers would bump it for every changed organisation).
ALTER TABLE "tenant_role_bindings" DISABLE TRIGGER "authz_epoch_trb_upd";--> statement-breakpoint
ALTER TABLE "team_members" DISABLE TRIGGER "authz_epoch_team_members_trg";--> statement-breakpoint
ALTER TABLE "agent_role_bindings" DISABLE TRIGGER "authz_epoch_agent_role_bindings_trg";--> statement-breakpoint
-- Mirror rows without a grantor: attribute to the user who put the role in `global_roles` (the
-- earliest `user.created` / `user.updated` entry after the last one that did not list the role).
UPDATE "tenant_role_bindings" b SET "granted_by" = x.actor_id
FROM (
	SELECT b2."id" AS binding_id, (
		SELECT CASE WHEN a."actor" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN a."actor"::uuid END
		FROM "audit_log" a
		WHERE a."action" IN ('user.created', 'user.updated') AND a."target" = b2."user_id"::text
			AND jsonb_exists(a."payload", 'globalRoles')
			AND jsonb_path_exists(a."payload", '$.globalRoles[*] ? (@ == $r)', jsonb_build_object('r', b2."role"))
			AND a."seq" > coalesce((
				SELECT max(r."seq") FROM "audit_log" r
				WHERE r."action" IN ('user.created', 'user.updated') AND r."target" = a."target"
					AND jsonb_exists(r."payload", 'globalRoles')
					AND NOT jsonb_path_exists(r."payload", '$.globalRoles[*] ? (@ == $r)', jsonb_build_object('r', b2."role"))), 0)
		ORDER BY a."seq" LIMIT 1) AS actor_id
	FROM "tenant_role_bindings" b2
	JOIN "users" u ON u."id" = b2."user_id"
	WHERE b2."source" = 'mirror' AND b2."granted_by" IS NULL AND b2."use_case" IS NULL AND u."source" = 'local'
) x
WHERE x.binding_id = b."id" AND x.actor_id IS NOT NULL AND x.actor_id <> b."user_id"
	AND EXISTS (SELECT 1 FROM "users" c WHERE c."id" = x.actor_id);--> statement-breakpoint
-- Team memberships without a grantor: the actor of the `team.members.set` that listed the member.
UPDATE "team_members" m SET "granted_by" = x.actor_id
FROM (
	SELECT m2."team_id" AS team_id, m2."user_id" AS user_id, m2."role" AS role, (
		SELECT CASE WHEN a."actor" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN a."actor"::uuid END
		FROM "audit_log" a
		WHERE a."action" = 'team.members.set' AND a."target" = m2."team_id"::text
			AND jsonb_path_exists(a."payload", '$.members[*] ? (@.userId == $u && @.role == $r)',
				jsonb_build_object('u', m2."user_id"::text, 'r', m2."role"))
			AND a."seq" > coalesce((
				SELECT max(r."seq") FROM "audit_log" r
				WHERE r."action" = 'team.members.set' AND r."target" = a."target"
					AND NOT jsonb_path_exists(r."payload", '$.members[*] ? (@.userId == $u && @.role == $r)',
						jsonb_build_object('u', m2."user_id"::text, 'r', m2."role"))), 0)
		ORDER BY a."seq" LIMIT 1) AS actor_id
	FROM "team_members" m2
	JOIN "users" u ON u."id" = m2."user_id"
	WHERE m2."granted_by" IS NULL AND u."source" = 'local'
) x
WHERE x.team_id = m."team_id" AND x.user_id = m."user_id" AND x.role = m."role"
	AND x.actor_id IS NOT NULL AND x.actor_id <> m."user_id"
	AND EXISTS (SELECT 1 FROM "users" c WHERE c."id" = x.actor_id);--> statement-breakpoint
-- Agent memberships without a grantor: the actor of the `agent.members.set` that listed the member.
UPDATE "agent_role_bindings" m SET "granted_by" = x.actor_id
FROM (
	SELECT m2."agent_id" AS agent_id, m2."user_id" AS user_id, m2."role" AS role, (
		SELECT CASE WHEN a."actor" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN a."actor"::uuid END
		FROM "audit_log" a
		WHERE a."action" = 'agent.members.set' AND a."target" = m2."agent_id"::text
			AND jsonb_path_exists(a."payload", '$.members[*] ? (@.userId == $u && @.role == $r)',
				jsonb_build_object('u', m2."user_id"::text, 'r', m2."role"))
			AND a."seq" > coalesce((
				SELECT max(r."seq") FROM "audit_log" r
				WHERE r."action" = 'agent.members.set' AND r."target" = a."target"
					AND NOT jsonb_path_exists(r."payload", '$.members[*] ? (@.userId == $u && @.role == $r)',
						jsonb_build_object('u', m2."user_id"::text, 'r', m2."role"))), 0)
		ORDER BY a."seq" LIMIT 1) AS actor_id
	FROM "agent_role_bindings" m2
	WHERE m2."granted_by" IS NULL
) x
WHERE x.agent_id = m."agent_id" AND x.user_id = m."user_id" AND x.role = m."role"
	AND x.actor_id IS NOT NULL AND x.actor_id <> m."user_id"
	AND EXISTS (SELECT 1 FROM "users" c WHERE c."id" = x.actor_id);--> statement-breakpoint
-- What is still without a grantor: "nobody" for identity-provider accounts and the bootstrap
-- administrator, "unknown" for everything else.
UPDATE "tenant_role_bindings" b SET "grantor_unknown" = true
WHERE b."granted_by" IS NULL AND NOT EXISTS (
	SELECT 1 FROM "users" u WHERE u."id" = b."user_id" AND (
		(b."source" = 'mirror' AND u."source" <> 'local')
		OR (b."source" = 'mirror' AND u."email" IN (SELECT l."target" FROM "audit_log" l WHERE l."action" = 'user.bootstrap'))));--> statement-breakpoint
UPDATE "team_members" b SET "grantor_unknown" = true
WHERE b."granted_by" IS NULL AND NOT EXISTS (
	SELECT 1 FROM "users" u WHERE u."id" = b."user_id" AND (
		u."source" <> 'local'
		OR u."email" IN (SELECT l."target" FROM "audit_log" l WHERE l."action" = 'user.bootstrap')));--> statement-breakpoint
UPDATE "agent_role_bindings" b SET "grantor_unknown" = true WHERE b."granted_by" IS NULL;--> statement-breakpoint
ALTER TABLE "tenant_role_bindings" ENABLE TRIGGER "authz_epoch_trb_upd";--> statement-breakpoint
ALTER TABLE "team_members" ENABLE TRIGGER "authz_epoch_team_members_trg";--> statement-breakpoint
ALTER TABLE "agent_role_bindings" ENABLE TRIGGER "authz_epoch_agent_role_bindings_trg";--> statement-breakpoint
CREATE OR REPLACE FUNCTION "oax_mark_grantor_unknown"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	UPDATE "tenant_role_bindings" SET "grantor_unknown" = true WHERE "granted_by" = OLD."id";
	UPDATE "team_members" SET "grantor_unknown" = true WHERE "granted_by" = OLD."id";
	UPDATE "agent_role_bindings" SET "grantor_unknown" = true WHERE "granted_by" = OLD."id";
	RETURN OLD;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "users_mark_grantor_unknown" ON "users";--> statement-breakpoint
CREATE TRIGGER "users_mark_grantor_unknown" BEFORE DELETE ON "users" FOR EACH ROW EXECUTE FUNCTION "oax_mark_grantor_unknown"();--> statement-breakpoint
-- The home-move trigger of 0030, unchanged except that the rows it creates have an unknown grantor.
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
		INSERT INTO "tenant_role_bindings" ("id", "user_id", "tenant_id", "role", "inherit", "source", "grantor_unknown")
			SELECT gen_random_uuid(), NEW."id", NEW."tenant_id", r."role", false, 'mirror', true
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
