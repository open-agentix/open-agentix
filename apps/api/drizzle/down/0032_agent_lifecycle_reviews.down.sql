-- Reverts 0032_agent_lifecycle_reviews.sql (ADR 0017 slice S1).
-- Not part of the drizzle journal: run it by hand (psql) after rolling the application back, then
-- delete the row of migration 0032 from drizzle.__drizzle_migrations. It DELETES the draft
-- revisions, reviews and decisions and the stored lifecycle policies (tenants.settings); the
-- agents, their drafts and their published versions are untouched. An application version before
-- this slice ignores all of it.
DROP TRIGGER IF EXISTS agent_review_decisions_consistency ON agent_review_decisions;
DROP TRIGGER IF EXISTS agent_reviews_consistency ON agent_reviews;
DROP TRIGGER IF EXISTS agent_draft_revisions_consistency ON agent_draft_revisions;
DROP TRIGGER IF EXISTS agent_review_decisions_append_only ON agent_review_decisions;
DROP TRIGGER IF EXISTS agent_draft_revisions_immutable ON agent_draft_revisions;
DROP TABLE IF EXISTS "agent_review_decisions";
DROP TABLE IF EXISTS "agent_reviews";
DROP TABLE IF EXISTS "agent_draft_revisions";
DROP FUNCTION IF EXISTS oax_agent_lifecycle_consistency();
ALTER TABLE "agent_role_bindings" DROP COLUMN IF EXISTS "granted_by";
ALTER TABLE "team_members" DROP COLUMN IF EXISTS "granted_by";
ALTER TABLE "agent_versions" DROP COLUMN IF EXISTS "revision_id";
ALTER TABLE "agents" DROP COLUMN IF EXISTS "draft_revision_id";
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "settings";
