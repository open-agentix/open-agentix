-- ADR 0016 / slice S3 (#233): pinned MCP tool definitions. Additive: two new tables, no change to
-- an existing one, no backfill (a connection without a snapshot behaves exactly as before; the
-- first refresh creates one). Down path: drizzle/down/0024_mcp_tool_snapshots.down.sql
-- * mcp_tool_snapshots: one row per (connection, digest) with the reduced tool definitions, the
--   review status (pending | approved | rejected) and who decided. Bounded: at most 500 tools,
--   `tool_count` must match. `tenant_id` is the tenant that owns the connection.
-- * mcp_tool_snapshot_acceptances: the connection-level record of an `existing-versions` approval
--   (published versions that pinned `from_digest` accept `to_digest`).
-- Both cascade with the connection.
CREATE TABLE "mcp_tool_snapshot_acceptances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL,
	"connection_id" uuid NOT NULL,
	"from_digest" text NOT NULL,
	"to_digest" text NOT NULL,
	"accepted_by" uuid,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_tool_snapshot_acceptances_digests" CHECK ("mcp_tool_snapshot_acceptances"."from_digest" ~ '^[0-9a-f]{64}$' and "mcp_tool_snapshot_acceptances"."to_digest" ~ '^[0-9a-f]{64}$' and "mcp_tool_snapshot_acceptances"."from_digest" <> "mcp_tool_snapshot_acceptances"."to_digest")
);
--> statement-breakpoint
CREATE TABLE "mcp_tool_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL,
	"connection_id" uuid NOT NULL,
	"digest" text NOT NULL,
	"tools" jsonb NOT NULL,
	"tool_count" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"source" text DEFAULT 'refresh' NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fetched_by" uuid,
	"run_id" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"approval_scope" text,
	"rejected_by" uuid,
	"rejected_at" timestamp with time zone,
	CONSTRAINT "mcp_tool_snapshots_status" CHECK ("mcp_tool_snapshots"."status" in ('pending', 'approved', 'rejected')),
	CONSTRAINT "mcp_tool_snapshots_source" CHECK ("mcp_tool_snapshots"."source" in ('refresh', 'run')),
	CONSTRAINT "mcp_tool_snapshots_scope" CHECK ("mcp_tool_snapshots"."approval_scope" is null or "mcp_tool_snapshots"."approval_scope" in ('new-versions', 'existing-versions')),
	CONSTRAINT "mcp_tool_snapshots_digest" CHECK ("mcp_tool_snapshots"."digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "mcp_tool_snapshots_tools" CHECK (jsonb_typeof("mcp_tool_snapshots"."tools") = 'array' and jsonb_array_length("mcp_tool_snapshots"."tools") <= 500 and "mcp_tool_snapshots"."tool_count" = jsonb_array_length("mcp_tool_snapshots"."tools"))
);
--> statement-breakpoint
ALTER TABLE "mcp_tool_snapshot_acceptances" ADD CONSTRAINT "mcp_tool_snapshot_acceptances_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tool_snapshots" ADD CONSTRAINT "mcp_tool_snapshots_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_tool_snapshot_acceptances_uq" ON "mcp_tool_snapshot_acceptances" USING btree ("connection_id","from_digest","to_digest");--> statement-breakpoint
CREATE INDEX "mcp_tool_snapshot_acceptances_tenant_idx" ON "mcp_tool_snapshot_acceptances" USING btree ("tenant_id","connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_tool_snapshots_connection_digest_uq" ON "mcp_tool_snapshots" USING btree ("connection_id","digest");--> statement-breakpoint
CREATE INDEX "mcp_tool_snapshots_tenant_connection_idx" ON "mcp_tool_snapshots" USING btree ("tenant_id","connection_id","status");
