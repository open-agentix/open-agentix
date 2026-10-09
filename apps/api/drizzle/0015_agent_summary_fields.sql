ALTER TABLE "agents" ADD COLUMN "use_case" text;--> statement-breakpoint
UPDATE "agents" SET "use_case" = nullif("agent_versions"."definition"->'labels'->>'useCase', '') FROM "agent_versions" WHERE "agent_versions"."id" = "agents"."latest_version_id";--> statement-breakpoint
UPDATE "agents" SET "use_case" = nullif(btrim(substring("draft_source" from '(?m)^[ \t]+useCase:[ \t]*["'']?([^"''\r\n#]*)')), '') WHERE "latest_version_id" IS NULL;--> statement-breakpoint
CREATE INDEX "agents_tenant_created_idx" ON "agents" USING btree ("tenant_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "agents_tenant_use_case_idx" ON "agents" USING btree ("tenant_id","use_case" text_pattern_ops);
