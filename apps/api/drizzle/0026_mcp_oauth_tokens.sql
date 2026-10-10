CREATE TABLE "mcp_oauth_clients" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL,
	"issuer" text NOT NULL,
	"registration" text DEFAULT 'dcr' NOT NULL,
	"client_id" text NOT NULL,
	"key_version" integer,
	"client_secret_enc" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_oauth_clients_registration" CHECK ("mcp_oauth_clients"."registration" in ('dcr', 'cimd')),
	CONSTRAINT "mcp_oauth_clients_secret" CHECK (("mcp_oauth_clients"."client_secret_enc" is null) = ("mcp_oauth_clients"."key_version" is null))
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL,
	"connection_id" uuid NOT NULL,
	"credential_version" integer DEFAULT 1 NOT NULL,
	"issuer" text NOT NULL,
	"client_ref" text NOT NULL,
	"resource" text NOT NULL,
	"scopes" text DEFAULT '' NOT NULL,
	"key_version" integer NOT NULL,
	"access_token_enc" text NOT NULL,
	"refresh_token_enc" text,
	"expires_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"authorized_by" uuid,
	"authorized_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_oauth_tokens_status" CHECK ("mcp_oauth_tokens"."status" in ('active', 'refresh_failed', 'reauthorization_required', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "tenant_data_keys" (
	"tenant_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"wrapped_key" text,
	"kek_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"destroyed_at" timestamp with time zone,
	CONSTRAINT "tenant_data_keys_tenant_id_version_pk" PRIMARY KEY("tenant_id","version"),
	CONSTRAINT "tenant_data_keys_status" CHECK ("tenant_data_keys"."status" in ('active', 'retired', 'destroyed')),
	CONSTRAINT "tenant_data_keys_material" CHECK (("tenant_data_keys"."status" = 'destroyed') = ("tenant_data_keys"."wrapped_key" is null))
);
--> statement-breakpoint
ALTER TABLE "mcp_oauth_tokens" ADD CONSTRAINT "mcp_oauth_tokens_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_clients_tenant_issuer_uq" ON "mcp_oauth_clients" USING btree ("tenant_id","issuer");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_tokens_connection_version_uq" ON "mcp_oauth_tokens" USING btree ("connection_id","credential_version");--> statement-breakpoint
CREATE INDEX "mcp_oauth_tokens_tenant_idx" ON "mcp_oauth_tokens" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_data_keys_active_uq" ON "tenant_data_keys" USING btree ("tenant_id") WHERE "tenant_data_keys"."status" = 'active';