-- Reverts 0039_agent_version_awp.sql (AWP-3b).
-- Not part of the drizzle journal: run it by hand (psql) after rolling the application back, then
-- delete the row of migration 0039 from drizzle.__drizzle_migrations. It DROPS agent_version_awp: the
-- stored effective AWP manifests and the `legacy-unconvertible` markers are lost. agent_versions
-- (source, digest, definition) is not touched, so every agent keeps working; the conversion can be run
-- again by applying the migration. An application version before this slice ignores the table.
DROP TRIGGER IF EXISTS agent_version_awp_no_truncate ON agent_version_awp;
DROP TRIGGER IF EXISTS agent_version_awp_append_only ON agent_version_awp;
DROP TABLE IF EXISTS "agent_version_awp";
