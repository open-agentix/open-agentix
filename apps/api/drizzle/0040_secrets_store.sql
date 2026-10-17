-- ADR 0017 slice S4 (#247): scoped secrets and the encrypted secret store.
--
-- * secrets: identity, scope and metadata of a secret. NEVER a value. tenant_id is the owning node
--   (its data key seals the values), scope_id the node, team or user. Unique per
--   (tenant_id, scope, scope_id, name).
-- * secret_versions: the sealed values (oaxe1 envelope, AES-256-GCM, AAD = tenant | scope | scope_id |
--   name | secret id | version), one row per version, deleted with the secret.
-- * A trigger keeps the identity columns of a secret (the AAD inputs) immutable.
-- * agent_versions.secret_resolution (jsonb, since 0038) now holds pins ({ ref, state, ... }) next to
--   the legacy names; no data change is needed (old rows keep their string entries).
-- Journal note: this is idx 34 / 0040 because the AWP-3b migration (#366) takes 0039 / idx 33.
-- Down path: drizzle/down/0040_secrets_store.down.sql
CREATE TABLE "secret_versions" (
	"secret_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ciphertext" text NOT NULL,
	"dek_version" integer NOT NULL,
	"aad_digest" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secret_versions_secret_id_version_pk" PRIMARY KEY("secret_id","version")
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"name" text NOT NULL,
	"backend" text DEFAULT 'internal' NOT NULL,
	"pointer" text,
	"current_version" integer DEFAULT 1 NOT NULL,
	"description" text,
	"usage" text DEFAULT 'any' NOT NULL,
	"allowed_destinations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"inherit" boolean DEFAULT false NOT NULL,
	"allow_override" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "secrets_scope_check" CHECK ("secrets"."scope" in ('personal', 'team', 'tenant')),
	CONSTRAINT "secrets_usage_check" CHECK ("secrets"."usage" in ('development', 'production', 'any')),
	CONSTRAINT "secrets_backend_check" CHECK ("secrets"."backend" in ('internal', 'env')),
	CONSTRAINT "secrets_pointer_check" CHECK (("secrets"."backend" = 'env') = ("secrets"."pointer" is not null)),
	CONSTRAINT "secrets_name_check" CHECK ("secrets"."name" ~ '^[a-z0-9][a-z0-9_.-]{0,127}$'),
	CONSTRAINT "secrets_description_len" CHECK (char_length("secrets"."description") <= 500),
	CONSTRAINT "secrets_tenant_scope_check" CHECK ("secrets"."scope" <> 'tenant' or "secrets"."scope_id" = "secrets"."tenant_id"),
	CONSTRAINT "secrets_inherit_check" CHECK ("secrets"."scope" = 'tenant' or (not "secrets"."inherit" and not "secrets"."allow_override"))
);
--> statement-breakpoint
ALTER TABLE "secret_versions" ADD CONSTRAINT "secret_versions_secret_id_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secrets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_versions" ADD CONSTRAINT "secret_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "secret_versions_dek_idx" ON "secret_versions" USING btree ("tenant_id","dek_version");--> statement-breakpoint
CREATE UNIQUE INDEX "secrets_identity_uq" ON "secrets" USING btree ("tenant_id","scope","scope_id","name");--> statement-breakpoint
CREATE INDEX "secrets_scope_idx" ON "secrets" USING btree ("scope","scope_id");
--> statement-breakpoint
CREATE FUNCTION oax_secret_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.scope IS DISTINCT FROM OLD.scope OR NEW.scope_id IS DISTINCT FROM OLD.scope_id
     OR NEW.name IS DISTINCT FROM OLD.name OR NEW.backend IS DISTINCT FROM OLD.backend THEN
    RAISE EXCEPTION 'the identity of a secret is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER secrets_identity_immutable BEFORE UPDATE ON secrets FOR EACH ROW EXECUTE FUNCTION oax_secret_identity_immutable();
