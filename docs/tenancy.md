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
child, an inheriting binding on an ancestor does, but only for **read** permissions
(`INHERITED_READ_ONLY`: `*:read` and `audit:verify`) until slice S5 lifts the clamp. API token
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
and use case of a node need storage that arrives with W13-2 and W13-8.

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
- `tenant_role_restrictions` and `tenants.authz_epoch` exist but are unused until later slices.
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
- `pentest` exists in the role set (read-only, ADR 0014 section 8) but cannot be granted before S6:
  the API, group mappings and the console reject it.

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
  resolver (`effectiveAt`, ADR 0014 3.2) decides at the **acting node**, with the read-only clamp for
  inherited bindings; the legacy sources are compared (`authoritative="bindings"`), so a mirror that
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
permissions come from the same resolver as the request path, **read-only clamp included**: an
administrator who only holds an inheriting binding on an ancestor reads the subtree but cannot grant
there until slice S5 lifts the clamp; the coverage check for `inherit` is already written to the
final rule. Token scopes intersect (a token scoped to `users:write` alone cannot grant `operator`).
Team and agent scoped bindings never give the right to grant.

| Rule (ADR 0014 section 7) | Where / error |
| --- | --- |
| 1 `users:write` on the node | `403 forbidden` |
| 2 nothing above one's own permissions; an inheriting grant needs an inheriting binding of at least the same role on the node or an ancestor | `403 grant_exceeds_own`, `403 inheritance_required` |
| 3 use-case bindings | `422 use_case_bindings_unsupported` until S8 (the use-case admin rule arrives with it) |
| 4 the grantee must be visible: home node in the grantor's `users:read` coverage, or already holding a (node, team or agent) binding inside it | `404 user`, the same body and the same queries as for an unknown id |
| 5 the grantee's home organisation is the node's organisation | `404 user` for organisation members; platform operators get `422 cross_organisation_grant` (the `trb_same_org` trigger is the backstop) |
| 6 no self-grant, also not by changing one's own binding | `403 self_grant` (platform operators excepted) |
| 7 `pentest` | not accepted before S6 (`400 validation_failed`); its expiry rules arrive with it |
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

