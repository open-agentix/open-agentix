ALTER TABLE "agents" DROP CONSTRAINT "agents_name_unique";--> statement-breakpoint
ALTER TABLE "connections" DROP CONSTRAINT "connections_name_unique";--> statement-breakpoint
ALTER TABLE "event_sources" DROP CONSTRAINT "event_sources_name_unique";--> statement-breakpoint
ALTER TABLE "policies" DROP CONSTRAINT "policies_name_unique";--> statement-breakpoint
ALTER TABLE "teams" DROP CONSTRAINT "teams_slug_unique";--> statement-breakpoint
ALTER TABLE "connections" ALTER COLUMN "scope" SET DEFAULT 'tenant';--> statement-breakpoint
ALTER TABLE "policies" ADD COLUMN "scope" text DEFAULT 'tenant' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "platform_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_tenant_name_uq" ON "agents" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "connections_tenant_name_uq" ON "connections" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "event_sources_tenant_name_uq" ON "event_sources" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "policies_tenant_name_uq" ON "policies" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_tenant_slug_uq" ON "teams" USING btree ("tenant_id","slug");
--> statement-breakpoint
UPDATE "connections" SET "scope" = 'tenant' WHERE "scope" = 'platform' AND "kind" = 'mcp';--> statement-breakpoint
UPDATE "users" SET "platform_admin" = true WHERE 'admin' = ANY("global_roles");
