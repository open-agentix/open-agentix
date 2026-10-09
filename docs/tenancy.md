# Tenants and access

A **tenant** is the isolation boundary of openagentix: agents, runs, events, event sources,
connections, policies, guidelines, teams, users, API tokens, costs and the audit partition all
belong to exactly one tenant. A fresh installation has one tenant (`default`); nothing else changes
for single-team or homelab setups, where one person may hold every role.

## Rules

- Every request-facing query filters by the caller's tenant (`principal.tenantId`). Rows of another
  tenant are *not found*: the API answers **404**, never 403, so existence is not revealed.
  Denied cross-tenant access to agents and runs is audited in the caller's tenant (`access.denied`).
- Names are unique **per tenant** (agents, teams, connections, event sources, policies), so two
  tenants may both have a `team-security` or an agent `cve-triage`.
- A user belongs to one tenant. Global roles and team memberships apply inside that tenant only;
  agent-scoped role bindings (a role for exactly one agent) never reveal other agents.
- Cross-references are validated: an event source can only be bound to an agent of its tenant, team
  and agent members must be users of the tenant, connection scopes can only name the tenant's teams
  and agents.
- Workers resolve MCP servers and model connections **per run**: only connections of the run's
  tenant (plus platform connections) exist for that run, so tenant A can never call tenant B's
  tool servers.
- Secrets stay references. Tenant, team and agent scoped connections should use secret names that
  carry a tenant prefix (see [providers](providers.md)); platform secrets are not reachable through
  tenant connections.

## Platform operators

`users.platform_admin` marks the operators of the installation (the bootstrap administrator and, on
upgrade, every user holding the global `admin` role). Operators can

- create and rename tenants (`POST /v1/tenants`, `PATCH /v1/tenants/{id}`), optionally creating the
  first tenant administrator in the same call,
- act inside another tenant with the header `X-OAX-Tenant: <slug or id>` (everybody else gets 404),
- read costs and audit entries across tenants with `?allTenants=true`,
- create `platform` scoped connections, policies (stricter-only for everybody) and global guidelines,
- sign audit checkpoints and verify the whole chain.

Tenant administrators are ordinary `admin` users of their tenant without the operator flag.

## Audit

The hash chain is global (one chain keeps ordering and tamper detection simple); every entry carries
its tenant as a **partition key outside the hash**. Tenant users list and export only their own
partition. `POST /v1/audit/verify` verifies the whole chain but, for tenant users, reports only
issues that concern their own entries and no foreign counts or head hashes. Per-tenant chains with
Merkle proofs are on the roadmap.

## Operations

- Create the first extra tenant: `POST /v1/tenants` with `{ "slug": "acme", "name": "Acme",
  "admin": { "email": "...", "displayName": "...", "password": "..." } }` as the bootstrap admin.
- LDAP/OIDC users are created in the default tenant; move them with a tenant specific IdP mapping
  (planned) or create local users per tenant.
- The isolation tests live in `apps/api/test/tenancy.test.ts`; every new route with an id parameter
  must be added to its probe list.

## Backup and restore with the tenant tree

Migration 0013 adds the trigger `tenants_tree_guard_trg`, which checks every placement against the
parent row (and freezes the placement until moves exist). Consequences for restores:

- A **full dump** (`pg_dump` of schema and data, restored into an empty database) is fine: the
  trigger is created after the data is loaded by `pg_restore`.
- A **data-only restore into an already migrated schema** inserts the tenant rows in dump order,
  so a child can arrive before its parent and the guard rejects it. Restore with
  `pg_restore --data-only --disable-triggers` (superuser) or load the data in one session with
  `SET session_replication_role = replica`. The foreign keys and the `tenants_tree_check`
  constraint still validate the data afterwards.
- To revert the migration run `psql -1 -f apps/api/drizzle/down/0013_tenant_hierarchy.down.sql`
  (the script already wraps itself in a transaction; it refuses while nested tenants exist).

