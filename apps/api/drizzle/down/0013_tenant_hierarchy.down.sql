-- Reverts 0013_tenant_hierarchy.sql. Refuses to run while any tenant is nested, because the
-- global slug uniqueness of the flat model could not be restored without renaming them.
-- Not part of the drizzle journal: run it by hand (psql) after rolling the application back,
-- then delete the row of migration 0013 from drizzle.__drizzle_migrations.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "tenants" WHERE "parent_id" IS NOT NULL) THEN
		RAISE EXCEPTION 'cannot revert 0013: nested tenants exist; move or delete them first';
	END IF;
END
$$;
DROP TRIGGER IF EXISTS "tenants_tree_guard_trg" ON "tenants";
DROP FUNCTION IF EXISTS "tenants_tree_guard"();
DROP INDEX IF EXISTS "tenants_root_idx";
DROP INDEX IF EXISTS "tenants_parent_idx";
DROP INDEX IF EXISTS "tenants_path_idx";
DROP INDEX IF EXISTS "tenants_parent_slug_uq";
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_slug_unique" UNIQUE ("slug");
ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_tree_check";
ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_root_id_fk";
ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_parent_id_fk";
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "depth";
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "path";
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "root_id";
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "parent_id";
