ALTER TABLE "mcp_oauth_tokens" ADD COLUMN "grant_type" text DEFAULT 'client_credentials' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_oauth_tokens" ADD COLUMN "endpoints" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_oauth_tokens" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "mcp_oauth_tokens" ADD CONSTRAINT "mcp_oauth_tokens_grant" CHECK ("mcp_oauth_tokens"."grant_type" in ('client_credentials', 'authorization_code'));