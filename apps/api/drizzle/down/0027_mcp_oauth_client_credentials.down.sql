-- Reverts 0027_mcp_oauth_client_credentials.sql (ADR 0016 slice S6, #236).
-- Not part of the drizzle journal: run it by hand (psql) after rolling the application back, then
-- delete the row of migration 0027 from drizzle.__drizzle_migrations.
-- Drops the pinned authorization server endpoints, the grant type and the last error code of the
-- stored MCP OAuth tokens. Stored tokens stay readable; a connection authorized with this slice
-- has to be authorized again by the build that follows the rollback (it never reads the pin).
BEGIN;
ALTER TABLE "mcp_oauth_tokens" DROP CONSTRAINT IF EXISTS "mcp_oauth_tokens_grant";
ALTER TABLE "mcp_oauth_tokens" DROP COLUMN IF EXISTS "last_error";
ALTER TABLE "mcp_oauth_tokens" DROP COLUMN IF EXISTS "endpoints";
ALTER TABLE "mcp_oauth_tokens" DROP COLUMN IF EXISTS "grant_type";
COMMIT;
