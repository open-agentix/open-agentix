-- Revision safety: the audit trail and published agent versions are append-only.
-- In addition to these triggers, production deployments run the API with a database role that has
-- no UPDATE/DELETE/TRUNCATE privileges on these tables (see deploy/sql/roles.sql).
CREATE OR REPLACE FUNCTION oax_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only (% is not allowed)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION oax_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION oax_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_checkpoints_append_only BEFORE UPDATE OR DELETE ON audit_checkpoints FOR EACH ROW EXECUTE FUNCTION oax_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_checkpoints_no_truncate BEFORE TRUNCATE ON audit_checkpoints FOR EACH STATEMENT EXECUTE FUNCTION oax_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER agent_versions_append_only BEFORE UPDATE OR DELETE ON agent_versions FOR EACH ROW EXECUTE FUNCTION oax_forbid_mutation();
