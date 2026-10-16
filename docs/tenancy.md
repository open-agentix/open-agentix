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
| every other user, read path `legacy` (default) | the home node only |
| every other user, read path `bindings` | the home node and every node of the home organisation where the resolver gives them a permission: a binding on the node itself, an **inheriting** binding (`inherit = true`) on an ancestor, a team membership or an agent binding in that node |

Any other node (a node without such a binding, a sibling, a cousin, an ancestor without one, another
organisation, a node that does not exist, a malformed value) answers the same `404 not_found`, so
neither existence nor slugs can be probed. The check never looks up a foreign node per slug segment:
a caller limited to its home node is compared with that node only; a caller with a wider reach is
matched, **in memory**, against the cached snapshot of its own organisation (`tree:<rootId>:<epoch>`:
id, parent, path, slug of every node, at most `OAX_TENANT_MAX_NODES_PER_ROOT`, one query on a miss)
and then against its visible set. An unknown reference, an invisible node and a node of another
organisation therefore cost the same queries and give the same status and body (tests count them).

Permissions at the acting node are the **effective bindings there** (ADR 0014 section 3.2), not the
roles of the home node: an `admin` binding on the home node does not make anybody an admin of the
child, an inheriting binding on an ancestor does, with the **whole role** (write inheritance, slice S5;
the read-only clamp of S2 to S4 is gone, see "Write inheritance" below). API token
scopes still intersect with the effective permissions. A platform operator acting in another node
keeps the roles of its home tenant (`homeTenantId` on the principal), as before.

Inheritance is opt-in per binding (`inherit = true`, default `false`; ADR 0014); today's roles
(`users.global_roles`, team and agent bindings) are non-inheriting bindings on the home node. Since S4
the role-binding API creates inheriting bindings (see "Role-binding API" below); the mirror rows of
`global_roles` have their own key (`source = 'mirror'`), so an explicit grant (`source = 'grant'`) on the
user's own home node in a legacy role is no longer removed by the reconcile or the `0019` trigger (#226).

- `GET /v1/me` reports `actingTenant` (with the breadcrumb `path`, root first; ancestors by name and
  slug only), `homeTenant`, the bindings that apply at the acting node, each with the node it is bound
  on (`tenantId`, `tenantSlugPath`), `inherit`, `expiresAt` and `source` (`direct`, `inherited`,
  `team`, `agent`; `permissions` is the union at the acting node), `visibleTenantCount` and
  `installationMode` (`multi` when the caller can act in more than one tenant, else `single`; it is
  derived from the caller's reach, so it never reveals whether other organisations exist).
- `GET /v1/tenants` lists exactly the nodes of the reach, with `parentId`, `depth` and `slugPath`
  (with read path `bindings`: the visible nodes, so an inheriting viewer of a division sees the
  division and its descendants, never a sibling).
- `GET /v1/tenants/tree?root=&depth=&include=counts&limit=` returns the visible tree, parents before
  children, siblings by slug, shallowest nodes first when `limit` (default 1000, at most 5000)
  truncates (`truncated: true`). The ancestors of the caller's node appear as path stubs
  (`visible: false`: id, slug, name, no counts, no roles); siblings and other organisations never
  do. Each node carries the caller's `myRoles` (bound on the node) and `inheritedRoles` (bound on an
  ancestor). `include=counts` adds agents (own and subtree), runs of the last 30 days, pending
  approvals, spend of the month (own and subtree) and the node's monthly cap, each only when the
  caller holds the matching read permission on the whole node (`agents:read`, `runs:read`,
  `costs:read`; a team or agent scoped role does not count, an API token scope does restrict).
  Subtree sums are sums over the nodes the caller can see **and may read** (with read path
  `bindings`: per node, from the roles held there on the whole node; a node the caller cannot read
  is neither counted nor shown): on read path `legacy` `agentsSubtree` equals the own count for
  everybody but a platform operator and `hasChildren` is `false`; with `bindings` `hasChildren` is
  true only when a child is visible.
- `GET /v1/tenants/search?q=` finds nodes of the reach by name or slug (at most 20).
- Queries: one for the nodes, one aggregate per metric (grouped by tenant, rolled up along the
  materialised path in memory), no query per node. Migration `0017` adds
  `approvals(tenant_id, status)`.

Not yet: `status` is always `active` (blocking comes with budget caps, W13-4), and the display colour
of a node needs storage that arrives with W13-2 and W13-8. The use case a node is attached to is stored
(`tenants.use_case`, slice S8) and shown as `useCase` on the tenant.

## Fixed roles and the agent roles (ADR 0017, slice S10)

The role set is fixed (it is not a custom-role feature). `pentest` is bound through the role-binding
API only (see below); the other seven are granted everywhere a role can be granted: `users.global_roles`,
node bindings (with and without `inherit`), team members, agent members and the installation-wide group
mapping (`role` or `role@team-slug`). The console shows the display names in English and German.

| Role | Display name | Permissions (besides the read basics `agents:read`, `runs:read`, `events:read`, `costs:read`) |
| --- | --- | --- |
| `admin` | Admin | every permission |
| `agent-developer` | Agent Developer | `agents:write`, `agents:review`, `agents:approve`, `runs:execute`, `runs:cancel`, `sources:read`, `connections:read`, `policies:read`, `tokens:read`, `tokens:write` |
| `agent-maintainer` | Agent Maintainer | everything of `agent-developer` plus `agents:publish` and `agents:rules` |
| `integrator` | Integrator | `agents:review`, `sources:read`, `sources:write`, `connections:read`, `connections:write`, `policies:read`, `tokens:read`, `tokens:write` |
| `operator` | Operator | `agents:review`, `agents:approve`, `runs:execute`, `runs:cancel`, `runs:approve`, `sources:read`, `tokens:read` |
| `auditor` | Auditor | `agents:review`, `audit:read`, `audit:verify`, `audit:export`, `policies:read`, `connections:read`, `sources:read`, `users:read`, `settings:read` |
| `viewer` | Viewer | the read basics only |
| `pentest` | Pentest | read-only, time-boxed (see below) |

- `agents:review`, `agents:approve` and `agents:rules` are **permissions only** in this slice. Nothing
  enforces a review or an approval yet (that comes with ADR 0017 S1 and S3); publishing behaves as before.
  An Agent Developer cannot publish (`agents:publish`), an Agent Maintainer can. Neither role holds
  `users:write`, `settings:write`, `connections:write`, `sources:write`, `policies:write` or any audit
  permission, so neither can grant a role or change settings. The grant rules of ADR 0014 (a grant needs
  every permission of the role, no self-grant, subtree coverage for `inherit`) are unchanged.
- Agent Developers are not approvers by default: the planned default approver roles are `admin` and
  `agent-maintainer`.
- **Breaking: `agent-engineer` is now `agent-maintainer`.** There is no alias. Migration
  `0030_agent_roles` rewrites every stored `agent-engineer` (`users.global_roles` and the mirror rows,
  node bindings, role restrictions, team members, agent bindings and the approver roles of pending
  approvals) to `agent-maintainer`, which holds exactly the old permissions plus the three new agent
  permissions. Afterwards `agent-engineer` is an unknown role: the API answers `400`, the check
  constraints refuse it, and `OAX_OIDC_ROLE_MAPPING` / `OAX_LDAP_ROLE_MAPPING` values naming it are
  refused at start. Published agent versions are immutable and keep their text; an `approverRoles` list
  in an **already published** `agents.md` that names `agent-engineer` no longer matches any role: publish
  a new version with `agent-maintainer`. Revert: `apps/api/drizzle/down/0030_agent_roles.down.sql`
  (maps back; refuses while `agent-developer` bindings exist).

## Role bindings (ADR 0014, slice S1)

Migration `0018_tenant_role_bindings` adds the tables the next slices build on. **Nothing authorises
from them by default** (`OAX_ROLE_BINDINGS_READ=legacy`, see the S2 section below): the legacy sources (`users.global_roles`, team memberships, agent bindings) stay
authoritative, so upgrading changes nobody's access.

- `tenant_role_bindings (user, node, role, use_case, inherit, expires_at, granted_by)`:
  `inherit` defaults to `false` (the role applies at the node only); `true` also applies it at every
  descendant. The trigger `trb_same_org` keeps the node inside the user's home organisation
  (`23514` otherwise) and a second trigger on `users` refuses moving a user to another organisation
  while bindings of the old one exist. A binding can sit on any node of the organisation (an
  organisation admin may live in a child and be bound on the root); that it can never apply upward,
  sideways or across organisations is a property of the resolver, which has property tests for it.
- `tenant_role_restrictions` (role restrictions, see "Role restrictions" below) and `tenants.authz_epoch` exist.
- **Backfill**: every role in `users.global_roles` became a non-inheriting binding on the user's
  home tenant. Roles the application ignores (unknown ones, `pentest`) are not backfilled.
- **Write-through**: user create (also the first admin of a new tenant and the bootstrap admin),
  `PATCH /v1/users/{id}` with `globalRoles`, and the LDAP/OIDC group mapping write `global_roles` and
  the matching non-inheriting, non-expiring bindings (`source = 'mirror'`) on the home tenant in one
  transaction. Explicit grants (`source = 'grant'`) and rows of any other shape (use case, other
  nodes) are left alone (see "mirror rows and grants" below). The mirror and the column go away
  together one release later.
- **Pure resolver** `effectiveAt` in `packages/core/src/tenancy/roles.ts`: raw grants, the acting
  node and `now` in, `RoleBinding[]` (with `permissions`, `useCase`, `source`) out. No database,
  no clock, no recursion; unusable input yields fewer bindings, never more.
- **Shadow mode**: after every principal build the API resolves the same user at the home node from
  the bindings table and compares it with the legacy result. The outcome is counted in
  `oax_role_bindings_shadow_total{outcome="match|mismatch|error|skipped"}`; a mismatch also logs a
  warning with the differing lines (at most once per user and ten minutes). At most two checks run
  at once; under load the rest are skipped (`skipped`), so the check adds a bounded number of
  database reads to authentication. A non-zero `mismatch` means the
  mirror drifted or a binding exists that the legacy path does not know. The legacy result is always
  what authorises; the check never fails a request. Turn it off with `OAX_ROLE_BINDINGS_SHADOW=false`.
- `pentest` exists in the role set (read-only, ADR 0014 section 8). Since S6 only the role-binding API grants
  it (see "The `pentest` role" below); user create/patch, team and agent members and group mappings keep
  rejecting it (`400 validation_failed`).

- **Reconcile (#216)**: `users.global_roles` is the source of truth until the resolver decides, and
  an application version that does not know the mirror (a rolling deploy with old replicas still
  running, or an application-only rollback) changes it without the bindings. The control node
  therefore repairs the mirror in both directions: at start-up, every
  `OAX_ROLE_BINDINGS_RECONCILE_INTERVAL_SECONDS` (default one hour) and, rate-limited, for the user
  of every shadow `mismatch`. Each user is repaired in one transaction that first locks the user
  row (`FOR NO KEY UPDATE`), the same order every writer of `global_roles` uses, so a concurrent
  `PATCH` waits instead of racing. Operators can run it by hand, also against a live system:
  `pnpm --filter @openagentix/api db:reconcile-bindings [-- --dry-run]`
  (`node dist/reconcile-bindings-cli.js`, database variables only). Metrics:
  `oax_role_bindings_reconcile_fixes_total{kind="added|removed",trigger="startup|periodic|mismatch|cli"}`
  and `oax_role_bindings_reconcile_runs_total{trigger,outcome="ok|error|skipped"}`; a non-zero rate
  outside a deploy means something writes `global_roles` without the mirror.
- **Mirror rows and grants (the decision of #226, migration `0023_trb_source`)**: every row has a
  `source`. `mirror` rows mirror `users.global_roles`: one slot per legacy role on the user's home node,
  written by the application, the reconcile and the trigger. `grant` rows are everything the
  role-binding API creates (and, in the migration, every pre-existing row that is not mirror-shaped:
  inheriting, expiring, use case, `pentest` or not on the home node). `source` is part of `trb_uq`, so
  the two never share a slot, and the same-key rule, the reconcile, the `global_roles` write-through and
  the `0019` trigger work on `source = 'mirror'` only:
  - *adding* a role to `global_roles` adds its mirror row next to any explicit grant of the same role;
  - *removing* a role revokes the **mirror row** of that key (also when the bulk opt-in or `PATCH
    { inherit: true }` made it inheriting: the flag adds inheritance, it does not change who owns the
    row) and never an explicit grant: **an explicit grant survives an unrelated `global_roles` change,
    the reconcile and the trigger**;
  - a **home move** inside the organisation moves the mirror rows (old home node out, new home node in)
    and leaves explicit grants where they are. A grant on the old home node still makes sense (it is a
    decision about that node, not about the user's home, and the organisation is unchanged), so there is
    no automatic revocation; the audit reason `moved_out` is reserved for node moves (S10), where a
    grant can end up outside the user's organisation. Moving a user to another organisation stays
    refused while any binding of the old one exists, grants included;
  - rows with a use case, on other nodes and `pentest` are never touched by the mirror.
  Consequence: revoking an inheriting or expiring grant needs the role-binding API; taking a role out
  of `global_roles` does not. A test asserts that every write path of the application leaves mirror rows
  plain.
- **The database enforces revocation (#216)**: migration `0019_trb_home_move` adds the trigger
  `trb_users_home_move_trg` (`AFTER UPDATE OF tenant_id, global_roles` on `users`; it returns at
  once when neither value changed, so logins and other updates cost nothing). Whatever code path
  changed the row (the API, an older application version, an LDAP/SCIM sync, an emergency
  `update users set global_roles = ...` in `psql`), in the same statement:
  - when `users.tenant_id` changes inside the organisation, every **mirror** binding of the legacy key
    on the old home node (no use case, one of the six roles, any shape) is deleted and the roles of
    `global_roles` are bound on the new home node; explicit grants, use-case and `pentest` rows and
    other nodes are kept (since `0023`; the trigger was restricted to `source = 'mirror'` in the same
    migration as the key change);
  - on the (new) home node the same-key rule is applied: a mirror binding whose role is not in
    `global_roles` is deleted, whatever its shape.
  Roles *added* through the column alone are not bound by the trigger (a missing row grants less,
  never more); the application, the shadow-driven and the periodic reconcile add them. The trigger
  does not invalidate cached principals itself; since migration `0021` the epoch trigger on
  `tenant_role_bindings` and `users` does (see "Authz epoch" below). Moving to another organisation is still
  refused while bindings of the old one exist, and the roles then follow the user to the new home,
  so the way back needs those bindings gone again.
- **Raw grants in a cache (#217)**: `serializeGrants` / `reviveGrants` in `@openagentix/core`
  (`packages/core/src/tenancy/grants-codec.ts`) are the JSON form for the cache entry that carries
  raw grants (ADR 0014 section 6.2). Expiries are canonical ISO-8601 UTC strings and are parsed
  back strictly into `Date`s; anything that is not exactly what `serializeGrants` writes (version,
  shape, role, date) makes the whole entry a cache miss, never a partial grant list. A binding with
  an expiry therefore still applies until it expires after a round trip through Valkey. Without
  this the resolver (which treats a non-`Date` expiry as expired) would silently drop every
  expiring binding, `pentest` included. An entry must also be consistent (home node, root and path
  agree) and, with `reviveGrants(value, { userId, homeTenantId })`, belong to the user it is read
  for; the S2 cache passes the owner, so an entry under a wrong key is a miss, never another
  user's grants. S2 uses it exactly so (see "Authz epoch" below).
- **`loadRawGrants` uses one connection (#217)**: the node row and the three grant lists come from a
  single statement, so a principal build holds at most one pool connection and reads the home node
  and the grants from the same snapshot. Expiries are read as epoch milliseconds, rounded down: a
  binding can only end early, never late.

## Read path and authz epoch (ADR 0014, slice S2)

`OAX_ROLE_BINDINGS_READ=legacy|bindings` (default `legacy`; any other value, an empty one included,
refuses to start) chooses what authorises. **The default changes nothing for anybody.**

- `legacy`: `users.global_roles`, team memberships and agent bindings of the home node decide, the
  resolver only shadows (`oax_role_bindings_shadow_total{authoritative="legacy"}`).
- `bindings`: the principal's raw grants of its home organisation are loaded (one statement) and the
  resolver (`effectiveAt`, ADR 0014 3.2) decides at the **acting node**; the legacy sources are compared (`authoritative="bindings"`), so a mirror that
  drifted (a role in `global_roles` without its binding, or a binding the legacy model does not
  know) shows up as a `mismatch`. Platform operators are unchanged: every node, the roles of the
  home tenant (the implicit "admin everywhere" of ADR 0013 7.1 is a later decision).

**Switching production.** Run one reconcile
(`pnpm --filter @openagentix/api db:reconcile-bindings`, also run at start-up), watch
`oax_role_bindings_shadow_total{outcome="mismatch"}` stay at zero over a full login cycle
(including rolling-deploy and LDAP/OIDC users), then set `bindings` and restart. A mirror row that is
missing means *less* access under `bindings` (fail closed); an inheriting binding means *more*, by
design. Going back is `legacy` and a restart; nothing is migrated. Cache entries remember the mode
they were built for, so a switch needs no flush.

**Authz epoch.** Migration `0021_authz_epoch` makes the database bump `tenants.authz_epoch` of the
organisation root, in the same transaction, on every change that can alter what a cached principal
may do: insert, update or delete of `tenant_role_bindings`, `team_members` and `agent_role_bindings`;
delete of a team or an agent (whose cascade removes memberships and agent bindings) and a change of
its node (or, for an agent, its team);
update of `users.tenant_id`, `global_roles`, `platform_admin` or `disabled` and delete of a user;
creation or deletion of a child node and a change of a node's slug or placement. Because it is a
trigger, every writer is covered: the application, the `0019` home-move trigger, the reconcile
(startup, periodic, mismatch, CLI), an older application version, a directory sync and `psql`.

- A cached principal (`auth:<tokenId>`) stores the epoch it was built under and the root it belongs
  to. **Every request** reads the current epoch of that root (one primary-key read) and rebuilds the
  principal when it differs (`oax_authz_epoch_rejected_total{reason="stale"}`). The epoch is read
  *before* the grants it guards, so a racing change can only make an entry be rejected too early,
  never accepted too late.
- **Revocation window**: a revocation is effective on the next request after its transaction
  committed, on every replica, with or without Valkey (the epoch lives in the database). The residual
  is one request that was already past the epoch check when the revocation committed, and the
  `OAX_AUTH_CACHE_TTL_SECONDS` bound for anything that is *not* epoch-tracked (a role change that
  bypasses the tables above, which does not exist). Expiry is evaluated against `now` on every
  request, never at cache time, so an expiring binding stops at its second.
- The cache entry of the `bindings` path holds the raw grants as `serializeGrants` writes them and
  reads them back with `reviveGrants(value, { userId, homeTenantId })`; the entry must also carry the
  token's own id and secret hash. An entry under a wrong key, with another user's grants, with a
  malformed shape or built for the other read path is a miss (`reason="invalid"` or ignored) and the
  principal is rebuilt from the database.
- The tree snapshot (`tree:<rootId>:<epoch>`, 10 minutes) is keyed by the epoch, so a created,
  renamed or deleted node is visible at once. Cross-organisation: an epoch bump in one organisation
  never touches another's entries, and a snapshot holds the nodes of exactly one organisation.
- Moving a node (W13-11) must bump the epoch of the roots it touches; the `0021` trigger already
  does so for `parent_id`, `root_id` and `path` changes.

Rollback of the migrations: `apps/api/drizzle/down/0023_trb_source.down.sql` first (restores the old key
and the `0019` trigger body; an explicit grant that shares its key with a mirror row is deleted, every
other grant becomes a plain row the old reconcile may remove, so roll the application back first and
export the grants you need), then `apps/api/drizzle/down/0021_authz_epoch.down.sql` (the triggers; an
application version that compares the epoch then no longer sees revocations made outside it, so roll
the application back first), then `0019_trb_home_move.down.sql` (the trigger only), then
`apps/api/drizzle/down/0018_tenant_role_bindings.down.sql` drops both tables, the triggers
and the epoch column; `global_roles` is intact, so nothing is lost but the new tables.

## Subtree reads (ADR 0014, slice S3)

List routes accept `?scope=node|subtree` (default `node`: unchanged) and, with `subtree`,
`?tenantId=<id | slug path | slug>` to narrow. `scope=subtree` spans the acting node
(`X-OAX-Tenant`) and every descendant the caller can see, **each judged by the roles held there**
(an inheriting viewer of a division reads the division and below, a team scoped role only its
teams, ancestors, siblings and other organisations never take part). The node list is built on the
server; `tenantId` can only narrow it, and a node that is unknown, invisible or outside the subtree
is the same `404` as one that does not exist. Rows carry `tenant { id, slug, slugPath, name }`.

| Route | Permission | Notes |
| --- | --- | --- |
| `GET /v1/agents`, `/v1/runs`, `/v1/approvals` | `agents:read`, `runs:read` | team and agent scoped roles apply per node; the agent summary (last run, spend, budget) is computed per row's own node |
| `GET /v1/events`, `/v1/event-sources`, `/v1/connections` | `events:read`, `sources:read`, `connections:read` | sources and connections: `limit` (default 200, max 1000) and `cursor`, subtree mode only; platform connections owned by a node outside the scope are not listed |
| `GET /v1/costs/summary` | `costs:read` | every `groupBy`; `groupBy=tenant` labels groups with the slug path |
| `GET /v1/budgets` | `costs:read` | `nodes[]` with the budgets of every readable node, paged by slug path |
| `GET /v1/audit` | `audit:read` | only nodes where the caller holds it; viewers get 403 |

A subtree with more readable nodes than `OAX_TENANT_MAX_NODES_PER_ROOT` is `422 subtree_too_large`
(narrow with `tenantId`). `allTenants` cannot be combined with `scope=subtree`. On the `legacy` read
path, and for callers limited to their home node, the subtree is the acting node.

## Role-binding API (ADR 0014, slice S4)

```text
GET    /v1/tenants/{id}/role-bindings                    list the bindings bound on the node (users:read)
POST   /v1/tenants/{id}/role-bindings                    { userId, role, inherit, expiresAt? }  (inherit is required)
PATCH  /v1/tenants/{id}/role-bindings/{bindingId}        { role?, inherit?, expiresAt? }
DELETE /v1/tenants/{id}/role-bindings/{bindingId}
POST   /v1/tenants/{rootId}/role-bindings/enable-inheritance   { roles, dryRun }  (platform operators)
```

Everything is evaluated **on the node named in the path**, never on the acting node (`X-OAX-Tenant`
is ignored): an unknown or invisible node is the same `404`, a visible node without the permission is
`403`. The grantor's grants are re-read from the database inside the write transaction, which holds
the organisation's tree lock in shared mode and a per-organisation exclusive binding lock, so a grant
never races a node creation, two binding writes never interleave (the grantor's coverage and the
last-admin check see every earlier write), and a PATCH or DELETE locks the binding row. The effective
permissions come from the same resolver as the request path: since S5 an administrator who holds an
inheriting binding on an ancestor also grants there (`users:write` is inherited with the role), within
rules 2 and 6 below; the coverage check for `inherit` is the final rule. Token scopes intersect (a token scoped to `users:write` alone cannot grant `operator`).
Team and agent scoped bindings never give the right to grant.

| Rule (ADR 0014 section 7) | Where / error |
| --- | --- |
| 1 `users:write` on the node | `403 forbidden` |
| 2 nothing above one's own permissions; an inheriting grant needs an inheriting binding of at least the same role on the node or an ancestor | `403 grant_exceeds_own`, `403 inheritance_required` |
| 3 use-case bindings (`useCase`) | a tenant admin binds any use case; a **use-case administrator** (an `admin` binding limited to a use case, bound on this node) grants only for its own use case and its sub-use cases, on its own node, never node-wide and never `pentest` (`403 grant_exceeds_own`; `403 inheritance_required` when its own binding does not inherit). Needs `OAX_ROLE_BINDINGS_READ=bindings` (`409 use_case_requires_bindings_read`). See "Use-case bindings and attached nodes" |
| 4 the grantee must be visible: home node in the grantor's `users:read` coverage, or already holding a (node, team or agent) binding inside it | `404 user`, the same body and the same queries as for an unknown id |
| 5 the grantee's home organisation is the node's organisation | `404 user` for organisation members; platform operators get `422 cross_organisation_grant` (the `trb_same_org` trigger is the backstop) |
| 6 no self-grant, also not by changing one's own binding | `403 self_grant` (platform operators excepted) |
| 7 `pentest` | only a tenant admin of the node or above (an `admin` binding without use case that applies at the node) or a platform operator: `403 pentest_grant_forbidden`; `expiresAt` required (`422 expiry_required`) and at most `OAX_PENTEST_MAX_DAYS` ahead (`422 expiry_too_long`); needs `OAX_ROLE_BINDINGS_READ=bindings` (`409 pentest_requires_bindings_read`). See "The `pentest` role" |
| 8 the last inheriting `admin` of an organisation root | `409 last_admin` on DELETE or on a PATCH that narrows, re-roles or time-boxes it (platform operators excepted; disabled users and expiring bindings do not count) |
| 9 who may grant may revoke; a user may always remove their own binding | PATCH checks the old and the new tuple; DELETE of a foreign binding needs rules 1 and 2, of an own binding only rule 8 |

Other behaviour: `expiresAt` must be in the future (`422 validation_failed`); a user holds at most
`OAX_MAX_BINDINGS_PER_USER` (default 200) bindings (`422 binding_limit_exceeded`); the same role twice
from the same source on the same node is `409 conflict`. **Mirror rows** (`source: mirror`) accept
`PATCH { inherit }` only and cannot be deleted here (`409 mirror_binding`): their role follows the
user's `global_roles`. A grant is audited in the **binding node's partition**: `tenant.role_bound`,
`tenant.role_binding_changed { bindingId, field: role|inherit|expiresAt, from, to }`,
`tenant.role_unbound { bindingId, userId, role, reason: revoked|self }`, and `tenant.inheritance_enabled
{ roles, bindings, users }` on the root. The authz epoch is bumped by the triggers of migration `0021`,
so the next request of every cached principal of the organisation is rebuilt. A grant takes effect for
**request authorisation** only with `OAX_ROLE_BINDINGS_READ=bindings`; on `legacy` the rest of the API
still decides from `users.global_roles`, teams and agent bindings, and the shadow check reports the
difference. The role-binding API itself always reads grants from `tenant_role_bindings`, in both modes:
a grantor acts on the bindings it holds there (mirror rows and earlier grants) whatever the read path.
A role cannot be bound to a disabled user (`422 grantee_disabled`, checked after grantee visibility).

**Bulk opt-in.** `enable-inheritance` makes the plain (non-inheriting, unexpired, no use case) bindings
of the listed roles in one organisation inheriting, mirror rows included. `dryRun` defaults to `true`
and lists the bindings, the users and, per binding, the descendants that would gain access (at most
50 nodes per binding and 500 bindings; the caller is a platform operator, who sees every node of the
organisation, and nothing from other organisations appears). Bindings of disabled users are skipped.
It runs in one transaction under the same locks and writes one `tenant.role_binding_changed` per binding
plus `tenant.inheritance_enabled`. Everybody but a platform operator gets the same `403` for any tenant
id; an operator's API token needs the scope `users:read` for a dry run and `users:write` to apply.

## Write inheritance and sub-tenants (ADR 0014, slice S5)

The read-only clamp is gone: an inheriting binding (`inherit = true`, opt-in per binding as before) gives
its **whole role** at every node below its own, so an inheriting `admin` of a division administers the
division and its descendants. Nothing changes for an installation that does not use inheritance: without
`inherit = true` no binding reaches below its node, and with `OAX_ROLE_BINDINGS_READ=legacy` (the
default) the read path is untouched; the two tenant routes below stay operator-only there, as before.

**What stays clamped (the rules, each with a test).**

1. **The role is the ceiling.** An inherited binding gives exactly what the same role gives held at the
   node, minus restrictions (S9), never more. Property tests: `packages/core/test/tenant-roles.test.ts`.
2. **Down only, by opt-in.** Never up, never sideways, never across organisations, never from team or
   agent bindings (those are node-local). Same property tests, against a parent-walking reference.
3. **No grant above one's own role, none outside one's coverage.** A grantor gives only roles whose
   permissions it holds at the node, and an inheriting grant needs an inheriting binding of at least that
   role on the node or an ancestor (grant rules 2 and 6, `apps/api/test/role-binding-api.test.ts`,
   `grant-authority.test.ts`). Nobody grants to themselves; the last inheriting admin of a root stays.
4. **Operations that name a node are decided on that node**, from grants re-read inside the transaction,
   never on the acting node (`X-OAX-Tenant`), and an invisible node is the same `404` as an unknown one.
5. **Budget, secret references and organisations stay operator-only.** A tenant admin renames and creates
   sub-tenants; it does not set ceilings, secret patterns or create organisations.
6. **Token scopes still intersect** with the effective permissions of every node; creating and renaming
   need the `settings:write` scope.

**Creating a sub-tenant.** `POST /v1/tenants { parentId, slug, name }`. With `OAX_ROLE_BINDINGS_READ=bindings`
a non-operator needs an **inheriting** `admin` binding (no use case, unexpired) on the parent or an ancestor,
so nobody creates a node they cannot administer: `403 inheritance_required` for a direct admin,
`403 forbidden` for anybody else, `404 tenant` for a parent the caller cannot see (same body as an unknown
id). `admin` and `monthlyBudgetUsd` in the body are operator-only (`403`), organisations (no `parentId`) too.
The limits are the same for everybody: `OAX_TENANT_MAX_DEPTH` (`422 tenant_depth_exceeded`),
`OAX_TENANT_MAX_NODES_PER_ROOT` (`422 tenant_node_limit_exceeded`, race-free: creations are serialised by
the installation-wide creation lock) and the slug rules (`400`; a slug that is taken or overlaps another in
secret names is `409 this slug is not available` for non-operators, **without naming the other tenant**;
the bare fact that a slug is taken cannot be hidden while slugs are installation-wide, W13-7). It runs
in one transaction with the organisation's tree lock held **shared** (ADR 0014 6.2), re-reads the creator's
grants under it, and writes `tenant.created { slug, name, authority, parentId, depth }` in the partition
of the **new** node. The insert bumps the authz epoch (trigger `0021`), so the creator acts in the new node
with its next request. Not done: the `parent_admins_do_not_inherit` warning for operators.

**Renaming.** `PATCH /v1/tenants/{id} { name }`: an **inheriting** `admin` binding on the node or an ancestor
(`403 inheritance_required` for a direct admin, `403` for anybody else), `404` for an invisible node;
`monthlyBudgetUsd` and `secretRefs` answer `403` to everybody but operators. Requiring the inheriting form
keeps installations that do not use inheritance unchanged. Audited as `tenant.updated` in the node's partition.

**Why may this user do that?**

```text
GET /v1/me/access?tenant=<id|slug path>          own permissions at a node (default: the acting node)
GET /v1/tenants/{id}/access?userId=<uuid>        another user's, needs users:read on {id}
```

Both answer `{ tenant, user, platformAdmin, limitedByToken, bindings[], permissions[] }`: every
permission with the kinds of binding that give it (`direct`, `inherited`, `team`, `agent`) and every
binding with the node it is bound on, `inherit` and expiry. They use the resolver of the request path, so
they cannot disagree with what is enforced (a test compares them with `GET /v1/me` at every node); this is
the basis for the `actions` block of #160. A node the caller cannot see is `404 tenant`, a user it cannot
see `404 user` (the grantee visibility of the grant API), token scopes are applied and reported as
`limitedByToken`.

**Rolling deploy.** Old pods lock with the single-key `hashtext(rootId)`, new pods with the two-key form, so
they do not exclude each other: drain the old pods before switching `OAX_ROLE_BINDINGS_READ=bindings` and before
creating nodes or grants.

**Locks.** The tree lock and the binding lock now use the two-key form `(namespace, hashtext(rootId))`
(`apps/api/src/services/tree-lock.ts`, #288 item 4). Replicas of the old and the new version do not
exclude each other during a rolling deploy for the duration of the rollout; do not create nodes and
grants at the same time as deploying.

**User lifecycle across the tree (review of #302).** A user is managed through the node they live on, but
their grants can sit on nodes above the manager. With `OAX_ROLE_BINDINGS_READ=bindings`, a non-operator who
changes another user's account in any way (`PATCH /v1/users/{id}`: disable, **re-enable**, rename, `globalRoles`), or
revokes or lists their API tokens, is checked in a transaction under the tree lock (shared) and the binding lock, from grants
re-read there: for **every** unexpired node binding of the target the caller needs `users:write` on that node,
the permissions of the role, and (when the binding inherits) coverage of the subtree, otherwise `403`; the
nodes of the target's team memberships and agent bindings need `users:write` as well. A
platform operator account is managed by operators only (`403`), the last-admin rule (`409 last_admin`)
covers disabling and removing the mirror admin role (closes #288 item 1 for these paths; deleting users is
not an API). Operators and a user acting on their own account are exempt from the first check (the last
admin rule still applies). A division admin therefore cannot lock out or demote the root admin who happens
to live below it. `GET /v1/tokens?all=true` leaves out tokens of users the caller may not manage. With
`legacy` nothing changes (no authority exists below the home node there).

**Budgets.** Budgets are per node until W13-4: a child would spend outside its parent's cap. A tenant admin
therefore cannot create below a node that has a monthly budget on it or on an ancestor (`403 budget_capped`);
an operator creates the node and may cap it.

**Slugs and secrets.** Secrets are named `<slug>.*`, so a slug is a claim on a secret namespace. A tenant
admin cannot claim a slug that an operator reserved (`OAX_TENANT_RESERVED_SLUGS`, comma separated, collides
in canonical form like slugs do) or whose prefix already holds secrets in a backend that can be listed (the
default env and file resolver can; for other backends use the reserved list). The answer is the same
`409 this slug is not available`. **Never pre-stage secrets under a prefix you do not want claimed, and delete
the secrets of removed tenants.** If the secrets directory cannot be listed the slug is refused (fail closed).
Secrets staged outside the API's view (run nodes, worker environments, resolvers without `hasEntriesUnder`)
are protected **only** by `OAX_TENANT_RESERVED_SLUGS`.

**Order of checks (creation).** Pre-check from the cached grants (no lock, no transaction), then in the
transaction: tree lock (shared), parent re-read, authorisation from re-read grants, installation-wide
creation lock, depth, node limit, budget cap, slug. Limits answer before the slug, so the `409` for a taken
slug is only reachable by a caller who is authorised and within the limits. There is no rate limit for
non-operator creation beyond the global one; the node limit per organisation is the bound.

Renaming does not bump the authz epoch (the name is not part of any decision); the tree snapshot carries slugs
only. `tenant.updated` records `authority`.

## The `pentest` role (ADR 0014, slice S6)

`pentest` is time-boxed read-only access for a penetration test: `agents:read, runs:read, events:read,
costs:read, sources:read, connections:read, policies:read, audit:read, audit:verify, users:read,
tokens:read, settings:read`. It has no write, execute, approve, cancel or publish permission, **no token
creation** (`tokens:write`) and **no `audit:export`**; secret values are unreadable for every role.

**Granting** (`POST /v1/tenants/{id}/role-bindings`, `role: "pentest"`; rule 7 of the grant rules):

- only a tenant admin of the node or above (an unexpired `admin` binding without use case that applies at the
  node, directly or by inheritance) or a platform operator; integrator, viewer, team admin and token scopes
  without `users:write` are refused (`403`); the other rules (1 to 6, 8, 9) apply unchanged;
- `expiresAt` is required (`422 expiry_required`) and at most `OAX_PENTEST_MAX_DAYS` (1 to 30, default 30) from
  now (`422 expiry_too_long`; exactly the maximum is allowed). `PATCH` can only shorten the expiry,
  change `inherit` or the role: a later `expiresAt` is `422 expiry_extension_requires_new_grant` (remove the
  binding and grant again, which is a fresh `tenant.role_bound`), clearing it is `422 expiry_required`; the
  maximum is checked only when the expiry changes, so narrowing `inherit` still works after the maximum was
  lowered. A `PATCH` that turns a binding into `pentest` needs the same expiry; changing or deleting a pentest
  binding of somebody else needs the same authority as granting it (a user can still delete their own);
- `inherit: true` is allowed (a test of a whole organisation is bound on the root) and needs inheriting
  coverage like any inheriting grant; the role then reads the subtree and nothing else. The database also
  refuses a `pentest` row without expiry (`trb_pentest_expiry`);
- the grant needs the resolver read path: with `OAX_ROLE_BINDINGS_READ=legacy` the role would have no effect,
  so it is refused (`409 pentest_requires_bindings_read`).

**Expiry** is evaluated by the resolver on every request (`appliedAt`: a binding contributes at `t - 1 ms` and
not at `t`), from the grants of a cached principal as well; it does not wait for the reaper or for a cache
entry to age out. A session token that outlives the binding simply has no pentest permissions any more.

**Audit** (partition of the binding's node): `tenant.role_bound { role: pentest, expiresAt, inherit, grantedBy }`
on grant, `pentest.session_started { tenant, actingTenant, expiresAt, inherited, session }` on the first
request of a token in which a pentest binding is in effect (also if that request is refused; one entry per
token, binding node and expiry, kept in `pentest_sessions` so replicas and restarts do not repeat it; single
reads are not audited, denied requests are audited as `access.denied` as before), `pentest.expiry_warning`
24 hours before the end, and `tenant.role_expired { bindingId, userId, role, expiresAt }` when the reaper
deletes the binding after its expiry.

**Reaper** (`OAX_BINDING_REAPER_INTERVAL_SECONDS`, default 60 s, once at start-up): deletes expired bindings of
any role, writes the notices below, purges notices after 30 days. Each binding is handled in its own transaction
under `for update skip locked`, so several replicas can run it. It only tidies up; access never depends on it.

**Notices.** There is no mail, webhook or push mechanism in the platform, so the only channel is an in-app notice
(`GET /v1/me/notices`, table `user_notices`, kept 30 days): the tenant admins of the node (direct and
inheriting, enabled users) and the grantor get `pentest_granted` (also when the expiry is moved),
`pentest_expiring` 24 hours before the end (once; a grant that ends within 24 hours is its own notice) and
`pentest_expired`. **Gap:** nobody is actively told; an administrator sees the notices only when the console
or a client reads that endpoint. Delivery by mail or webhook needs a notification channel that does not exist
yet; operators who need it can forward the `tenant.role_bound`, `pentest.expiry_warning` and
`tenant.role_expired` audit entries (audit export) to their own channel.

**Tests**: `apps/api/test/pentest-role.test.ts` (grant matrix, expiry rules, boundary at `t - 1 ms` / `t` with
a cached principal, session event, reaper and notices, route-table walk over every route: each permission
route that pentest does not hold and each write on the tenant tree answers `403`, each read route does not;
token creation, audit export, bindings and connections; last-admin rule unaffected).

## Locating a resource's tenant (ADR 0014, slice S7)

```text
GET /v1/locate/{kind}/{id}      kind = agent | run | approval | event-source | connection
-> 200 { "tenant": { "id", "slugPath", "name" } }
-> 404 { "error": "not_found", "message": "resource not found" }
```

For deep links: a console that acts in one tenant asks which tenant owns `/runs/<id>` and switches
to it (`X-OAX-Tenant: <slugPath>`) instead of showing a 404. The answer needs an authenticated
caller who holds the **read permission of the kind at the owning node**, not merely visibility of
that node:

| Kind | Permission at the owning node |
| --- | --- |
| `agent` | `agents:read` (team and agent scoped bindings honoured) |
| `run`, `approval` | `runs:read` (an approval's agent scope goes through its run) |
| `event-source` | `sources:read` |
| `connection` | `connections:read` (the node that owns the connection) |

The permissions are those of the resolver at the **owning** node (direct, inherited, team and agent
bindings), never those of the acting node, and the answer does not change with `X-OAX-Tenant`.
API token scopes are applied. `viewer` therefore locates agents, runs and approvals but not event
sources or connections; `pentest` (read-only) locates all five. With `OAX_ROLE_BINDINGS_READ=legacy`
only the caller's home node can answer.

What the caller cannot tell apart: a 404 is the same for an id that does not exist, a resource of a
sibling or an ancestor node, of another organisation, of a visible node where the permission is
missing (404, not 403), and of a kind the token scopes exclude. Body, status and headers are
identical, and every request runs the same statements in the same order (the resource row by primary
key, the caller's home node, the node row of the answer or of the home node as a stand-in), so
neither a status nor a statement count nor a lookup by a caller-chosen reference separates them.
The owner is compared in memory with the epoch-keyed tree snapshot of the caller's own organisation.
A malformed `id` (not a UUID) or a `kind` outside the list is `400` before any lookup. The response
carries only the owning node, never data of the resource. Its `slugPath` contains the slugs of
ancestors the caller may not see (like `X-OAX-Acting-Tenant`); only the name of the owning node is
returned. A connection is located at the node that owns it, so a platform connection owned by a node
outside the caller's reach is not locatable for tenant users.

Misses are audited as `access.denied` (`payload { permission, resource: <kind>, via: "locate" }`,
`target` = the requested id, partition of the acting node), for existing and unknown ids alike, never
naming the owner. At most 3 entries per user and kind per 60 seconds are written (shared cache, so
across replicas with Valkey); further misses in the window are not audited, so probing cannot flood
the chain and the decision never depends on whether the id exists. A failing audit write does not
change the 404. Platform operators locate every resource.

## Use-case bindings and attached nodes (ADR 0014, slice S8)

A **use case** is the `labels.useCase` of an agent (stored on the agent as `agents.use_case` and on the
cost ledger as `cost_ledger.use_case`). `support` covers `support` and `support/billing`, matched per `/`
segment (never `supported`); the syntax is segments of letters, digits, `.`, `_` and `-` separated by
`/` (at most 200 characters), the same for a binding and for an attachment. A resource without a
label belongs to the whole node and is covered by no use case.

### What a use-case binding gives

`POST /v1/tenants/{id}/role-bindings { userId, role, inherit, useCase }` binds a role **limited to a use
case** on that node. A **use-case administrator** is an `admin` binding with a use case. The binding
carries the role's permissions on the resources that have a use case and nothing node-wide:

| Use-case permissions | Filtered by |
| --- | --- |
| `agents:read/write/publish` | `agents.use_case` (list, detail, versions, members, draft, publish, disable, dry run) |
| `runs:read/execute/cancel/approve` | the use case of the run's agent (runs, steps, stream, stream token, stats, approvals, decisions, manual runs) |
| `events:read` | the use case of the agent the event's source triggers (an event without a source or agent is node-level) |
| `costs:read` | `cost_ledger.use_case` (summary in every grouping, export) and the use-case lines of the budgets |
| `audit:read`, `audit:export` | entries whose `target` is an agent of the use case or whose `run_id` is a run of such an agent (entries about people, settings and connections are node-level) |
| `users:read`, `users:write` | only the role-binding API: the bindings of the own use cases (rule 3) |

Connections, event sources, policies, tokens, users, teams, settings, audit verification and checkpoints,
tenant structure and the demo and plan helpers are **never** part of a use-case binding: the routes answer
`403` before the handler runs. A use-case binding applies at its own node only (it does not inherit down
the tree); with `inherit: true` it also reaches the nodes attached to the use case (below). The grant
rules: a tenant admin binds any use case under rules 1 and 2; a use-case administrator under rule 3 (own
use case and sub-use cases, own node, never node-wide, never `pentest`, an inheriting grant needs an
inheriting binding of its own); it lists, changes and revokes only bindings of its own use cases (any
other binding of the node, and any unknown one, is the same `404 role binding`). `pentest` cannot be
limited to a use case (`422`). Use-case bindings need `OAX_ROLE_BINDINGS_READ=bindings` to be created
(`409 use_case_requires_bindings_read`); on the legacy read path existing rows have no effect.

**Fail closed.** `hasPermission`, `visibleTeams` and `visibleAgents` ignore a use-case binding, so a service
that was not taught about use cases gives it no access. A route opens for a use-case holder only when it
is listed as `scoped` in the route registry (`apps/api/src/http/use-case-policy.ts`); every route that
serves a signed-in principal must be listed (`scoped`, `denied` or `self`, with the reason by group), a
test fails for a route without an entry and for a stale entry, and a route that is missing from the
registry at run time is refused to use-case holders. `denied` routes (and `authenticated` routes that
return tenant data) refuse a caller whose bindings are all use-case bindings; a caller who also holds a
node-wide, team or agent binding keeps what that binding gives. Hidden objects are a plain `404`, identical
in body to an unknown id. Aggregates (costs, budgets, stats) and their caches are keyed by the use-case
scope. API token scopes apply to use-case bindings like to any other.

Writes stay inside the use case: an agent written or published under a use-case binding must carry a
label inside it (a draft or version cannot be relabelled out of the use case, `403`), and a use-case writer
creates agents that belong to **no team** (a team brings its connections, which are not part of a use
case; naming a team in `owner` is `403`). Validation of a draft by a use-case holder uses the connections
of the whole tenant, never those of a team it names.

Notes on what the filters mean: the use case of a run, an approval and an event is the **current** use case
of its agent (a relabelled agent takes its history with it); costs keep the label they were booked with.
The budget view of a use-case holder shows the limits and spend of its use cases only (`tenant.limitUsd`
is `null`, `tenant.spentUsd` counts the holder's use cases, no team lines, no alerts of the node limit; a
budget of a wider use case is not shown).

**Agents of a team (review of S8).** On an agent that belongs to a team a use-case binding gives the
read side only: `agents:read`, `runs:read`, `runs:approve`, `costs:read`, `events:read`, `audit:read` and
`audit:export`. Editing, publishing, dry-running, running and cancelling a team's agent need a team or node
permission, because a team brings its connections and those are not part of a use case. Relabelling an
agent of a team into another use case hands its runs and costs to that use case's administrators, so it
needs node-level authority for the permission, or the administrator of the target use case who also holds
the permission for the team (`403` otherwise, at draft and at publish). The same holds for a team-less agent
(a writer bound to that one agent cannot relabel it into a use case), and creating an agent of a team that
carries a use case label is **not** restricted (accepted: team engineers create labelled agents today; follow-up #340). The read side
on team agents includes everything attached to its runs: run-scoped audit entries (for example
`mcp.relay.call`, `mcp.relay.denied`, `mcp.egress.refused`, `agent.members.set`), raw event payloads of its
sources, and cost groupings that name teams.

**Accounts, teams and role grants of a node.** Creating a local user, changing `globalRoles`, creating,
renaming and deleting teams, and setting team and agent members need **node-level** authority: on the
`bindings` read path an `admin` binding without use case that applies at the node (direct or inherited;
re-read under the tree and binding locks) and every role handed out must be within the permissions held
at the node; on `legacy` the caller's global bindings decide. Team-scoped, agent-scoped, use-case and
attached bindings carry `users:write` at the route but cannot mint roles. (Before this change a
team-scoped administrator could create an account with a node-wide role; that existed on `main` before
the slice.)

Known limits, accepted: use-case writers create agents without a team, and such agents can use every
team-less connection of the node ("an inherited connection can be used by the use case's agents as before",
ADR 0013 section 7.2); `POST /v1/agents/validate` can therefore tell them whether a connection name exists
in the tenant. Costs keep the use case they were booked with: after an agent moves to another use case
its name is hidden from the cost summary of the old use case (the id stays). The node limits (`monthlyBudgetUsd`,
`secretRefs`) of `GET /v1/tenants` are hidden from callers with use-case bindings only.

### Attached nodes

`PATCH /v1/tenants/{id} { useCase }` attaches a **child** node to a use case of its parent (`null`
detaches it). Attaching is a grant to every inheriting use-case administrator of that use case on the
parent, so it needs an **inheriting tenant admin on the parent** (an `admin` binding without use case on
the parent or an ancestor that inherits) or a platform operator: a use-case administrator never attaches,
not even to its own use case, and an admin bound only on the child itself does not either (`403`). The
check runs on the parent from grants re-read under the shared tree lock; token scopes need
`settings:write`. A root cannot be attached (`422 use_case_on_root`), a malformed value is `422`. It is
audited as `tenant.detached` (the use case left) and `tenant.attached` (the one joined) in the partition of
the child **and** of the parent, and bumps the authz epoch, so cached principals see it on their next
request.

A use-case binding **with `inherit: true`** on the parent then applies in the attached child **and its
whole subtree**, as an unrestricted binding of the same role (source `attached`); without `inherit` it
never reaches an attached node (owner decision 6). Attaching or detaching changes effective permissions
only inside the subtree of the attached node and only for holders of inheriting use-case bindings on its
parent whose use case covers the attached one (property test). A use-case administrator working inside an
attached node does not get tree or grant authority there (it cannot create, rename, attach or grant).

### Locate and `scope=subtree`

`GET /v1/locate/...` honours the use case of agents, runs and approvals. `scope=subtree` on agents, runs,
approvals, costs, budgets, events and audit adds the use-case clause per node: a use-case binding covers
its own node only (the same use case on a sibling node is not covered), and an attached node is covered
unrestricted. `GET /v1/tenants/{id}/access` and `GET /v1/me/access` show the `useCase` of each binding and,
per permission, the use cases it is limited to.

Migration `0031_tenant_use_case_attach` adds `tenants.use_case` (nullable, syntax check, a root cannot
carry one), an index on `(parent_id, use_case)` and makes the epoch trigger fire on a change of
`use_case`. The grants loader lists the attached children of every inheriting use-case binding (cache wire
version 2).

## Role restrictions (ADR 0014 section 5, slice S9)

A restriction **removes permissions from a role** for the bindings at a node and below. It is the tool to
say "operators of this division may run agents but not approve" without inventing a new role.

```text
GET    /v1/tenants/{id}/role-restrictions                          the restrictions set on this tenant, by role
PUT    /v1/tenants/{id}/role-restrictions   { role, permissions }  set the complete list for one role (idempotent)
DELETE /v1/tenants/{id}/role-restrictions?role=operator[&permission=runs:approve]
```

**Which bindings a restriction at R narrows.** A binding b is narrowed iff R is on the chain of the node
b is **bound on**: b is bound on R or on a descendant of R. It does not matter where b is felt.

| Binding | Restriction at R | Narrowed? |
| --- | --- | --- |
| bound on R (direct, or inheriting into R's subtree) | R | yes, at R and everywhere it applies below |
| bound on a descendant of R | R | yes |
| bound on an **ancestor** of R, inheriting through R | R | **no**: a descendant cannot restrict the oversight of its ancestors |
| bound on a sibling, cousin or another organisation | R | no (it does not apply there at all) |
| team or agent binding on R or below (node-local) | R or an ancestor of that node | yes |
| `pentest` binding on R or below | R or an ancestor | yes (it is a role like any other) |
| `admin` binding | any | **never**; the table refuses `admin` and the resolver ignores it |
| platform operator | any | **never** (they are `admin` everywhere) |

Consequences, spelled out because they surprise:

- **Restrictions never add**. They only remove from the permissions the role gives; the resolver computes
  `role permissions minus restrictions` and nothing else (property tests: adding a restriction never adds a
  permission anywhere; a restriction never changes what a binding from above its node grants; platform admins
  and `admin` are never narrowed; seeded, against the parent-walking reference of the resolver tests).
- **A user can hold the permission through another binding.** Someone with an inheriting `operator` binding on
  the root *and* a direct `operator` binding on a division that restricts `runs:approve` keeps `runs:approve`
  in the division through the root binding. A restriction narrows what is bound there and below, not what an
  ancestor grants. To take the permission away from that user, restrict `operator` at the node where the root
  binding sits (or narrow the binding itself).
- **A node can be visible and still empty.** Restricting all permissions of a role leaves the binding in place
  (the node stays visible, `GET /v1/me` lists the binding) but with no permissions.
- **Use-case bindings** are narrowed at the node they are bound on; in an attached child they are the
  unrestricted binding of the same role (ADR 0014 section 3.3), so a restriction on the attached child does not
  narrow them. Restrict at the node the use-case binding sits on.
- **Locate, access views, grant rules, `scope=subtree`, the approval role checks and the console's visible
  nodes** all read the same resolver output, so they apply restrictions the same way. The restrictions are
  loaded with the principal's grants (`RawGrants.restrictions`, cache wire version 3): there is no second
  implementation.

**Who may write.** An inheriting `admin` binding (without use case) on the tenant or an ancestor, or a platform
operator; an API token additionally needs the `users:write` scope. A restriction narrows every binding of the
role in the whole subtree, so the writer must administer the whole subtree, like for an inheriting grant:

- a non-inheriting administrator of the node: `403 inheritance_required`;
- a use-case administrator, an administrator reached only through an attached node, team and agent admins and
  every other role: `403`; the restricted role itself cannot lift its restriction (only `admin` writes, and
  `admin` cannot be restricted);
- a node the caller cannot see (unknown, sibling, ancestor, other organisation): `404 tenant`, the same
  answer as an unknown id, before any other check. An administrator of a division cannot restrict the roles
  of the parent.

**Validation.** `role` is any role but `admin` (`422 restriction_on_admin`); unknown roles are
`422 unknown_role`. Every permission must exist (`422 unknown_permission`) and be one the role holds
(`422 permission_not_in_role`). `pentest`, `agent-developer` and `agent-maintainer` are restrictable like the
other roles. At most `OAX_MAX_ROLE_RESTRICTIONS_PER_NODE` (default 100) entries per tenant
(`422 restriction_limit_exceeded`). `PUT` replaces the list of the role at that tenant; an empty list removes
it. `PUT` and `DELETE` are idempotent: a call that changes nothing writes no audit entry and does not bump the
epoch. `GET` needs `users:read` on the tenant and lists the tenant's own restrictions; restrictions of
ancestors appear as `denied` entries in the access views.

**Explanation (A6).** `GET /v1/me/access` and `GET /v1/tenants/{id}/access` add `denied[]`: every permission
that a role binding would give if a restriction had not removed it and that no other binding gives, as
`{ permission, reason: "role_restricted", role, restrictedAt: { tenantId, tenantSlugPath } }`. When several
nodes remove the same permission the deepest one is named.

**Read path.** Restrictions are applied only with `OAX_ROLE_BINDINGS_READ=bindings`, like inheritance. With
`legacy`, `PUT` and `DELETE` are refused with `409 role_restrictions_require_bindings_read` (a restriction
that does nothing would be a false promise), `GET` works and reports `enforced: false`, and rows written
before a switch back to `legacy` are ignored; the shadow comparison of the two read paths ignores
restrictions too.

**Caches and races.** Migration `0033_role_restrictions_epoch` makes the database bump the authz epoch of the
organisation on every insert, update or delete of `tenant_role_restrictions` (any code path, a cascade
excepted: deleting a node bumps through the node itself). A cached principal built under the old epoch is
rebuilt on its next request; there is no extra TTL window beyond the existing one for multi-replica installs
without a shared cache (`OAX_AUTH_CACHE_TTL_SECONDS`). Writes run in one transaction that takes the tree lock
(shared) and the binding lock of the organisation, in the same order as the grant paths, and re-read the
writer's grants from the database, so a restriction write cannot race a change of the writer's own
administrator binding or a node move. Replicas of the previous version do not know restrictions: during a
rolling deploy they ignore them, so drain old pods before writing the first restriction.

**Audit.** `tenant.role_restricted { role, permissions }` (the permissions added) and
`tenant.role_restriction_removed { role, permissions }`, in the partition of the restricted tenant, actor =
the writer. Names only.

**Integration points.** ADR 0017 S1 (lifecycle reviews, approver eligibility) is reviewed separately; its
approver-eligibility code reads role permissions without node restrictions today. When it lands it must call
the resolver (`appliedAt`, which now carries the restrictions) instead of `ROLE_PERMISSIONS`.

## Audit

The hash chain is global (one chain keeps ordering and tamper detection simple); every entry carries
its tenant as a **partition key outside the hash**. Tenant users list and export only their own
partition. `POST /v1/audit/verify` verifies the whole chain but, for tenant users, reports only
issues that concern their own entries and no foreign counts or head hashes. Per-tenant chains with
Merkle proofs are on the roadmap.

## Operations

- Create the first extra organisation: `POST /v1/tenants` with `{ "slug": "acme", "name": "Acme",
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

