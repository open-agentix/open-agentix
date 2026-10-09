-- Reverts 0013_tenant_hierarchy.sql. Refuses to run while any tenant is nested, because the
-- tree would be flattened and lose its structure. The global `tenants_slug_unique` constraint was
-- never dropped by 0013, so nothing has to be restored for it.
-- Runs in one transaction (BEGIN/COMMIT), so a failure leaves the schema untouched.
-- Not part of the drizzle journal: run it by hand (psql) after rolling the application back,
-- then delete the row of migration 0013 from drizzle.__drizzle_migrations.
BEGIN;
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
ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_tree_check";
ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_root_id_fk";
ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_parent_id_fk";
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "depth";
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "path";
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "root_id";
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "parent_id";
COMMIT;
