-- ADR 0017 slice S2c (#356): the grant chain is stored on the row, not only read from the live bindings.
--
-- * grant_chain uuid[] on tenant_role_bindings, team_members, agent_role_bindings and users: every
--   user the grant (or the creation of the account) depended on when it was made, computed under the
--   binding lock by the application, plus every user who widened the binding later. Plain ids without
--   a foreign key, so a link that is revoked, expires or is deleted afterwards stays in the chain.
--   A row with `granted_by` set and no chain is **unknown** (fail closed).
-- * users.creator_unknown: "nobody made this account" (bootstrap, identity provider) versus "the
--   creator is not known" (created before the creator was recorded, creator deleted before a chain was
--   stored).
-- * Attribution of 0036 made strict: a role / membership counts as granted by the actor of an audit
--   entry only when the audit chain shows the grantee WITHOUT it before (a `user.created` /
--   `team.created` / `agent.created` entry that starts the chain, or an earlier entry that lacks it).
--   An attribution that cannot be shown that way becomes unknown. Memberships and roles of identity
--   provider accounts that an administrator listed before are no longer "nobody".
-- Down path: drizzle/down/0037_stored_grant_chain.down.sql
ALTER TABLE "agent_role_bindings" ADD COLUMN "grant_chain" uuid[];--> statement-breakpoint
ALTER TABLE "team_members" ADD COLUMN "grant_chain" uuid[];--> statement-breakpoint
ALTER TABLE "tenant_role_bindings" ADD COLUMN "grant_chain" uuid[];--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "grant_chain" uuid[];--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "creator_unknown" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- The grantor columns are not read by the resolver: keep the authz epoch where it is.
ALTER TABLE "tenant_role_bindings" DISABLE TRIGGER "authz_epoch_trb_upd";--> statement-breakpoint
ALTER TABLE "team_members" DISABLE TRIGGER "authz_epoch_team_members_trg";--> statement-breakpoint
ALTER TABLE "agent_role_bindings" DISABLE TRIGGER "authz_epoch_agent_role_bindings_trg";--> statement-breakpoint
CREATE FUNCTION "oax_tmp_uuid"(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
	SELECT CASE WHEN p ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN p::uuid END
$$;--> statement-breakpoint
-- The actor who put `p_role` into `users.global_roles` of `p_user`, or null when the audit chain does
-- not show it. The earliest entry that lists the role after the last one that does not; it counts
-- only when the chain shows the role absent before it (the entry is `user.created`, or an earlier
-- entry lists the roles without it). A role that was never absent in the chain, or a chain that
-- starts mid-way, is not attributed.
CREATE FUNCTION "oax_tmp_mirror_actor"(p_user uuid, p_role text) RETURNS uuid LANGUAGE plpgsql STABLE AS $$
DECLARE removed_at bigint; first_seq bigint; first_action text; first_actor text;
BEGIN
	SELECT max(r."seq") INTO removed_at FROM "audit_log" r
		WHERE r."action" IN ('user.created', 'user.updated') AND r."target" = p_user::text
			AND jsonb_exists(r."payload", 'globalRoles')
			AND NOT jsonb_path_exists(r."payload", '$.globalRoles[*] ? (@ == $r)', jsonb_build_object('r', p_role));
	SELECT a."seq", a."action", a."actor" INTO first_seq, first_action, first_actor FROM "audit_log" a
		WHERE a."action" IN ('user.created', 'user.updated') AND a."target" = p_user::text
			AND jsonb_exists(a."payload", 'globalRoles')
			AND jsonb_path_exists(a."payload", '$.globalRoles[*] ? (@ == $r)', jsonb_build_object('r', p_role))
			AND a."seq" > coalesce(removed_at, 0)
		ORDER BY a."seq" LIMIT 1;
	IF first_seq IS NULL THEN RETURN NULL; END IF;
	IF first_action <> 'user.created' AND removed_at IS NULL THEN RETURN NULL; END IF;
	RETURN oax_tmp_uuid(first_actor);
END;
$$;--> statement-breakpoint
-- Same for `team.members.set` / `agent.members.set` (the full member list is replaced each time).
-- The chain must show the membership absent before: an earlier list without it, or the creation of
-- the team / agent.
CREATE FUNCTION "oax_tmp_set_actor"(p_action text, p_created text, p_target uuid, p_user uuid, p_role text) RETURNS uuid LANGUAGE plpgsql STABLE AS $$
DECLARE removed_at bigint; first_seq bigint; first_actor text;
BEGIN
	SELECT max(r."seq") INTO removed_at FROM "audit_log" r
		WHERE r."action" = p_action AND r."target" = p_target::text
			AND NOT jsonb_path_exists(r."payload", '$.members[*] ? (@.userId == $u && @.role == $r)',
				jsonb_build_object('u', p_user::text, 'r', p_role));
	SELECT a."seq", a."actor" INTO first_seq, first_actor FROM "audit_log" a
		WHERE a."action" = p_action AND a."target" = p_target::text
			AND jsonb_path_exists(a."payload", '$.members[*] ? (@.userId == $u && @.role == $r)',
				jsonb_build_object('u', p_user::text, 'r', p_role))
			AND a."seq" > coalesce(removed_at, 0)
		ORDER BY a."seq" LIMIT 1;
	IF first_seq IS NULL THEN RETURN NULL; END IF;
	IF removed_at IS NULL AND NOT EXISTS (
		SELECT 1 FROM "audit_log" c WHERE c."action" = p_created AND c."target" = p_target::text AND c."seq" < first_seq
	) THEN RETURN NULL; END IF;
	RETURN oax_tmp_uuid(first_actor);
END;
$$;--> statement-breakpoint
-- Re-check what 0036 attributed: a grantor the strict rule cannot reproduce becomes unknown.
UPDATE "tenant_role_bindings" b SET "granted_by" = NULL, "grantor_unknown" = true
WHERE b."source" = 'mirror' AND b."use_case" IS NULL AND b."granted_by" IS NOT NULL
	AND EXISTS (SELECT 1 FROM "users" u WHERE u."id" = b."user_id" AND u."source" = 'local')
	AND oax_tmp_mirror_actor(b."user_id", b."role") IS DISTINCT FROM b."granted_by";--> statement-breakpoint
UPDATE "team_members" m SET "granted_by" = NULL, "grantor_unknown" = true
WHERE m."granted_by" IS NOT NULL
	AND oax_tmp_set_actor('team.members.set', 'team.created', m."team_id", m."user_id", m."role") IS DISTINCT FROM m."granted_by";--> statement-breakpoint
UPDATE "agent_role_bindings" m SET "granted_by" = NULL, "grantor_unknown" = true
WHERE m."granted_by" IS NOT NULL
	AND oax_tmp_set_actor('agent.members.set', 'agent.created', m."agent_id", m."user_id", m."role") IS DISTINCT FROM m."granted_by";--> statement-breakpoint
-- "Nobody" is only right for rows the audit chain never shows an administrator setting: an
-- identity-provider account whose role or membership an administrator listed before is unknown.
UPDATE "tenant_role_bindings" b SET "grantor_unknown" = true
WHERE b."source" = 'mirror' AND b."use_case" IS NULL AND b."granted_by" IS NULL AND NOT b."grantor_unknown"
	AND EXISTS (SELECT 1 FROM "users" u WHERE u."id" = b."user_id" AND u."source" <> 'local'
		AND u."email" NOT IN (SELECT l."target" FROM "audit_log" l WHERE l."action" = 'user.bootstrap'))
	AND EXISTS (SELECT 1 FROM "audit_log" a WHERE a."action" IN ('user.created', 'user.updated')
		AND a."target" = b."user_id"::text AND jsonb_exists(a."payload", 'globalRoles')
		AND jsonb_path_exists(a."payload", '$.globalRoles[*] ? (@ == $r)', jsonb_build_object('r', b."role")));--> statement-breakpoint
UPDATE "team_members" m SET "grantor_unknown" = true
WHERE m."granted_by" IS NULL AND NOT m."grantor_unknown"
	AND EXISTS (SELECT 1 FROM "users" u WHERE u."id" = m."user_id" AND u."source" <> 'local'
		AND u."email" NOT IN (SELECT l."target" FROM "audit_log" l WHERE l."action" = 'user.bootstrap'))
	AND EXISTS (SELECT 1 FROM "audit_log" a WHERE a."action" = 'team.members.set' AND a."target" = m."team_id"::text
		AND jsonb_path_exists(a."payload", '$.members[*] ? (@.userId == $u && @.role == $r)',
			jsonb_build_object('u', m."user_id"::text, 'r', m."role")));--> statement-breakpoint
-- The chain of every row whose grantor is known is that grantor. The links further up are added by
-- the live walk at decision time, as before; rows granted from now on carry the full chain.
UPDATE "tenant_role_bindings" SET "grant_chain" = ARRAY["granted_by"] WHERE "granted_by" IS NOT NULL;--> statement-breakpoint
UPDATE "team_members" SET "grant_chain" = ARRAY["granted_by"] WHERE "granted_by" IS NOT NULL;--> statement-breakpoint
UPDATE "agent_role_bindings" SET "grant_chain" = ARRAY["granted_by"] WHERE "granted_by" IS NOT NULL;--> statement-breakpoint
UPDATE "users" SET "grant_chain" = ARRAY["created_by"] WHERE "created_by" IS NOT NULL;--> statement-breakpoint
-- A local account nobody is shown to have made (not the bootstrap administrator) has an unknown creator.
UPDATE "users" u SET "creator_unknown" = true
WHERE u."created_by" IS NULL AND u."source" = 'local'
	AND u."email" NOT IN (SELECT l."target" FROM "audit_log" l WHERE l."action" = 'user.bootstrap');--> statement-breakpoint
DROP FUNCTION "oax_tmp_set_actor"(text, text, uuid, uuid, text);--> statement-breakpoint
DROP FUNCTION "oax_tmp_mirror_actor"(uuid, text);--> statement-breakpoint
DROP FUNCTION "oax_tmp_uuid"(text);--> statement-breakpoint
ALTER TABLE "tenant_role_bindings" ENABLE TRIGGER "authz_epoch_trb_upd";--> statement-breakpoint
ALTER TABLE "team_members" ENABLE TRIGGER "authz_epoch_team_members_trg";--> statement-breakpoint
ALTER TABLE "agent_role_bindings" ENABLE TRIGGER "authz_epoch_agent_role_bindings_trg";--> statement-breakpoint
-- Deleting a user: the rows it granted (and the accounts it made) keep the id in their stored chain,
-- so they stay attributable; only rows without a stored chain become unknown.
CREATE OR REPLACE FUNCTION "oax_mark_grantor_unknown"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	UPDATE "tenant_role_bindings" SET "grantor_unknown" = true WHERE "granted_by" = OLD."id" AND "grant_chain" IS NULL;
	UPDATE "team_members" SET "grantor_unknown" = true WHERE "granted_by" = OLD."id" AND "grant_chain" IS NULL;
	UPDATE "agent_role_bindings" SET "grantor_unknown" = true WHERE "granted_by" = OLD."id" AND "grant_chain" IS NULL;
	UPDATE "users" SET "creator_unknown" = true WHERE "created_by" = OLD."id" AND "grant_chain" IS NULL;
	RETURN OLD;
END;
$$;
