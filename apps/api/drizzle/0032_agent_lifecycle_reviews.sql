-- ADR 0017 S1: lifecycle policy, draft revisions, reviews and approval records (API only, shadow
-- mode). Additive; the down path is drizzle/down/0032_agent_lifecycle_reviews.down.sql.
--
-- tenants.settings holds what a node stores itself (settings.agentLifecycle, narrowing only);
-- agent_draft_revisions are immutable snapshots of a draft with their author; agent_reviews and
-- agent_review_decisions record who decided what on which digests (append-only). team_members and
-- agent_role_bindings gain granted_by, so that rule A4 can tell a binding a contributor created
-- (NULL = not recorded, for example rows from before this migration). The revision of an existing
-- agent (author unknown) is created by the application at start-up, not here: its digest is the
-- digest of the normalised source, which only the application computes.
CREATE TABLE "agent_draft_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"digest" text NOT NULL,
	"source" text NOT NULL,
	"author_id" uuid,
	"author_kind" text NOT NULL,
	"parent_id" uuid,
	"source_commit" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_draft_revisions_author_kind" CHECK ("agent_draft_revisions"."author_kind" in ('user','repo','system')),
	CONSTRAINT "agent_draft_revisions_author_check" CHECK (("agent_draft_revisions"."author_kind" = 'user' and "agent_draft_revisions"."author_id" is not null) or "agent_draft_revisions"."author_kind" <> 'user'),
	CONSTRAINT "agent_draft_revisions_digest_check" CHECK ("agent_draft_revisions"."digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "agent_review_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"review_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"digest" text NOT NULL,
	"expansion_digest" text NOT NULL,
	"resolution_digest" text NOT NULL,
	"base_version_id" uuid,
	"policy_digest" text NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"reviewer_auth" text NOT NULL,
	"acting_tenant_id" uuid NOT NULL,
	"binding_refs" jsonb NOT NULL,
	"decision" text NOT NULL,
	"comment" text,
	"satisfies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "agent_review_decisions_decision_check" CHECK ("agent_review_decisions"."decision" in ('approve','request_changes','reject')),
	CONSTRAINT "agent_review_decisions_comment_len" CHECK (char_length("agent_review_decisions"."comment") <= 10000),
	CONSTRAINT "agent_review_decisions_expiry_check" CHECK (("agent_review_decisions"."decision" = 'approve') = ("agent_review_decisions"."expires_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "agent_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"opened_by" uuid NOT NULL,
	"opened_revision_id" uuid NOT NULL,
	"base_version_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"policy_snapshot" jsonb NOT NULL,
	"policy_digest" text NOT NULL,
	"required_approvals" integer NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	CONSTRAINT "agent_reviews_status_check" CHECK ("agent_reviews"."status" in ('open','withdrawn','rejected','published')),
	CONSTRAINT "agent_reviews_required_check" CHECK ("agent_reviews"."required_approvals" between 1 and 5),
	CONSTRAINT "agent_reviews_closed_check" CHECK (("agent_reviews"."status" = 'open') = ("agent_reviews"."closed_at" is null))
);
--> statement-breakpoint
ALTER TABLE "agent_role_bindings" ADD COLUMN "granted_by" uuid;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD COLUMN "revision_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "draft_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "team_members" ADD COLUMN "granted_by" uuid;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_draft_revisions" ADD CONSTRAINT "agent_draft_revisions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_draft_revisions" ADD CONSTRAINT "agent_draft_revisions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_review_decisions" ADD CONSTRAINT "agent_review_decisions_review_id_agent_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."agent_reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_review_decisions" ADD CONSTRAINT "agent_review_decisions_revision_id_agent_draft_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."agent_draft_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_review_decisions" ADD CONSTRAINT "agent_review_decisions_base_version_id_agent_versions_id_fk" FOREIGN KEY ("base_version_id") REFERENCES "public"."agent_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_reviews" ADD CONSTRAINT "agent_reviews_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_reviews" ADD CONSTRAINT "agent_reviews_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_reviews" ADD CONSTRAINT "agent_reviews_opened_revision_id_agent_draft_revisions_id_fk" FOREIGN KEY ("opened_revision_id") REFERENCES "public"."agent_draft_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_reviews" ADD CONSTRAINT "agent_reviews_base_version_id_agent_versions_id_fk" FOREIGN KEY ("base_version_id") REFERENCES "public"."agent_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_draft_revisions_agent_seq_uq" ON "agent_draft_revisions" USING btree ("agent_id","seq");--> statement-breakpoint
CREATE INDEX "agent_draft_revisions_agent_digest_idx" ON "agent_draft_revisions" USING btree ("agent_id","digest");--> statement-breakpoint
CREATE INDEX "agent_review_decisions_review_idx" ON "agent_review_decisions" USING btree ("review_id","decided_at");--> statement-breakpoint
CREATE INDEX "agent_review_decisions_reviewer_idx" ON "agent_review_decisions" USING btree ("review_id","reviewer_id","decided_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "agent_reviews_one_open_uq" ON "agent_reviews" USING btree ("agent_id") WHERE "agent_reviews"."status" = 'open';--> statement-breakpoint
CREATE INDEX "agent_reviews_agent_idx" ON "agent_reviews" USING btree ("agent_id","opened_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "agent_reviews_tenant_status_idx" ON "agent_reviews" USING btree ("tenant_id","status");--> statement-breakpoint
ALTER TABLE "agent_role_bindings" ADD CONSTRAINT "agent_role_bindings_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Immutability and consistency. oax_forbid_mutation() comes from migration 0001.
CREATE TRIGGER agent_draft_revisions_immutable BEFORE UPDATE ON agent_draft_revisions FOR EACH ROW EXECUTE FUNCTION oax_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER agent_review_decisions_append_only BEFORE UPDATE OR DELETE ON agent_review_decisions FOR EACH ROW EXECUTE FUNCTION oax_forbid_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION oax_agent_lifecycle_consistency() RETURNS trigger AS $$
DECLARE
	a_tenant uuid;
	r_agent uuid;
BEGIN
	IF TG_TABLE_NAME = 'agent_draft_revisions' THEN
		SELECT "tenant_id" INTO a_tenant FROM "agents" WHERE "id" = NEW."agent_id";
		IF a_tenant IS DISTINCT FROM NEW."tenant_id" THEN
			RAISE EXCEPTION 'revision tenant differs from the tenant of its agent' USING ERRCODE = 'integrity_constraint_violation';
		END IF;
	ELSIF TG_TABLE_NAME = 'agent_reviews' THEN
		IF TG_OP = 'UPDATE' THEN
			-- A closed review is final; the identity and the snapshot of an open one never change.
			IF OLD."status" <> 'open' THEN
				RAISE EXCEPTION 'a closed review cannot change' USING ERRCODE = 'insufficient_privilege';
			END IF;
			IF NEW."agent_id" <> OLD."agent_id" OR NEW."tenant_id" <> OLD."tenant_id" OR NEW."opened_by" <> OLD."opened_by"
				OR NEW."opened_revision_id" <> OLD."opened_revision_id" OR NEW."policy_digest" <> OLD."policy_digest"
				OR NEW."policy_snapshot" <> OLD."policy_snapshot" OR NEW."required_approvals" <> OLD."required_approvals"
				OR NEW."base_version_id" IS DISTINCT FROM OLD."base_version_id" THEN
				RAISE EXCEPTION 'the binding fields of a review cannot change' USING ERRCODE = 'insufficient_privilege';
			END IF;
			RETURN NEW;
		END IF;
		SELECT "tenant_id" INTO a_tenant FROM "agents" WHERE "id" = NEW."agent_id";
		IF a_tenant IS DISTINCT FROM NEW."tenant_id" THEN
			RAISE EXCEPTION 'review tenant differs from the tenant of its agent' USING ERRCODE = 'integrity_constraint_violation';
		END IF;
		SELECT "agent_id" INTO r_agent FROM "agent_draft_revisions" WHERE "id" = NEW."opened_revision_id";
		IF r_agent IS DISTINCT FROM NEW."agent_id" THEN
			RAISE EXCEPTION 'review revision belongs to another agent' USING ERRCODE = 'integrity_constraint_violation';
		END IF;
	ELSE
		SELECT "agent_id" INTO r_agent FROM "agent_reviews" WHERE "id" = NEW."review_id";
		IF r_agent IS DISTINCT FROM (SELECT "agent_id" FROM "agent_draft_revisions" WHERE "id" = NEW."revision_id") THEN
			RAISE EXCEPTION 'decision revision belongs to another agent than the review' USING ERRCODE = 'integrity_constraint_violation';
		END IF;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER agent_draft_revisions_consistency BEFORE INSERT ON agent_draft_revisions FOR EACH ROW EXECUTE FUNCTION oax_agent_lifecycle_consistency();
--> statement-breakpoint
CREATE TRIGGER agent_reviews_consistency BEFORE INSERT OR UPDATE ON agent_reviews FOR EACH ROW EXECUTE FUNCTION oax_agent_lifecycle_consistency();
--> statement-breakpoint
CREATE TRIGGER agent_review_decisions_consistency BEFORE INSERT ON agent_review_decisions FOR EACH ROW EXECUTE FUNCTION oax_agent_lifecycle_consistency();
