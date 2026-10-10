-- Reverts 0026_mcp_oauth_tokens.sql (ADR 0016 slice S5, #235).
-- Not part of the drizzle journal: run it by hand (psql) after rolling the application back, then
-- delete the row of migration 0026 from drizzle.__drizzle_migrations.
-- Loses every stored MCP OAuth token and dynamically registered client, and the wrapped tenant data
-- keys: sealed values cannot be recovered afterwards, even by re-applying 0026 (a new data key is
-- created on first use). Connections must be authorized again. An older build never reads these tables.
BEGIN;
DROP TABLE IF EXISTS "mcp_oauth_tokens";
DROP TABLE IF EXISTS "mcp_oauth_clients";
DROP TABLE IF EXISTS "tenant_data_keys";
COMMIT;
