ALTER TABLE "run_node_sessions" ADD COLUMN "workspace_seed" text;--> statement-breakpoint
ALTER TABLE "run_node_sessions" ADD COLUMN "workspace_seed_sha256" text;--> statement-breakpoint
ALTER TABLE "run_node_sessions" ADD COLUMN "workspace_seed_fetched_at" timestamp with time zone;
