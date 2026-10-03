-- Least-privilege database roles for openagentix (run once as a superuser / owner).
-- The migration role owns the schema; the application role cannot UPDATE/DELETE/TRUNCATE the
-- revision-safe tables. The triggers from migration 0001 are a second line of defence.

CREATE ROLE openagentix_migrator LOGIN PASSWORD 'change-me';
CREATE ROLE openagentix_app LOGIN PASSWORD 'change-me';

GRANT CONNECT ON DATABASE openagentix TO openagentix_app;
GRANT USAGE ON SCHEMA public TO openagentix_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO openagentix_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO openagentix_app;

REVOKE UPDATE, DELETE, TRUNCATE ON audit_log, audit_checkpoints, agent_versions FROM openagentix_app;

ALTER DEFAULT PRIVILEGES FOR ROLE openagentix_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO openagentix_app;
