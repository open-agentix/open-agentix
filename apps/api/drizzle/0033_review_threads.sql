CREATE TABLE "agent_review_comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "agent_review_comments_body_len" CHECK (char_length("agent_review_comments"."body") <= 10000),
	CONSTRAINT "agent_review_comments_deleted_check" CHECK (("agent_review_comments"."deleted_at" is null and char_length("agent_review_comments"."body") > 0) or ("agent_review_comments"."deleted_at" is not null and "agent_review_comments"."body" = ''))
);
--> statement-breakpoint
CREATE TABLE "agent_review_threads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"review_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"anchor_kind" text NOT NULL,
	"revision_id" uuid,
	"side" text,
	"line" integer,
	"line_hash" text,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_review_threads_kind_check" CHECK ("agent_review_threads"."anchor_kind" in ('review','line')),
	CONSTRAINT "agent_review_threads_anchor_check" CHECK (("agent_review_threads"."anchor_kind" = 'review' and "agent_review_threads"."revision_id" is null and "agent_review_threads"."side" is null and "agent_review_threads"."line" is null and "agent_review_threads"."line_hash" is null)
        or ("agent_review_threads"."anchor_kind" = 'line' and "agent_review_threads"."side" is not null and "agent_review_threads"."side" in ('base','head') and "agent_review_threads"."line" is not null and "agent_review_threads"."line" between 1 and 100000 and "agent_review_threads"."line_hash" is not null and "agent_review_threads"."line_hash" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "agent_review_threads_resolved_check" CHECK (("agent_review_threads"."resolved_at" is null) = ("agent_review_threads"."resolved_by" is null))
);
--> statement-breakpoint
ALTER TABLE "agent_review_comments" ADD CONSTRAINT "agent_review_comments_thread_id_agent_review_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."agent_review_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_review_comments" ADD CONSTRAINT "agent_review_comments_review_id_agent_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."agent_reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_review_comments" ADD CONSTRAINT "agent_review_comments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_review_threads" ADD CONSTRAINT "agent_review_threads_review_id_agent_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."agent_reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_review_threads" ADD CONSTRAINT "agent_review_threads_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_review_threads" ADD CONSTRAINT "agent_review_threads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_review_threads" ADD CONSTRAINT "agent_review_threads_revision_id_agent_draft_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."agent_draft_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_review_comments_thread_idx" ON "agent_review_comments" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_review_comments_author_idx" ON "agent_review_comments" USING btree ("author_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_review_threads_review_idx" ON "agent_review_threads" USING btree ("review_id","created_at");