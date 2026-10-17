-- Reverts 0040_secrets_store.sql (ADR 0017 slice S4, #247).
-- Not part of the drizzle journal: run it by hand (psql) after rolling the application back, then
-- delete the row of migration 0040 from drizzle.__drizzle_migrations. It DROPS every stored secret
-- (metadata and sealed values) for good: agents whose steps reference a scoped secret
-- (team:, tenant:, personal:) cannot get their credential any more, and published versions that
-- pinned such a secret fail at run time. Legacy (environment and file) references are unaffected. The
-- data keys in tenant_data_keys stay. Run it before the down scripts of 0038, 0037, 0034 and 0032.
DROP TRIGGER IF EXISTS secrets_identity_immutable ON secrets;
DROP FUNCTION IF EXISTS oax_secret_identity_immutable();
DROP TABLE IF EXISTS secret_versions;
DROP TABLE IF EXISTS secrets;
