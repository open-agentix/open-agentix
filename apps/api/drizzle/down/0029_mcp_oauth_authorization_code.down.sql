-- Reverts 0029_mcp_oauth_authorization_code.sql (ADR 0016 slice S7, #237).
-- Not part of the drizzle journal: run it by hand (psql) after rolling the application back, then
-- delete the row of migration 0029 from drizzle.__drizzle_migrations.
-- Drops the pending authorization requests (they only live for 10 minutes), the redirect URI of
-- dynamically registered clients and the step-up scopes of stored tokens. Stored tokens stay
-- readable; an authorization-code connection authorized with this slice is renewed by the build
-- before it only while its access token or refresh token lasts.
BEGIN;
DROP TABLE IF EXISTS "mcp_oauth_pending";
ALTER TABLE "mcp_oauth_tokens" DROP COLUMN IF EXISTS "required_scopes";
ALTER TABLE "mcp_oauth_clients" DROP COLUMN IF EXISTS "redirect_uri";
COMMIT;
