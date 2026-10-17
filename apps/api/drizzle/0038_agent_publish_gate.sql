-- ADR 0017 slice S3 (#246): approval becomes a gate at publish; version deprecation and rollback.
--
-- * agent_versions: review_id, approved_by[], policy_digest, expansion_digest, resolution_digest and
--   secret_resolution record what a version was published under (all null for a version published
--   while approval was not required, and for every version from before this migration). A review
--   approves at most one version. The table stays insert-only (trigger of migration 0001).
-- * agent_reviews.published_version_id: the version a review ended in (status 'published').
-- * agent_version_deprecations: append-only record of a deprecated version (and the version the agent
--   went back to when the deprecated version was the latest one).
-- * The two CHECK constraints are added NOT VALID and validated afterwards: validating takes only a
--   SHARE UPDATE EXCLUSIVE lock, so large installations do not hold an ACCESS EXCLUSIVE lock on
--   agent_reviews / agent_versions for a full scan.
-- Down path: drizzle/down/0038_agent_publish_gate.down.sql
CREATE TABLE "agent_version_deprecations" (
	"version_id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"deprecated_by" uuid NOT NULL,
	"deprecated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text,
	"rollback_to_version_id" uuid,
	CONSTRAINT "agent_version_deprecations_reason_len" CHECK (char_length("agent_version_deprecations"."reason") <= 500)
);
--> statement-breakpoint
ALTER TABLE "agent_reviews" ADD COLUMN "published_version_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD COLUMN "review_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD COLUMN "approved_by" uuid[];--> statement-breakpoint
ALTER TABLE "agent_versions" ADD COLUMN "policy_digest" text;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD COLUMN "expansion_digest" text;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD COLUMN "resolution_digest" text;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD COLUMN "secret_resolution" jsonb;--> statement-breakpoint
ALTER TABLE "agent_version_deprecations" ADD CONSTRAINT "agent_version_deprecations_version_id_agent_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."agent_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_version_deprecations" ADD CONSTRAINT "agent_version_deprecations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_version_deprecations" ADD CONSTRAINT "agent_version_deprecations_rollback_to_version_id_agent_versions_id_fk" FOREIGN KEY ("rollback_to_version_id") REFERENCES "public"."agent_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_version_deprecations_agent_idx" ON "agent_version_deprecations" USING btree ("agent_id","deprecated_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "agent_reviews" ADD CONSTRAINT "agent_reviews_published_version_id_agent_versions_id_fk" FOREIGN KEY ("published_version_id") REFERENCES "public"."agent_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_review_id_agent_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."agent_reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_versions_review_uq" ON "agent_versions" USING btree ("review_id") WHERE "agent_versions"."review_id" is not null;--> statement-breakpoint
ALTER TABLE "agent_reviews" ADD CONSTRAINT "agent_reviews_published_check" CHECK (("agent_reviews"."status" = 'published') = ("agent_reviews"."published_version_id" is not null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "agent_reviews" VALIDATE CONSTRAINT "agent_reviews_published_check";--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_approval_check" CHECK (("agent_versions"."review_id" is null) = ("agent_versions"."approved_by" is null) and ("agent_versions"."approved_by" is null or cardinality("agent_versions"."approved_by") >= 1)) NOT VALID;--> statement-breakpoint
ALTER TABLE "agent_versions" VALIDATE CONSTRAINT "agent_versions_approval_check";
--> statement-breakpoint
-- Deprecations are append-only; oax_forbid_mutation() comes from migration 0001.
CREATE TRIGGER agent_version_deprecations_append_only BEFORE UPDATE OR DELETE ON agent_version_deprecations FOR EACH ROW EXECUTE FUNCTION oax_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER agent_version_deprecations_no_truncate BEFORE TRUNCATE ON agent_version_deprecations FOR EACH STATEMENT EXECUTE FUNCTION oax_forbid_mutation();
