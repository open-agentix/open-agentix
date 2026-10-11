CREATE TABLE "mcp_oauth_pending" (
	"id" uuid PRIMARY KEY NOT NULL,
	"state_hash" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"credential_version" integer NOT NULL,
	"user_id" uuid NOT NULL,
	"nonce_hash" text NOT NULL,
	"issuer" text NOT NULL,
	"resource" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"client_ref" text NOT NULL,
	"registration" text NOT NULL,
	"scopes" text DEFAULT '' NOT NULL,
	"key_version" integer NOT NULL,
	"verifier_enc" text NOT NULL,
	"endpoints" jsonb NOT NULL,
	"signing_algs" text,
	"iss_advertised" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "mcp_oauth_pending_registration" CHECK ("mcp_oauth_pending"."registration" in ('preregistered', 'cimd', 'dcr'))
);
--> statement-breakpoint
ALTER TABLE "mcp_oauth_clients" ADD COLUMN "redirect_uri" text;--> statement-breakpoint
ALTER TABLE "mcp_oauth_tokens" ADD COLUMN "required_scopes" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_oauth_pending" ADD CONSTRAINT "mcp_oauth_pending_connection_tenant_fk" FOREIGN KEY ("connection_id","tenant_id") REFERENCES "public"."connections"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_pending_state_uq" ON "mcp_oauth_pending" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "mcp_oauth_pending_connection_idx" ON "mcp_oauth_pending" USING btree ("connection_id","user_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_pending_expires_idx" ON "mcp_oauth_pending" USING btree ("expires_at");