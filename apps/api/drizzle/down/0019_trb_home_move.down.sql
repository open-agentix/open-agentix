-- Reverts 0019_trb_home_move.sql (ADR 0014 slice S1 follow-up, #216).
-- Not part of the drizzle journal: run it by hand (psql) after rolling the application back, then
-- delete the row of migration 0019 from drizzle.__drizzle_migrations. Loses no data: after it a
-- revocation through users.global_roles alone leaves the binding behind until the next reconcile,
-- and a change of users.tenant_id leaves the rows of the old home node behind (the reconcile does
-- not remove them), which matters only once the resolver decides.
DROP TRIGGER IF EXISTS "trb_users_home_move_trg" ON "users";
DROP FUNCTION IF EXISTS "trb_users_home_move"();
