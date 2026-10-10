-- ADR 0016 / slice S4 (#234): single-use approvals for the MCP relay. Additive: one nullable column,
-- no backfill. The relay consumes an approved approval atomically when it lets a call that needs
-- approval pass (a compromised run node must not replay one approval); every other reader ignores it.
-- Down path: drizzle/down/0025_approvals_consumed_at.down.sql
ALTER TABLE "approvals" ADD COLUMN "consumed_at" timestamp with time zone;
