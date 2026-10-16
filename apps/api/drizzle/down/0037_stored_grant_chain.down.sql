-- Reverts 0037_stored_grant_chain.sql (ADR 0017 slice S2c, #356).
-- Not part of the drizzle journal: run it by hand (psql) after rolling the application back, then
-- delete the row of migration 0037 from drizzle.__drizzle_migrations. It DROPS grant_chain on
-- tenant_role_bindings, team_members, agent_role_bindings and users and users.creator_unknown: the
-- stored grant chains and the "creator unknown" marker are lost (rule A4 goes back to the live
-- chain). Rows that the migration turned into "grantor unknown" stay unknown; granted_by values stay.
-- It also drops agent_review_hold_clears (the released holds) and agent_reviews.closed_revision_id. The delete trigger goes back to the definition of 0036.
CREATE OR REPLACE FUNCTION "oax_mark_grantor_unknown"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	UPDATE "tenant_role_bindings" SET "grantor_unknown" = true WHERE "granted_by" = OLD."id";
	UPDATE "team_members" SET "grantor_unknown" = true WHERE "granted_by" = OLD."id";
	UPDATE "agent_role_bindings" SET "grantor_unknown" = true WHERE "granted_by" = OLD."id";
	RETURN OLD;
END;
$$;
DROP TABLE IF EXISTS "agent_review_hold_clears";
ALTER TABLE "agent_reviews" DROP COLUMN IF EXISTS "closed_revision_id";
ALTER TABLE "users" DROP COLUMN IF EXISTS "creator_unknown";
ALTER TABLE "users" DROP COLUMN IF EXISTS "grant_chain";
ALTER TABLE "agent_role_bindings" DROP COLUMN IF EXISTS "grant_chain";
ALTER TABLE "team_members" DROP COLUMN IF EXISTS "grant_chain";
ALTER TABLE "tenant_role_bindings" DROP COLUMN IF EXISTS "grant_chain";
