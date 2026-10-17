-- AWP-3b (decision D13): the effective AWP manifest of a published version is stored next to it.
--
-- * agent_version_awp holds one row per version: `converted` (strict conversion of the stored
--   definition, with its digest) or `legacy-unconvertible` (no manifest, the refusals field by field).
--   It never touches agent_versions: source, digest and definition of a published version stay as
--   they are (that table is append-only, trigger and role).
-- * The rows are written by the application: this migration creates the empty table, and the
--   one-time conversion of every existing version runs right after it (`oax-api db:migrate` and
--   migrate-on-start), per agent in its own transaction, idempotent (a version with a row is
--   skipped). The conversion needs the exporter, which is not SQL. Until it ran, a version without a
--   row is converted on read and not stored.
-- * The table is append-only (trigger below, and no UPDATE/DELETE for the application role in
--   deploy/sql/roles.sql): a version is converted once.
-- Down path: drizzle/down/0038_agent_version_awp.down.sql
CREATE TABLE "agent_version_awp" (
	"version_id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"status" text NOT NULL,
	"manifest" jsonb,
	"manifest_digest" text,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"converter" text NOT NULL,
	"converted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_version_awp_status" CHECK ("agent_version_awp"."status" in ('converted', 'legacy-unconvertible')),
	CONSTRAINT "agent_version_awp_shape" CHECK (("agent_version_awp"."status" = 'converted' and "agent_version_awp"."manifest" is not null and "agent_version_awp"."manifest_digest" is not null)
        or ("agent_version_awp"."status" = 'legacy-unconvertible' and "agent_version_awp"."manifest" is null and "agent_version_awp"."manifest_digest" is null))
);
--> statement-breakpoint
ALTER TABLE "agent_version_awp" ADD CONSTRAINT "agent_version_awp_version_id_agent_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."agent_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_version_awp" ADD CONSTRAINT "agent_version_awp_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_version_awp_agent_idx" ON "agent_version_awp" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_version_awp_status_idx" ON "agent_version_awp" USING btree ("status","agent_id");;--> statement-breakpoint
CREATE TRIGGER agent_version_awp_append_only BEFORE UPDATE OR DELETE ON agent_version_awp FOR EACH ROW EXECUTE FUNCTION oax_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER agent_version_awp_no_truncate BEFORE TRUNCATE ON agent_version_awp FOR EACH STATEMENT EXECUTE FUNCTION oax_forbid_mutation();
