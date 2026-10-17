-- Reverts 0038_agent_publish_gate.sql (ADR 0017 slice S3, #246).
-- Not part of the drizzle journal: run it by hand (psql) after rolling the application back, then
-- delete the row of migration 0038 from drizzle.__drizzle_migrations. It DROPS the approval record
-- of every published version (review, approvers, digests, pinned secret resolution), the link from a
-- review to the version it ended in and ALL version deprecations: a deprecated version accepts pinned
-- runs again, and agents.latest_version_id keeps pointing where the rollbacks left it. The reviews,
-- decisions and versions themselves stay. Run it before the down scripts of 0037, 0034 and 0032.
DROP TRIGGER IF EXISTS agent_version_deprecations_no_truncate ON agent_version_deprecations;
DROP TRIGGER IF EXISTS agent_version_deprecations_append_only ON agent_version_deprecations;
DROP TABLE IF EXISTS agent_version_deprecations;
ALTER TABLE agent_reviews DROP CONSTRAINT IF EXISTS agent_reviews_published_check;
ALTER TABLE agent_reviews DROP COLUMN IF EXISTS published_version_id;
DROP INDEX IF EXISTS agent_versions_review_uq;
ALTER TABLE agent_versions DROP CONSTRAINT IF EXISTS agent_versions_approval_check;
ALTER TABLE agent_versions DROP COLUMN IF EXISTS secret_resolution;
ALTER TABLE agent_versions DROP COLUMN IF EXISTS resolution_digest;
ALTER TABLE agent_versions DROP COLUMN IF EXISTS expansion_digest;
ALTER TABLE agent_versions DROP COLUMN IF EXISTS policy_digest;
ALTER TABLE agent_versions DROP COLUMN IF EXISTS approved_by;
ALTER TABLE agent_versions DROP COLUMN IF EXISTS review_id;
