# ADR 0007: Tenants as the isolation boundary

- Status: Accepted
- Date: 2026-10-04

## Context

The concept requires that one customer or team never sees another: agents, runs, connections, keys,
audit and costs. v0.1.0 stored a `tenant_id` everywhere but did not filter by it.

## Decision

- Tenant scoping is explicit: services take the caller (`Principal` / `TenantActor`) and every
  query includes the tenant. There is no ambient "current tenant", so a missing filter is a type
  error or a failing probe in `tenancy.test.ts`, not a silent leak.
- Cross-tenant ids behave like unknown ids (404). Names are unique per tenant.
- Platform operators (`users.platform_admin`) manage tenants and may act in one with
  `X-OAX-Tenant`; platform scoped connections/policies/guidelines are the only objects shared
  across tenants.
- The audit chain stays global; entries carry a tenant partition key outside the hash.
- Database-level row security (PostgreSQL RLS) is not used yet: it needs a per-request
  transaction setting and would make PGlite tests diverge. It remains an option as defence in depth.

## Consequences

- Every new route or service method with a resource id must take the tenant and be listed in the
  isolation tests.
- A single global audit chain leaks sequence numbers (activity volume) across tenants; accepted
  until per-tenant chains exist.
