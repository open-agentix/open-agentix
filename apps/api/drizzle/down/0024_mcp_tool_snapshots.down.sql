-- Reverts 0024_mcp_tool_snapshots.sql (ADR 0016 slice S3, #233).
-- Not part of the drizzle journal: run it by hand (psql) after rolling the application back, then
-- delete the row of migration 0024 from drizzle.__drizzle_migrations.
-- Loses every tool snapshot, review decision and acceptance. Published versions keep a `toolPins`
-- record in their definition; a version of this build rolled back to an older one simply ignores it
-- (the older build does not check tool digests), and publishing again after the rollback works
-- without a snapshot. Re-applying 0024 starts with no snapshots: connections must be refreshed and
-- approved again before the next publish.
BEGIN;
DROP TABLE IF EXISTS "mcp_tool_snapshot_acceptances";
DROP TABLE IF EXISTS "mcp_tool_snapshots";
COMMIT;
