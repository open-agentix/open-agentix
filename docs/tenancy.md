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
- act inside any node of the tenant tree with the header `X-OAX-Tenant: <id | slug | slug path>`
  (see [Acting in the tree](#acting-in-the-tree)),
- read costs and audit entries across tenants with `?allTenants=true`,
- create `platform` scoped connections, policies (stricter-only for everybody) and global guidelines,
- sign audit checkpoints and verify the whole chain.

Tenant administrators are ordinary `admin` users of their tenant without the operator flag.

## Acting in the tree

Every request acts in exactly one node. `X-OAX-Tenant: <id | slug | slug path>` (for example
`acme/security/blue`) selects it; without the header the request acts in the user's home tenant.
The response always names the node that was used in `X-OAX-Acting-Tenant: <slug path>`, so the
console can detect a mismatch between the tenant it believes it acts in and the one the API used.

| Caller | May name (reach) |
| --- | --- |
| platform operator | every node of every organisation |
| every other user, tenant admins included | the home node only |

Any other node (a child, a sibling, an ancestor, a cousin, another organisation, a node that does
not exist, a malformed value) answers the same `404 not_found`, so neither existence nor slugs can
be probed. For a caller limited to its home node the value is compared with that node only (id,
slug, slug path); no other node is looked up, so the response time does not depend on which other
slugs exist.

Why a tenant admin does not reach its children yet: [ADR 0014](adr/0014-tenant-tree-role-inheritance.md)
makes inheritance down the tree **opt-in per binding** (`inherit = true`, default `false`), and
today's roles (`users.global_roles`, team and agent bindings) become non-inheriting bindings on the
home node. Reaching below the home node therefore arrives with the bindings table and the acting
node of ADR 0014 (slices S1 and S2, reads only until S5). A platform operator acting in another node
keeps the roles of its home tenant there (`homeTenantId` on the principal).

- `GET /v1/me` reports `actingTenant` (with the breadcrumb `path`, root first; ancestors by name and
  slug only), `homeTenant`, the bindings anchored at their node, `visibleTenantCount` and
  `installationMode` (`multi` when the caller can act in more than one tenant, else `single`; it is
  derived from the caller's reach, so it never reveals whether other organisations exist).
- `GET /v1/tenants` lists exactly the nodes of the reach, with `parentId`, `depth` and `slugPath`.
- `GET /v1/tenants/tree?root=&depth=&include=counts&limit=` returns the visible tree, parents before
  children, siblings by slug, shallowest nodes first when `limit` (default 1000, at most 5000)
  truncates (`truncated: true`). The ancestors of the caller's node appear as path stubs
  (`visible: false`: id, slug, name, no counts, no roles); siblings and other organisations never
  do. Each node carries the caller's `myRoles` (bound on the node) and `inheritedRoles` (bound on an
  ancestor). `include=counts` adds agents (own and subtree), runs of the last 30 days, pending
  approvals, spend of the month (own and subtree) and the node's monthly cap, each only when the
  caller holds the matching read permission on the whole node (`agents:read`, `runs:read`,
  `costs:read`; a team or agent scoped role does not count, an API token scope does restrict).
  Subtree sums are sums over the nodes the caller can see: for everybody but a platform operator
  `agentsSubtree` equals the own count and `hasChildren` is `false`.
- `GET /v1/tenants/search?q=` finds nodes of the reach by name or slug (at most 20).
- Queries: one for the nodes, one aggregate per metric (grouped by tenant, rolled up along the
  materialised path in memory), no query per node. Migration `0017` adds
  `approvals(tenant_id, status)`.

Not yet: roles are not bound per node (nobody but a platform operator reaches below the home node), `status` is
always `active` (blocking comes with budget caps, W13-4), and the display colour and use case of a
node need storage that arrives with W13-2 and W13-6.

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

