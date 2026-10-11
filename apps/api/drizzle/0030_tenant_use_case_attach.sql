-- ADR 0014 / W13-6 slice S8: use-case-scoped bindings and node attachment. Additive; the down path is
-- drizzle/down/0030_tenant_use_case_attach.down.sql.
--
-- tenants.use_case attaches a child node to a use case of its parent (ADR 0013 section 7.2, ADR 0014
-- section 3.3): a use-case binding of the parent that inherits also applies in the child and its
-- whole subtree. Only a child can carry one (a root has no parent); the value has the syntax of a
-- binding's use case. Attaching or detaching changes who can do what, so the organisation's authz
-- epoch is bumped by the database itself, like every other change of the grants (migration 0021).
ALTER TABLE "tenants" ADD COLUMN "use_case" text;--> statement-breakpoint
CREATE INDEX "tenants_parent_use_case_idx" ON "tenants" USING btree ("parent_id","use_case") WHERE "tenants"."use_case" is not null;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_use_case_check" CHECK ("tenants"."use_case" is null or ("tenants"."parent_id" is not null and char_length("tenants"."use_case") between 1 and 200 and "tenants"."use_case" ~ '^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*$'));--> statement-breakpoint
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
			AND OLD."root_id" IS NOT DISTINCT FROM NEW."root_id" AND OLD."path" IS NOT DISTINCT FROM NEW."path"
			AND OLD."use_case" IS NOT DISTINCT FROM NEW."use_case" THEN
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
