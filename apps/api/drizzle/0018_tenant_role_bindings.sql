-- ADR 0014 / W13-6 slice S1: role bindings on nodes of the tenant tree. Additive and idempotent.
-- (ADR 0014 planned 0017; 0016 and 0017 were taken by agent disable and the approvals index.)
-- Nothing reads the new tables to authorise yet: users.global_roles stays the source of truth for
-- one release and is mirrored here (write-through). Down path:
-- drizzle/down/0018_tenant_role_bindings.down.sql
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "authz_epoch" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_role_bindings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"role" text NOT NULL,
	"use_case" text,
	"inherit" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trb_role_check" CHECK ("tenant_role_bindings"."role" in ('admin','agent-engineer','integrator','operator','auditor','viewer','pentest')),
	CONSTRAINT "trb_pentest_expiry" CHECK ("tenant_role_bindings"."role" <> 'pentest' or "tenant_role_bindings"."expires_at" is not null),
	CONSTRAINT "trb_use_case_len" CHECK ("tenant_role_bindings"."use_case" is null or char_length("tenant_role_bindings"."use_case") between 1 and 200)
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_role_restrictions" (
	"tenant_id" uuid NOT NULL,
	"role" text NOT NULL,
	"permission" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_role_restrictions_tenant_id_role_permission_pk" PRIMARY KEY("tenant_id","role","permission"),
	CONSTRAINT "trr_role_check" CHECK ("tenant_role_restrictions"."role" in ('admin','agent-engineer','integrator','operator','auditor','viewer','pentest')),
	CONSTRAINT "trr_not_admin" CHECK ("tenant_role_restrictions"."role" <> 'admin')
);--> statement-breakpoint
ALTER TABLE "tenant_role_bindings" DROP CONSTRAINT IF EXISTS "tenant_role_bindings_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "tenant_role_bindings" ADD CONSTRAINT "tenant_role_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_role_bindings" DROP CONSTRAINT IF EXISTS "tenant_role_bindings_tenant_id_tenants_id_fk";--> statement-breakpoint
ALTER TABLE "tenant_role_bindings" ADD CONSTRAINT "tenant_role_bindings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_role_bindings" DROP CONSTRAINT IF EXISTS "tenant_role_bindings_granted_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "tenant_role_bindings" ADD CONSTRAINT "tenant_role_bindings_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_role_restrictions" DROP CONSTRAINT IF EXISTS "tenant_role_restrictions_tenant_id_tenants_id_fk";--> statement-breakpoint
ALTER TABLE "tenant_role_restrictions" ADD CONSTRAINT "tenant_role_restrictions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_role_restrictions" DROP CONSTRAINT IF EXISTS "tenant_role_restrictions_created_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "tenant_role_restrictions" ADD CONSTRAINT "tenant_role_restrictions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trb_uq" ON "tenant_role_bindings" USING btree ("user_id","tenant_id","role",coalesce("use_case", ''));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trb_tenant_idx" ON "tenant_role_bindings" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trb_user_idx" ON "tenant_role_bindings" USING btree ("user_id");--> statement-breakpoint
-- Inheritance can only ever flow down a tree, and a tree never crosses organisations: a binding's
-- node must be in the organisation (root_id) of the user's home tenant. FOR SHARE on the user row
-- makes this race-free against a concurrent change of the user's home tenant (the guard below).
CREATE OR REPLACE FUNCTION "trb_same_org"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	node_root uuid;
	home_root uuid;
BEGIN
	SELECT "root_id" INTO node_root FROM "tenants" WHERE "id" = NEW."tenant_id";
	SELECT t."root_id" INTO home_root FROM "users" u JOIN "tenants" t ON t."id" = u."tenant_id"
		WHERE u."id" = NEW."user_id" FOR SHARE OF u;
	IF node_root IS NULL OR home_root IS NULL OR node_root <> home_root THEN
		RAISE EXCEPTION 'role binding node % is outside the home organisation of user %',
			NEW."tenant_id", NEW."user_id" USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trb_same_org_trg" ON "tenant_role_bindings";--> statement-breakpoint
CREATE TRIGGER "trb_same_org_trg" BEFORE INSERT OR UPDATE OF "user_id", "tenant_id" ON "tenant_role_bindings" FOR EACH ROW EXECUTE FUNCTION "trb_same_org"();--> statement-breakpoint
-- The same rule from the other side: a user cannot move to another organisation while bindings
-- of the old one exist.
CREATE OR REPLACE FUNCTION "trb_users_home_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	new_root uuid;
BEGIN
	IF NEW."tenant_id" IS NOT DISTINCT FROM OLD."tenant_id" THEN
		RETURN NEW;
	END IF;
	SELECT "root_id" INTO new_root FROM "tenants" WHERE "id" = NEW."tenant_id";
	IF EXISTS (
		SELECT 1 FROM "tenant_role_bindings" b JOIN "tenants" t ON t."id" = b."tenant_id"
		WHERE b."user_id" = NEW."id" AND t."root_id" IS DISTINCT FROM new_root
	) THEN
		RAISE EXCEPTION 'user % has role bindings outside the organisation of tenant %',
			NEW."id", NEW."tenant_id" USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trb_users_home_guard_trg" ON "users";--> statement-breakpoint
CREATE TRIGGER "trb_users_home_guard_trg" BEFORE UPDATE OF "tenant_id" ON "users" FOR EACH ROW EXECUTE FUNCTION "trb_users_home_guard"();--> statement-breakpoint
-- Backfill: every role of users.global_roles becomes a non-inheriting binding on the user's home
-- tenant, so nobody's access changes. Roles the application ignores today (anything outside the
-- six original roles) are ignored here too. Re-running adds nothing.
INSERT INTO "tenant_role_bindings" ("id", "user_id", "tenant_id", "role", "inherit")
SELECT gen_random_uuid(), u."id", u."tenant_id", r."role", false
FROM "users" u
CROSS JOIN LATERAL (SELECT DISTINCT unnest(u."global_roles") AS "role") r
WHERE r."role" IN ('admin','agent-engineer','integrator','operator','auditor','viewer')
ON CONFLICT DO NOTHING;
