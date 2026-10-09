-- UX slice A3: pending approvals per tenant for GET /v1/tenants/tree. Additive; down path:
-- drizzle/down/0017_approvals_tenant_status_idx.down.sql
CREATE INDEX IF NOT EXISTS "approvals_tenant_status_idx" ON "approvals" USING btree ("tenant_id","status");
