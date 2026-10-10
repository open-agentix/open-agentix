-- ADR 0016 / slice S4 (#234): single-use approvals for the MCP relay, and a marker for approvals
-- whose arguments the scrubber changed. Additive: two columns on "approvals".
-- * consumed_at: the relay consumes an approved approval atomically when it lets a call that needs
--   approval pass (a compromised run node must not replay one approval). Backfilled for every
--   approval that was already decided before the upgrade, so none of them can be used by the relay.
-- * args_redacted: true when the stored arguments differ from the call's because secrets were
--   replaced by [REDACTED]; shown to approvers. Old rows stay false (unknown).
-- Down path: drizzle/down/0025_approvals_consumed_at.down.sql
ALTER TABLE "approvals" ADD COLUMN "consumed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "args_redacted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "approvals" SET "consumed_at" = COALESCE("decided_at", now()) WHERE "status" <> 'pending';
