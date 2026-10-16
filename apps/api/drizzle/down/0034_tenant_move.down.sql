-- Reverts 0034_tenant_move.sql (ADR 0014 slice S10, #195).
-- Not part of the drizzle journal: run it by hand (psql) after rolling the application back, then
-- delete the row of migration 0034 from drizzle.__drizzle_migrations. Loses no data: tenants that
-- were moved keep their new placement, which is consistent. Afterwards the placement is frozen
-- again (a move is refused by the guard), exactly as before the migration.
DROP TRIGGER IF EXISTS "tenants_tree_verify_trg" ON "tenants";
DROP FUNCTION IF EXISTS "tenants_tree_verify"();
CREATE OR REPLACE FUNCTION "tenants_tree_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	p "tenants"%ROWTYPE;
BEGIN
	IF TG_OP = 'UPDATE' THEN
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
$$;
