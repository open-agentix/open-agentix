-- ADR 0013 / W13-1: tenant tree (adjacency + materialized path). Additive and idempotent:
-- every existing tenant becomes a root, nothing is nested. Down path:
-- drizzle/down/0013_tenant_hierarchy.down.sql
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "root_id" uuid;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "path" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "depth" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "tenants" SET "root_id" = "id", "path" = '/' || "id"::text || '/', "depth" = 0 WHERE "parent_id" IS NULL AND ("root_id" IS NULL OR "path" IS NULL);--> statement-breakpoint
ALTER TABLE "tenants" ALTER COLUMN "root_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ALTER COLUMN "path" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_parent_id_fk";--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_parent_id_fk" FOREIGN KEY ("parent_id") REFERENCES "tenants"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_root_id_fk";--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_root_id_fk" FOREIGN KEY ("root_id") REFERENCES "tenants"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_tree_check";--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_tree_check" CHECK (
	"depth" >= 0 AND "depth" <= 32
	AND ("parent_id" IS NULL) = ("depth" = 0)
	AND ("parent_id" IS NULL) = ("root_id" = "id")
	AND "parent_id" IS DISTINCT FROM "id"
	AND "path" ~ '^(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})+/$'
	AND char_length("path") = 37 * ("depth" + 1) + 1
	AND "path" LIKE '%/' || "id"::text || '/'
	AND "path" LIKE '/' || "root_id"::text || '/%'
);--> statement-breakpoint
ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_slug_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "tenants_parent_slug_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_parent_slug_uq" ON "tenants" USING btree ((coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid)), "slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenants_path_idx" ON "tenants" USING btree ("path" text_pattern_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenants_parent_idx" ON "tenants" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenants_root_idx" ON "tenants" USING btree ("root_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "tenants_tree_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	p "tenants"%ROWTYPE;
BEGIN
	IF TG_OP = 'UPDATE' THEN
		-- Moves arrive with W13-11 (which replaces this guard); until then the placement is frozen.
		IF NEW."parent_id" IS DISTINCT FROM OLD."parent_id" OR NEW."root_id" <> OLD."root_id"
			OR NEW."path" <> OLD."path" OR NEW."depth" <> OLD."depth" THEN
			RAISE EXCEPTION 'tenant tree placement is immutable (id %)', OLD."id" USING ERRCODE = '23514';
		END IF;
		RETURN NEW;
	END IF;
	IF NEW."parent_id" IS NULL THEN
		RETURN NEW;
	END IF;
	SELECT * INTO p FROM "tenants" WHERE "id" = NEW."parent_id";
	IF NOT FOUND THEN
		RAISE EXCEPTION 'parent tenant % does not exist', NEW."parent_id" USING ERRCODE = '23503';
	END IF;
	IF position(NEW."id"::text IN p."path") > 0 THEN
		RAISE EXCEPTION 'tenant % would be its own ancestor', NEW."id" USING ERRCODE = '23514';
	END IF;
	IF NEW."path" <> p."path" || NEW."id"::text || '/' OR NEW."depth" <> p."depth" + 1
		OR NEW."root_id" <> p."root_id" THEN
		RAISE EXCEPTION 'tenant % does not match the placement below %', NEW."id", p."id" USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "tenants_tree_guard_trg" ON "tenants";--> statement-breakpoint
CREATE TRIGGER "tenants_tree_guard_trg" BEFORE INSERT OR UPDATE ON "tenants" FOR EACH ROW EXECUTE FUNCTION "tenants_tree_guard"();
