-- Reverts 0030_tenant_use_case_attach.sql (ADR 0014 slice S8).
-- Not part of the drizzle journal: run it by hand (psql) after rolling the application back, then
-- delete the row of migration 0030 from drizzle.__drizzle_migrations. Loses the attachments
-- (tenants.use_case); use-case role bindings (tenant_role_bindings.use_case) stay, and an application
-- version before this slice ignores them (the resolver of S1 to S7 never applies a use-case binding).
CREATE OR REPLACE FUNCTION "authz_bump_tenant"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF OLD."parent_id" IS NOT NULL THEN
			PERFORM "authz_bump_roots"(ARRAY(SELECT "id" FROM "tenants" WHERE "id" = OLD."root_id"));
		END IF;
		RETURN NULL;
	END IF;
	IF TG_OP = 'UPDATE' THEN
		IF OLD."slug" IS NOT DISTINCT FROM NEW."slug" AND OLD."parent_id" IS NOT DISTINCT FROM NEW."parent_id"
			AND OLD."root_id" IS NOT DISTINCT FROM NEW."root_id" AND OLD."path" IS NOT DISTINCT FROM NEW."path" THEN
			RETURN NULL;
		END IF;
		PERFORM "authz_bump_roots"(ARRAY(
			SELECT DISTINCT "id" FROM "tenants" WHERE "id" IN (OLD."root_id", NEW."root_id")));
		RETURN NULL;
	END IF;
	IF NEW."parent_id" IS NOT NULL THEN
		PERFORM "authz_bump_roots"(ARRAY[NEW."root_id"]);
	END IF;
	RETURN NULL;
END;
$$;
ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_use_case_check";
DROP INDEX IF EXISTS "tenants_parent_use_case_idx";
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "use_case";
