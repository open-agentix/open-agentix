-- ADR 0014 / W13-6 slice S10 (#195) with W13-11: tenants can be moved inside their organisation.
-- Until now the placement columns (parent_id, root_id, path, depth) were frozen by the tree guard
-- trigger of 0013. This migration lets a move through, and nothing else:
--
--   * "tenants_tree_guard" (BEFORE, per row) accepts a placement change only for a node that has a
--     parent before and after, inside the same organisation (root_id unchanged), and only in a
--     transaction that declared the move with set_config('oax.tenant_move_root', <root id>, true)
--     and that holds the organisation's exclusive tree advisory lock (namespace 734210, key
--     hashtext(root id): see services/tree-lock.ts), which the application takes first. A root
--     never moves, an organisation never changes (cross-organisation moves are W13-15), and a stray
--     UPDATE of the placement (an older application version, psql) is still refused. This is a
--     guard against stray writes, not a security boundary: whoever can run SQL as the application
--     role can take the lock and set the variable. Authorisation is the application's.
--   * "tenants_tree_verify" (AFTER, per row, DEFERRABLE INITIALLY DEFERRED) checks at commit that
--     every row whose placement changed matches its parent's final placement (path = parent path +
--     own id, depth = parent depth + 1, same root, no cycle) and that its children match its own
--     (a subtree rewritten only in part is refused). A subtree is rewritten by one statement whose
--     rows see each other's old values, so the check runs after all of them.
--
-- The authz epoch of the organisation is bumped by "authz_bump_tenant" (0021) for every row whose
-- parent_id or path changes, in the same transaction. Additive; no data change. Down path:
-- drizzle/down/0034_tenant_move.down.sql
CREATE OR REPLACE FUNCTION "tenants_tree_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	p "tenants"%ROWTYPE;
BEGIN
	IF TG_OP = 'UPDATE' THEN
		IF NEW."parent_id" IS DISTINCT FROM OLD."parent_id" OR NEW."root_id" <> OLD."root_id"
			OR NEW."path" <> OLD."path" OR NEW."depth" <> OLD."depth" THEN
			IF OLD."parent_id" IS NULL OR NEW."parent_id" IS NULL OR NEW."root_id" <> OLD."root_id"
				OR current_setting('oax.tenant_move_root', true) IS DISTINCT FROM OLD."root_id"::text
				OR NOT EXISTS (
					SELECT 1 FROM pg_locks l
					WHERE l.locktype = 'advisory' AND l.granted AND l.mode = 'ExclusiveLock'
						AND l.pid = pg_backend_pid() AND l.classid = 734210
						AND l.objid = hashtext(OLD."root_id"::text)::oid) THEN
				RAISE EXCEPTION 'tenant tree placement is immutable (id %)', OLD."id" USING ERRCODE = '23514';
			END IF;
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
CREATE OR REPLACE FUNCTION "tenants_tree_verify"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	p "tenants"%ROWTYPE;
BEGIN
	IF NEW."parent_id" IS NOT DISTINCT FROM OLD."parent_id" AND NEW."root_id" = OLD."root_id"
		AND NEW."path" = OLD."path" AND NEW."depth" = OLD."depth" THEN
		RETURN NULL;
	END IF;
	SELECT * INTO p FROM "tenants" WHERE "id" = NEW."parent_id";
	IF NOT FOUND OR position(NEW."id"::text IN p."path") > 0
		OR NEW."path" <> p."path" || NEW."id"::text || '/' OR NEW."depth" <> p."depth" + 1
		OR NEW."root_id" <> p."root_id" THEN
		RAISE EXCEPTION 'tenant % does not match the placement below its parent', NEW."id" USING ERRCODE = '23514';
	END IF;
	-- Children that were not rewritten with their parent (a half-applied move) are caught here.
	IF EXISTS (SELECT 1 FROM "tenants" c WHERE c."parent_id" = NEW."id"
		AND (c."path" <> NEW."path" || c."id"::text || '/' OR c."depth" <> NEW."depth" + 1
			OR c."root_id" <> NEW."root_id")) THEN
		RAISE EXCEPTION 'a child of tenant % does not match its placement', NEW."id" USING ERRCODE = '23514';
	END IF;
	RETURN NULL;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "tenants_tree_verify_trg" ON "tenants";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "tenants_tree_verify_trg" AFTER UPDATE ON "tenants" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "tenants_tree_verify"();
