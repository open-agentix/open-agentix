# ADR 0014: Role inheritance over the tenant tree

- Status: Proposed. Slices S1, S1b, S2, S3 and S4 are implemented (see "Implementation status" below); S5 to S10 are open.
- Date: 2026-10-10
- Plan items: W13-6 (roles and visibility), with the parts of W13-2 that roles need (the pure
  resolver pattern); wave 13 of the [implementation plan](../IMPLEMENTATION-PLAN.md)
- Builds on: [ADR 0007](0007-tenants-as-isolation-boundary.md) (tenants as the isolation
  boundary), [ADR 0013](0013-hierarchical-tenants-and-setup-modes.md) (tenant tree, section 7:
  visibility and roles), [ADR 0012](0012-connections-instances-scopes-and-data-protection.md)
  (connections, data protection, operator access), [ADR 0002](0002-audit-hash-chain.md) (audit)
- Amends: ADR 0013 section 7.3 (a binding applies to the subtree **only when it opts in**,
  `inherit: true`; migrated and new bindings default to the bound node only) and section 13
  (role-binding API shape)
- Unblocks (UX, [`docs/ux/multi-tenant-ux.md`](../ux/multi-tenant-ux.md) section 13): A2 #156,
  A3 #157, A4 #158 (`scope=subtree`), A6 #160, A9 #163 and through them U5, U6, U8, U9, U11;
  A5 #159 / U7 additionally need W13-2

## Implementation status

| Slice | State | Notes |
| --- | --- | --- |
| S1 | implemented (PR for #186) | Migration **`0018_tenant_role_bindings`**, not 0017: `0016_agent_disable` and `0017_approvals_tenant_status_idx` took the numbers after this ADR was written (follow-up of #198). Wherever this text says `0017_tenant_role_bindings`, read 0018; later slices continue from 0019. |
| S1b | implemented (PR for #216, #217) | Prerequisites for S2, **without changing the read path**: reconcile of the `global_roles` mirror (start-up, periodic, mismatch-driven, CLI), the same-key rule, migration **`0019_trb_home_move`**, a serializable form for cached raw grants and a single-statement `loadRawGrants`. See below. |
| S2 | implemented behind a flag (PR for #187, #227) | Acting node for every visible tenant, read-only inheritance, authz epoch and the resolver as read path **behind `OAX_ROLE_BINDINGS_READ=legacy|bindings`** (default `legacy`). Migration **`0021_authz_epoch`**. See "S2" below. |
| S3 | implemented (PR for #188) | `?scope=node` or `subtree` and `?tenantId=` on the list routes, `tenant` on their rows. No migration. See "S3" below. |
| S4 | implemented (PR for #189, #226) | Role-binding API, grant rules 1 to 9, audit, bulk opt-in; migration **`0023_trb_source`** (mirror rows get their own key). See "S4" below. |

Differences between the plan below and what S1 shipped:

- **Shadow mode instead of switching the read path.** The resolver is wired behind the existing
  permission code but the legacy bindings stay authoritative: `IdentityService.bindingsFor` still
  builds the bindings from `users.global_roles`, team memberships and agent bindings, then resolves
  the same user from `tenant_role_bindings` at the home node and compares both
  (`oax_role_bindings_shadow_total{outcome=match|mismatch|error|skipped}`, at most two checks at
  once, a rate-limited warning with the differing lines, switch `OAX_ROLE_BINDINGS_SHADOW`, default
  on). Switching the read path is the first step of S2, once the mismatch counter has stayed at
  zero and the mirror has been reconciled once (rows written by an older application version during
  a rolling deploy or after an application-only rollback are not mirrored; #216, #217).
- `RoleBinding` gained the optional `permissions`, `useCase` and `source`; the checks read the
  narrowed `permissions` (never wider than the role, `bindingPermissions`).
- The resolver takes the acting node's placement (`id`, `rootId`, `path`) instead of a tree
  snapshot: the chain comes from the path. `visibleNodeIds` takes the snapshot for the visible set.
  The inheritance clamp (`INHERITED_READ_ONLY`, default on) and role restrictions are already in the
  pure resolver and its property tests; nothing feeds restrictions before S9.
- `implicitPlatformAdmin` (default `true`, ADR 0013 7.1) is switched off by the shadow check
  because today a platform operator acts with the roles of its home tenant.
- Use-case bindings and `pentest` without an expiry never apply in the resolver (fail closed).
- `GRANTABLE_ROLES` (the six legacy roles) is what the API, the console, group mappings and the
  agent `approverRoles` accept; `pentest` is refused there until S6.
- The migration also adds a guard trigger on `users` (a user cannot change organisation while
  bindings of the old one exist) and a `FOR SHARE` lock on the user row in `trb_same_org`, so a
  concurrent binding insert and home change cannot both succeed.
- The backfill audit summary (`tenant.role_bound` with `source: migration`) is not written by S1: the
  audit chain is appended by the application, not by SQL. S4 writes the grant events but not this summary.

S1b (prerequisites for S2, #216, #217; the legacy path still decides):

- **Reconcile.** `users.global_roles` stays the source of truth until S2. The mirror rows (non-inheriting,
  non-expiring, no use case, home node, six grantable roles) are recomputed from it in both
  directions, one transaction per user, user row locked first (`FOR NO KEY UPDATE`): at start-up,
  periodically (`OAX_ROLE_BINDINGS_RECONCILE_INTERVAL_SECONDS`), for the user of a shadow
  `mismatch` (rate-limited, one at a time) and by hand (`db:reconcile-bindings [--dry-run]`).
  Counted in `oax_role_bindings_reconcile_fixes_total` / `..._runs_total`. **S2 starts when one
  reconcile has run and `mismatch` stays at zero.** This replaces the "startup task under the
  migration advisory lock" of the issue: per-user row locks make concurrent replicas safe without
  a global lock.
- **Same-key rule (fail closed).** `trb_uq` ignores `inherit` and `expires_at` and was kept: a
  legacy role has exactly one slot. Adding a role never overwrites or hides a row of another shape
  there (reported as `blocked`); *removing* a role through `global_roles` revokes every binding of
  that `(user, home node, role, no use case)` key, whatever its shape. S4 keyed mirror rows
  separately instead (#226, migration `0023`; see S4 below), so this rule now applies to mirror rows only. Revocations by the trigger and the reconcile do
  not yet invalidate cached principals; S2 adds that with the authz epoch (#227).
- **Revocation in the database.** Migration `0019_trb_home_move` (trigger on `users`, `AFTER UPDATE
  OF tenant_id, global_roles`) applies the same-key rule in the same statement for every code path
  (older application versions, directory syncs, `psql`): a role removed from `global_roles` loses
  its binding at once, and a home change inside the organisation removes the legacy-key rows of the
  old home node and binds `global_roles` on the new one. Additions through the column alone are left
  to the reconcile (fail closed).
- **Cache form.** `serializeGrants` / `reviveGrants` (`@openagentix/core`): ISO strings, strict
  parsing, any irregularity makes the entry a miss (fail closed). The S2 cache must use them.
- **One connection.** `loadRawGrants` is one statement (one connection, one snapshot). S2 should
  still measure it under load against `OAX_DB_POOL_MAX` (#217), and consider caching for the
  uncached stream-token path.

S2 (acting node, read-only inheritance, authz epoch; #187, #227):

- **Flag first.** `OAX_ROLE_BINDINGS_READ=legacy|bindings` (default `legacy`, unknown values refuse
  to start). With `bindings` the resolver decides at the acting node; the shadow check compares the
  legacy sources in the other direction (`oax_role_bindings_shadow_total{authoritative}`). Switching
  production needs one reconcile and zero `mismatch` first (`docs/tenancy.md`). The legacy path is
  removed in a later slice, not here.
- **Reach.** `TenantAccess` has a third kind, `nodes` (replaces the unused `subtree`): the home node
  plus every node of the home organisation where `appliedAt` yields at least one permission. The
  visible set and the lookup of `X-OAX-Tenant` run on the epoch-keyed tree snapshot
  (`tree:<rootId>:<epoch>`, section 3.6; 10 min), in memory: no query per slug segment (the
  #198 follow-up), and unknown, invisible and foreign-organisation references are the same `404`
  after the same queries. Platform operators keep reach `all` and the roles of their home tenant.
- **Clamp stays on.** Inherited bindings give `*:read` and `audit:verify` only; the route-table
  test walks every permission route as an inherited-only admin. Team and agent bindings are
  node-local and make their node visible.
- **Epoch in the database, not in the cache.** Section 6.1 mirrors the epoch in the cache; S2 keeps
  `tenants.authz_epoch` as the only copy and compares it on **every** request with one primary-key
  read, because the trigger and `psql` paths can only reach the database. The bump is done by
  triggers (migration 0021) on bindings, team members, agent bindings, `users` (home, roles,
  platform flag, disabled) and tree nodes, so there is no write path that can forget it. The
  Valkey-side copy of section 6.1 is therefore not needed and the multi-replica window without
  Valkey disappears for these paths (open question 8 is answered for revocations: effective on the
  next request).
- **Cache entry** `auth:<tokenId>` v2: token id, secret hash, read-path mode, root and epoch, the
  principal fields, and either the legacy bindings or `serializeGrants` output read back with
  `reviveGrants(value, owner)`. The resolver runs per request, so expiry is never cached.
- `GET /v1/me` bindings carry `inherit`, `expiresAt`, `source` and the anchor node;
  `GET /v1/tenants` and the tree list the visible nodes (S3 still owns `scope=subtree` on the data
  routes).
- Known limit until S4 (#226, resolved by migration `0023`: grants have their own key): a binding of a legacy role in the legacy key on the user's own home
  node is removed by the reconcile unless it is the plain mirror shape, so inheriting grants are
  bound on an ancestor of the home node until the grant API gives mirror rows their own key.
- Not in S2: implicit "admin everywhere" for platform operators, restrictions, use-case bindings,
  the reaper, the grant API.

S3 (subtree reads; #188):

- **One place decides.** `SubtreeScopes` (`apps/api/src/services/subtree-scope.ts`) builds, for the
  acting node N and one permission, the nodes of `subtree(N)` inside the caller's reach where the
  resolver (`appliedAt`, clamp on) gives that permission, and per node what is readable
  (`all` or the team and agent ids). `ResolvedScope.predicate` turns that into the SQL of section
  3.5: nodes with an unscoped binding in one `tenant_id = any(...)`, nodes with team or agent
  scoped bindings one clause each (a team id never opens rows of another node). Platform
  operators get the subtree of the acting node with the roles they act with (they keep the roles of
  their home tenant, as in S2); on the `legacy` read path the scope is the acting node.
- **Opt-in, additive.** `scope` defaults to `node`; nothing changes unless `scope=subtree` is sent.
  `tenant { id, slug, slugPath, name }` appears on rows only in subtree mode (agents always had it).
  `tenantId` (id, slug path or bare slug) needs `scope=subtree`, is intersected, and an unknown,
  invisible, foreign or out-of-subtree node is the same 404 (`resolveVisible` plus a membership
  check; no extra query that depends on existence). `allTenants` and `scope=subtree` exclude each
  other.
- **Routes**: `/v1/agents`, `/v1/runs`, `/v1/approvals`, `/v1/events`, `/v1/event-sources`,
  `/v1/connections`, `/v1/costs/summary` (every `groupBy`; `groupBy=tenant` labels groups with the
  slug path), `/v1/budgets` (`nodes[]`, paged by slug path) and `/v1/audit` (only nodes where the
  caller holds `audit:read`; entries without a tenant partition never; a viewer gets 403 as before).
  `GET /v1/tenants`, `/tree` and `/search` already returned the visible nodes since S2.
- **Bounds.** Keyset cursors as before for agents, runs, approvals, events and audit; sources,
  connections and budgets gain `limit` (default 200, at most 1000) and `cursor` that are honoured
  with `scope=subtree` only (400 otherwise). A subtree with more readable nodes than
  `OAX_TENANT_MAX_NODES_PER_ROOT` is `422 subtree_too_large` (narrow with `tenantId`), so the
  predicate never exceeds that many nodes. Aggregate cache keys carry a digest of the scope.
- **Node-wide resources** (events, sources, connections, audit, budgets) follow what the routes did
  before: a node counts when any binding there carries the permission (a team scoped `operator`
  therefore sees the events of that node, in subtree mode exactly as when acting there).
- **Platform connections** owned by a node outside the scope are not listed in subtree mode, so a
  row can never name a node the caller may not see.
- Tests: `apps/api/test/subtree-scope.test.ts` (routes, 404 parity, cache isolation, and a
  seeded property test against a naive parent-by-parent reference on random trees with random
  bindings, expiries and team memberships).

S4 (role-binding API; #189, #226):

- **Mirror rows get their own key (#226, the first of the three options).** Migration
  `0023_trb_source` (0020 to 0022 were taken) adds `tenant_role_bindings.source` (`mirror | grant`,
  `NOT NULL`, default `mirror`, check constraint) and makes it part of `trb_uq`. Existing rows that the
  mirror cannot have written (inheriting, expiring, use case, `pentest`, not on the home node) become
  `grant`; the rest stay `mirror`. The same-key rule, the reconcile, the `global_roles` write-through
  and the `trb_users_home_move` trigger (rewritten in the **same migration**) work on
  `source = 'mirror'` only. The reconcile and the metric lose the `blocked` outcome: a mirror row and an
  explicit grant can no longer collide. Down script and snapshot included.
- **Section 4 rule (written here and in `docs/tenancy.md`).** Mirror rows follow `users.global_roles`
  and the user's home node; a mirror row may carry `inherit = true` (`PATCH { inherit }` and the bulk
  opt-in of section 4.2 set it on existing rows, which is how a root admin's plain `admin` binding
  becomes a subtree binding) and is still removed when the role leaves `global_roles`. Explicit grants
  (`source = 'grant'`, created through the API) are never created, changed or removed by
  `global_roles` writes, the reconcile or the trigger.
- **Home move.** Inside the organisation the mirror rows move with the user and explicit grants stay:
  a grant is a decision about its node, the organisation is unchanged, and the grantor of the old
  node keeps the ability to see (rule 4: the user still holds a binding there) and revoke it. They are
  therefore **not** revoked on a home move, and `tenant.role_unbound { reason: moved_out }` is not
  emitted by S4; it is reserved for node moves (S10) where a grant can end up outside the user's
  organisation. A move to another organisation stays refused by the guard while any binding of the old
  one exists, grants included.
- **Where the rules live.** `TenantRoleBindingsService` (`apps/api/src/services/tenant-role-bindings.ts`)
  evaluates every rule on the node of the path, from grants re-read inside the transaction, with the
  request-path resolver (clamp included: until S5 an inheriting binding above the node gives no
  `users:write`, so grants happen on the node the grantor is directly bound on; the coverage check for
  `inherit` is already the final rule). Writes hold the tree lock of the organisation shared and a
  per-organisation exclusive binding lock; that lock also makes the last-admin check (rule 8) race
  free. Rule 3 (use-case admins) and rule 7 (`pentest`) are not reachable before S8 and S6: use-case
  bindings are `422 use_case_bindings_unsupported`, `pentest` is not an accepted role.
- **Decisions beyond the text above.** `PATCH` re-checks both the old and the new tuple (role,
  inherit, expiry), mirror rows accept `inherit` only and cannot be deleted through the API (`409
  mirror_binding`; their role follows `global_roles`), a user may delete their own grant but not change
  it (rule 6), `dryRun` of the bulk opt-in defaults to `true`, skips disabled users and expired
  bindings and reports at most 50 nodes per binding, and `OAX_MAX_BINDINGS_PER_USER` (default 200)
  implements `422 binding_limit_exceeded`. Grants authorise only with `OAX_ROLE_BINDINGS_READ=bindings`.
  Error codes added: `grant_exceeds_own`, `inheritance_required`, `self_grant`, `last_admin`,
  `mirror_binding`, `cross_organisation_grant`, `use_case_bindings_unsupported`, `binding_limit_exceeded`.
- Tests: `apps/api/test/role-binding-api.test.ts` (one refusal per rule, enumeration parity, scoped
  tokens, last-admin race, audit partitions, survival of grants across `global_roles` changes and home
  moves), `migration-trb-source.test.ts`, and the updated `binding-reconcile.test.ts`.

## Context

What exists on `main` (commit `ddec688`):

- **Tree without roles.** W13-1 (PR #136) added `parent_id`, `root_id`, `path` and `depth` to
  `tenants` (migration `0013_tenant_hierarchy.sql`), a placement guard trigger (moves are refused
  until W13-11) and the structural repository `TenantTree` (`apps/api/src/services/tenant-tree.ts`:
  `node`, `children`, `ancestors`, `descendants`, `subtree`, `resolveSlugPath`), with **no**
  permission checks. Sub-tenants are created at the service layer only
  (`TenantsService.createChild`, platform operators only); the demo seed (#167) uses it to build
  `default -> security, product` plus the separate organisation `acme-labs`. `tenants.use_case`,
  `limits` and `settings` of ADR 0013 section 2 are not migrated yet.
- **Roles are per tenant.** `packages/core/src/rbac.ts` defines six fixed roles (`admin`,
  `agent-engineer`, `integrator`, `operator`, `auditor`, `viewer`), 24 permissions and
  `RoleBinding { role, teamId, agentId? }`. `IdentityService.bindingsFor` builds a principal's
  bindings from `users.global_roles` (whole tenant), `team_members` and `agent_role_bindings`,
  **filtered to the user's home tenant** (`users.tenant_id`). The bindings carry no tenant: every
  check (`hasPermission`, `visibleTeams`, `visibleAgents`) assumes they apply in
  `principal.tenantId`.
- **Acting tenant.** `X-OAX-Tenant: <slug or id>` is honoured for platform operators only
  (`IdentityService.actingIn`); for everybody else any value other than the home tenant is
  `404 tenant`. A platform operator acting elsewhere keeps the bindings of their home tenant (in
  practice `admin`).
- **Caching.** The principal is cached per token (`auth:<tokenId>`) for
  `min(OAX_AUTH_CACHE_TTL_SECONDS (30), token lifetime)`; role changes call
  `invalidateUserTokens`, which deletes those keys (in Valkey when `OAX_CACHE_URL` is set, so all
  replicas see it).
- **Platform-only reads.** `allTenants=true` on costs and audit, `GET /v1/tenants` (all rows) and
  audit verification of the whole chain are platform-operator features; nothing gives a
  non-platform user a view over more than one tenant.
- **Merged UX slices** that assume this ADR: A1 (#169, agent summaries with tenant, use case,
  owner team), A7 (#179, disable/enable, `agents:publish` on the agent's scope), U4 (#178, tenant
  switcher for platform admins, acting tenant kept per browser tab).

ADR 0013 section 7 decided **what** the tree means for roles (three admin scopes, use-case
children, fixed roles `viewer` without `audit:read` and `pentest` with expiry, no upward
visibility). It did not define the evaluation algorithm, the caching, the exact grant rules, the
threat model, the backwards-compatible migration or an order of implementation. This ADR does,
and it adds one deliberate change requested for W13-6: **inheritance is opt-in per binding.**
Today every binding is per tenant; turning all of them into subtree bindings silently when the
first child appears would hand descendants' content to people nobody chose for it.

## Decision

### 1. Terms

| Term | Meaning |
| --- | --- |
| Node | a row of `tenants` (ADR 0013 section 1) |
| Chain of N | N and its ancestors, root first; known from `N.path` without a query |
| Subtree of N | N and all its descendants |
| Binding | one grant of one fixed role to one user on one node: `(user, node, role, useCase?, inherit, expiresAt?)` |
| Direct binding at N | a binding whose node is N |
| Inherited binding at N | a binding with `inherit = true` whose node is a **strict ancestor** of N |
| Acting node | the one node a request acts in (`X-OAX-Tenant`, else the home node) |
| Effective bindings at N | what a principal holds at N after inheritance, expiry and restrictions (section 4); the classic `RoleBinding[]` the existing services consume |
| Coverage of a binding | the set of nodes where it is effective: `{node}` when `inherit = false`, `subtree(node)` when `inherit = true` (plus attached nodes for use-case bindings, section 3.3) |
| Visible nodes | nodes where the principal has at least one effective binding, a team membership or an agent binding; the only nodes `X-OAX-Tenant` may select |
| Tenant admin | `admin` binding without use case |
| Use-case admin | `admin` binding with a use case (ADR 0013 7.1) |
| Platform admin | `users.platform_admin` (today's platform operator); not a binding |

### 2. What is inherited, and in which direction

**Down only, by opt-in, never up, never sideways.**

| Kind of grant | Inherits to descendants? |
| --- | --- |
| Node binding (`tenant_role_bindings`), any of the seven fixed roles | only with `inherit = true` on that binding; default `false` |
| Use-case binding (`use_case` set) | inside the node: always covers the use case and its sub-use cases (that is not tree inheritance); attached child nodes (ADR 0013 7.2) only with `inherit = true` |
| Team membership (`team_members`) | **never**: teams are groups inside one node |
| Agent binding (`agent_role_bindings`) | **never**: one agent in one node |
| Role restriction (section 5) | applies to bindings at the restricting node and below, never to bindings from above it |
| Platform admin | not inherited, not a binding: full `admin` at every node of every organisation (ADR 0013 7.1) |

Rules that hold without exception:

- **Never up.** A binding on N gives nothing at any ancestor of N. What a user sees of ancestors
  is the breadcrumb (ids, slugs and names of the chain, ADR 0013 7.4) and the effective values with
  their source (W13-2); that is display data delivered with the node, not a permission.
- **Never sideways.** A binding on N gives nothing at a sibling or cousin of N, at any depth.
- **Never across organisations.** A binding's node must be in the user's home organisation
  (`tenants.root_id` of the binding node = `root_id` of `users.tenant_id`); enforced by a trigger,
  not only by the service. Platform admins are the only principals that act in another
  organisation.
- **Union.** Effective permissions at N are the union over all effective bindings at N
  (direct and inherited), minus restrictions (section 5), intersected with the token's scopes. A
  second, weaker binding never reduces a stronger one.
- All seven fixed roles may inherit, `pentest` included (a penetration test of a whole
  organisation is bound on the root with `inherit = true`). The role set stays fixed; custom roles
  are not part of this decision.

### 3. Effective permission resolution

#### 3.1 Data loaded per principal (cached with the principal)

```ts
interface RawGrants {
  userId: string;
  homeTenantId: string;
  homeRootId: string;
  platformAdmin: boolean;
  nodeBindings: { id; tenantId; role; useCase: string | null; inherit: boolean; expiresAt: Date | null }[];
  teamBindings: { tenantId; teamId; role }[];        // memberships, tagged with the team's node
  agentBindings: { tenantId; agentId; teamId; role }[]; // tagged with the agent's node
  epoch: number;                                      // authz epoch of the home root, section 6
}
```

`bindingsFor` changes from "filter to the home tenant" to "load everything of the home
organisation, tagged with its node". At most `OAX_MAX_BINDINGS_PER_USER` (default 200) node
bindings per user; creating more is `422 binding_limit_exceeded`.

#### 3.2 The resolver (pure, `packages/core/src/tenancy/roles.ts`)

```text
effectiveAt(raw, N, restrictionsOnChain, now, attachments) -> { bindings: RoleBinding[], sources }

if raw.platformAdmin:
    return [ { role: admin, teamId: null, source: platform } ]          # ADR 0013 7.1
chain = ancestorIds(N.path) + [N.id]                                    # no query, no recursion
out = []
for b in raw.nodeBindings:
    if b.expiresAt != null and b.expiresAt <= now: continue             # evaluated per request
    if b.tenantId == N.id:                     source = direct
    elif b.inherit and b.tenantId in chain:    source = inherited       # strict ancestor
    elif b.useCase and b.inherit and attachedVia(N, b, attachments):    # 3.3
                                               source = attached; b' = b without useCase
    else: continue                                                      # up, sideways: nothing
    perms = ROLE_PERMISSIONS[b.role] - restricted(b, restrictionsOnChain)  # section 5
    out += { role: b.role, permissions: perms, teamId: null, useCase: b.useCase, source }
for t in raw.teamBindings  where t.tenantId == N.id: out += { role, teamId, source: team }
for a in raw.agentBindings where a.tenantId == N.id: out += { role, teamId, agentId, source: agent }
return out
```

- The result is the existing `RoleBinding[]` shape extended with `permissions` (the role's
  permissions after restrictions), `useCase` and `source`. `hasPermission`, `visibleTeams` and
  `visibleAgents` read `permissions` instead of `ROLE_PERMISSIONS[role]`; with no restrictions
  both are identical, so every existing service keeps working unchanged.
- **Read-only clamp (first slices only).** Until slice S5 (section 12) lifts it, bindings with
  `source = inherited | attached` are clamped to the read permissions
  `*:read` and `audit:verify` (`INHERITED_READ_ONLY`), so the first slices can ship subtree reads
  without any write authority flowing down. The clamp is one constant and one test.
- Use-case bindings are **refused at creation** (`422 use_case_bindings_unsupported`) until
  slice S8 has added the use-case filter to every service (fail closed: a binding that the services
  cannot scope must not exist).

#### 3.3 Use-case bindings and attached nodes

A binding with `use_case = u` at node N covers, inside N, the resources whose `labels.useCase` is
`u` or starts with `u/` (per segment). With `inherit = true` it also covers every child node C of N
with `tenants.use_case` = `u` or `u/...`, **with C's whole subtree**, as an unrestricted binding of
the same role there (ADR 0013 7.2). Attaching or detaching a node (`PATCH /v1/tenants/{id}
{ useCase }`) is therefore a grant to every use-case admin of that use case: it needs an
**inheriting tenant admin** on the child's parent (or above) or a platform admin; a use-case admin
can never attach a node to their own use case.

#### 3.4 Acting node and `X-OAX-Tenant`

1. No header: the acting node is the home node (unchanged).
2. With `X-OAX-Tenant: <id | slug path>`: resolve the **whole** value first (id lookup or
   `TenantTree.resolveSlugPath`), then check visibility. Unknown and invisible give the same
   `404 tenant` from the same code path (no oracle on intermediate slug segments).
3. Visible = the node is in the principal's visible set (section 1). A user whose only binding on a
   node is a team membership or an agent binding may act there, with exactly those bindings.
4. Permissions of the request are the effective bindings **at the acting node** (3.2). Route-level
   checks (`config.access`) and service-level checks run against them unchanged.
5. Every response of an authenticated route carries `X-OAX-Acting-Tenant: <slug path>` (#156), so
   the console detects a mismatch.
6. Run tokens, model tokens and webhooks ignore `X-OAX-Tenant` (their tenant comes from the run or
   the event source, as today); stream tokens apply it as today.

Operations that name **another node** in the path or body (`/v1/tenants/{id}/...`, `parentId`,
role-binding targets, move targets) evaluate permissions **on that node** (or its parent where
ADR 0013 says so: caps, moves), never on the acting node. The acting node never lends authority to
an operation on a different node (confused-deputy rule, section 9).

#### 3.5 Subtree reads (`scope=subtree`)

`GET` list routes that accept `?scope=subtree` (A4 #158) evaluate, for the acting node N and every
visible node D in `subtree(N)`, the effective bindings at D, and build one predicate:

```text
(tenant_id = any(:allNodes))                               -- nodes with an unscoped read binding
or (tenant_id = :d1 and team_id = any(:teams_d1)) or ...   -- nodes with team-scoped reads only
or (tenant_id = :d2 and agent_id = any(:agents_d2)) or ... -- nodes with agent-scoped reads only
```

The predicate is built on the server from the resolver; the client never supplies the node list
(it may narrow it with `?tenantId=`, which is intersected, never unioned). Every row carries
`tenant { id, slugPath, name }`.

#### 3.6 Cost of the lookup

There is **no recursive query** anywhere on the request path:

- The chain of N is the id list in `N.path` (ADR 0013 section 2); restrictions on the chain are one
  indexed query `where tenant_id = any(:chain)`, at most 33 ids, cached (6.2).
- The visible set needs the current paths of the binding nodes. An organisation has at most
  `OAX_TENANT_MAX_NODES_PER_ROOT` (default 1 000) nodes, so the API keeps a **tree snapshot per
  root** (`id, parent_id, path, depth, slug, name, use_case`; about 150 bytes per node, at most
  about 150 KB per organisation) in the cache, keyed by the root's authz epoch (6.1). Visible set,
  subtree id lists, slug paths for rows and breadcrumbs are computed in memory from it.
- Per request: one cache read for the principal, one for the epoch, one for the snapshot (all hits
  in the steady state), then O(bindings + depth) work for the acting node and O(visible nodes) for
  `scope=subtree`. Subtree list queries use `tenant_id = any(:ids)` (existing `tenant_id`
  indexes), bounded by 1 000 ids.
- Measured target (added to `docs/performance.md`): resolver p99 below 1 ms for 200 bindings and
  depth 32; `scope=subtree` agent list over 1 000 nodes within the existing list budget on the PG
  baseline.

### 4. Bindings: schema and migration

#### 4.1 Migration `0018_tenant_role_bindings.sql` (additive; planned as 0017, see Implementation status)

```sql
create table tenant_role_bindings (
  id          uuid primary key,
  user_id     uuid not null references users(id) on delete cascade,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  role        text not null,          -- one of the seven fixed roles (check constraint)
  use_case    text null,              -- same syntax as labels.useCase
  inherit     boolean not null default false,
  expires_at  timestamptz null,
  granted_by  uuid null references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint trb_pentest_expiry check (role <> 'pentest' or expires_at is not null)
);
alter table tenants add column authz_epoch bigint not null default 0;  -- used on roots, section 6.1
create unique index trb_uq on tenant_role_bindings (user_id, tenant_id, role, coalesce(use_case, ''));
create index trb_tenant_idx on tenant_role_bindings (tenant_id);
create index trb_user_idx on tenant_role_bindings (user_id);

create table tenant_role_restrictions (
  tenant_id   uuid not null references tenants(id) on delete cascade,
  role        text not null check (role <> 'admin'),
  permission  text not null,
  created_by  uuid null references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, role, permission)
);
```

- Trigger `trb_same_org`: the binding node's `root_id` equals the `root_id` of the user's home
  tenant (`23514` otherwise). Same check when a user's home tenant changes.
- **Backfill**: one row per entry of `users.global_roles` on the user's home tenant with
  `inherit = false`, `use_case null`, `expires_at null`, `granted_by null`. Every existing tenant
  is a root without children or (demo) a parent whose child users have their own bindings, so the
  effective permissions of every user at every node are **identical** before and after.
- `users.global_roles` stays for one release as a **write-through mirror**: writes to it (user
  PATCH, LDAP/OIDC group mapping, bootstrap admin) also write non-inheriting bindings on the home
  tenant; reads move to the new table. The column is dropped one release later (the usual
  expand/contract). Mirror rows carry `source = 'mirror'` and have their own key; rows created by the
  binding API are `source = 'grant'` and are never touched by the mirror (migration `0023`, see S4 in
  the implementation status).
- `pentest` is not accepted in `global_roles` (it needs an expiry); it exists only as a binding.
- Down migration (`down/0018_tenant_role_bindings.down.sql`) drops both tables; the mirror keeps
  `global_roles` correct, so rollback loses only inheritance flags, expiries and pentest bindings.

#### 4.2 Backwards compatibility and the opt-in

- **Default: no inheritance.** Migrated bindings, bindings created by group mapping and bindings
  created through the API without `inherit` (the field is **required** in the new API; the legacy
  `globalRoles` path always writes `false`) cover only their node.
- **Opt-in per binding.** `PATCH /v1/tenants/{id}/role-bindings/{bindingId} { inherit: true }`
  turns a binding into a subtree binding. It is a grant on every node of the subtree and follows
  the grant rules of section 7 (the caller needs coverage of the whole subtree with that role).
  Consequence: an `admin` binding **on a root** can be turned into an inheriting one only by a
  platform admin (nobody else covers a root's subtree). A bulk form for upgrades:
  `POST /v1/tenants/{rootId}/role-bindings/enable-inheritance { roles, dryRun }` (platform admin),
  which reports the users and nodes that would gain access before it changes anything.
- **Creating children requires coverage.** `POST /v1/tenants { parentId }` by a non-platform user
  needs an **inheriting** `admin` binding on the parent or an ancestor (`403
  inheritance_required` otherwise), so a tenant admin never creates a node they cannot administer.
  A platform admin creating a child under a node whose admins do not inherit gets a warning in the
  response (`warnings: ["parent_admins_do_not_inherit"]`).
- **Platform admins**: today a platform operator acting elsewhere uses their home roles; now they
  are `admin` everywhere (ADR 0013 7.1). For the bootstrap admin (home role `admin`) nothing
  changes; a platform operator without `admin` at home gains full admin when acting elsewhere,
  which is what "admin sees everything" means. `OAX_OPERATOR_ACCESS=metadata` (ADR 0013 7.4) is
  unchanged and handled by its own slice.

### 5. Role restrictions

`PUT /v1/tenants/{id}/role-restrictions { role, permissions[] }` (tenant admin of the node) removes
permissions of a role for **bindings at the node and below**:

- A restriction on R applies to a binding b iff R is in the chain of b's node (R is b's node or
  above it). Bindings inherited from **above** R are untouched: a descendant cannot restrict its
  ancestors' oversight (ADR 0013 7.3).
- Restrictions never add permissions, never target `admin` (check constraint; prevents a node from
  locking out its own administrators), and never apply to platform admins.
- Team and agent bindings in a node are restricted by the restrictions of that node's chain like
  direct bindings.

### 6. Caching and invalidation

#### 6.1 Authz epoch per organisation

`authz:epoch:<rootId>` is a counter in the shared cache (Valkey when configured), mirrored in the
database (`tenants.authz_epoch` on roots, bumped in the same transaction as the change, so a cache
loss can be repaired by reading the root row). It is incremented by every change that can alter
any effective permission in the organisation:

| Change | Also does |
| --- | --- |
| binding created, changed (`inherit`, `expiresAt`), deleted, expired by the reaper | `invalidateUserTokens(user)` (existing) |
| restriction set or removed | - |
| node created, moved (W13-11), deleted, attached or detached (`use_case`) | tree snapshot rebuilt |
| user disabled, home tenant changed, platform flag changed | `invalidateUserTokens(user)` |
| cross-organisation move (W13-15) | bump both roots |

A cached principal (`auth:<tokenId>`) stores the epoch it was built with; on a mismatch it is
rebuilt before the request is evaluated. The tree snapshot is keyed `tree:<rootId>:<epoch>`, so a
stale snapshot is never read after a bump.

#### 6.2 What is cached, for how long

| Entry | Key | TTL | Invalidation |
| --- | --- | --- | --- |
| raw grants of a principal | `auth:<tokenId>` (existing) | `min(OAX_AUTH_CACHE_TTL_SECONDS, token lifetime)` | token delete + epoch |
| tree snapshot | `tree:<rootId>:<epoch>` | 10 min | new epoch |
| restrictions of a node | `restr:<tenantId>:<epoch>` | 10 min | new epoch |
| effective bindings at a node | **not cached across requests**; memoised per request | request | - |

- **Expiry** (`expires_at`) is evaluated against `ctx.now()` on every request, never at cache
  time, so an expired `pentest` binding stops working at the second it expires, cache or not. A
  reaper (every minute) deletes expired bindings, writes `tenant.role_expired` and bumps the
  epoch (housekeeping only; enforcement does not depend on it).
- **Without Valkey and with more than one API replica**, a revocation reaches other replicas only
  when their cached principal expires (at most `OAX_AUTH_CACHE_TTL_SECONDS`, default 30 s). This
  is today's behaviour for role changes; `docs/roles.md` states the window and recommends Valkey
  for more than one replica.
- **Writes recheck under the tree lock.** Grant, revoke, restriction, attach and child creation
  take the L0 tree lock of the root in **shared** mode (ADR 0013 5.1) and re-read the grantor's
  bindings inside the transaction; moves take it exclusive. A grant therefore never races a move
  that would have changed the grantor's coverage.

### 7. Granting

A principal P may create, change or delete a binding `(user U, node T, role R, useCase u,
inherit f, expiresAt e)` only if **all** of these hold (evaluated in the transaction, 6.2):

1. **Permission**: P has `users:write` effective at T (direct or inherited, after restrictions).
2. **No grant above one's own role**: every permission of `R` is in P's effective permissions at
   T. With `f = true`, P's covering binding must itself inherit and cover all of `subtree(T)`
   (P's binding is on T or an ancestor with `inherit = true`); the same for every node attached
   via `u`.
3. **Use-case admins** (P's only `users:write` comes from a use-case binding on `u'`): only
   `u = u'` or a sub-use case of it, at P's node or in attached nodes of `u'`.
4. **Grantee visibility**: U's home tenant is in P's `users:read` coverage, or U already holds a
   binding inside it; otherwise `404 user` (no enumeration of other nodes' users).
5. **Same organisation**: T is in U's home organisation (trigger as backstop).
6. **No self-grant**: `U = P.user` is refused (`403 self_grant`) for anyone but a platform admin;
   a user cannot widen their own access, including flipping `inherit` on their own binding.
7. **`pentest`**: only a tenant admin (no use case) of T or above, or a platform admin; `e`
   required and at most `OAX_PENTEST_MAX_DAYS` (1 to 30, default 30) from now
   (`422 expiry_required`, `422 expiry_too_long`); extending means a new grant (new audit entry),
   never a silent update beyond the maximum.
8. **Last admin**: deleting or narrowing (`inherit: false`) the last inheriting tenant admin of a
   root is refused (`409 last_admin`) except for platform admins.
9. **Revocation** follows the same rule as granting (who may grant may revoke); a user may always
   delete their **own** binding (leaving is never an escalation), except the last-admin case.

Team memberships and agent bindings keep their current routes and rules, evaluated at the acting
node with the effective bindings there.

### 8. `viewer` and `pentest`

- `viewer` = `agents:read, runs:read, events:read, costs:read`. **No `audit:read`**, also when
  inherited; the audit routes answer `403` (now covered by a route-table test).
- `pentest` (new, ADR 0013 7.5) = `agents:read, runs:read, events:read, sources:read,
  connections:read, policies:read, audit:read, audit:verify, costs:read, users:read, tokens:read,
  settings:read`. No write, execute, approve, cancel, token creation or `audit:export`; secret
  values are unreadable for every role.
- `pentest` bindings must carry `expires_at` (database check plus the 30-day rule of section 7).
  On grant, `tenant.role_bound { role: pentest, expiresAt, inherit }` is written and the tenant
  admins of the bound node (direct and inherited) are notified; 24 hours before expiry and at
  expiry the grantor and those admins get a notice.
- Every login or token use that activates a `pentest` binding for the first time in a session
  writes `pentest.session_started { tenant, expiresAt }`; individual reads are not audited (the
  HTTP access log carries the user), denied requests are audited as `access.denied` as today.
- In the console a `pentest` principal sees the read-only badge with the expiry (UX 8.1).

### 9. What stays node-local

| Thing | Rule across the tree |
| --- | --- |
| Team memberships, agent bindings | node-local, never inherited |
| Role restrictions | apply at the node and below to bindings bound there or below (section 5) |
| Secret values | never readable by any role on any node; references resolve against the **owning** node (ADR 0013 section 6) |
| `secret_refs` patterns | narrowing down the tree (ADR 0013 section 3); written with `settings:write` on the node |
| Connections | visible and usable down the tree per the connection's own `inherit` flag (W13-7); `connections:write` edits only connections **owned** by the acting node: an inherited admin edits an ancestor's connection by acting at that ancestor, which needs a binding there |
| Budgets and caps | inherited **ceilings** (ADR 0013 section 4, W13-4); a node's own cap is written with `settings:write` on its **parent** (a node never raises its own ceiling); team and use-case budgets stay node-local |
| Policies and guidelines | bundles bound to a node apply to its subtree (union, stricter wins, W13-8); `policies:write` edits only the acting node's bundles |
| API tokens | user-level, not node-bound; scopes intersect with the effective permissions at **every** node (an owner decision proposes optional node-pinned tokens) |
| Approvals | `runs:approve` inherits like any permission; notifications go to approvers with a direct or inherited binding |
| Audit entries | written in the acting node's partition; inherited `audit:read` reads the subtree with `scope=subtree` (W13-9) |

### 10. Audit events

All in the partition of the **binding's node** (names and ids only, never secret values):

| Event | Payload |
| --- | --- |
| `tenant.role_bound` | `bindingId, userId, role, useCase, inherit, expiresAt, grantedBy` |
| `tenant.role_binding_changed` | `bindingId, field, from, to` (`inherit`, `expiresAt`) |
| `tenant.role_unbound` | `bindingId, userId, role, reason: revoked | self | user_deleted | moved_out` |
| `tenant.role_expired` | `bindingId, userId, role` (reaper) |
| `tenant.role_restricted`, `tenant.role_restriction_removed` | `role, permissions` |
| `tenant.inheritance_enabled` | bulk opt-in: `roles, bindings: n, users: n` |
| `tenant.attached`, `tenant.detached` | `useCase` (written at the child and the parent) |
| `pentest.session_started` | `expiresAt` |
| `access.denied` | existing; now also for `X-OAX-Tenant` outside the visible set (rate-limited per user) |

Migration backfill writes one `tenant.role_bound` summary per tenant (`source: migration, count`)
so the chain records where bindings came from.

### 11. Threat model

| Threat | Mitigation |
| --- | --- |
| **Escalation via moves**: move a subtree under a node one administers, or move a node one does not administer under one's own subtree | moving needs inheriting `admin` coverage of the moved node, the old parent and the new parent (ADR 0013 9.1 tightened: "tenant admin" = inheriting); nobody gains coverage of a node they did not cover; bindings **on** moved nodes move with them, inherited ones from old ancestors stop, from new ancestors start; the dry run lists the principals that gain or lose access; epoch bump |
| **Escalation via attach/detach** of a node to a use case | needs inheriting tenant admin on the parent; never by a use-case admin; audited at both ends; epoch bump |
| **Self-escalation by granting** | grant rules 1 to 6 (no role above one's own, coverage for `inherit`, no self-grant) |
| **Lock-out** of an organisation | no restriction on `admin`; `409 last_admin` on roots |
| **Confused deputy via `X-OAX-Tenant`** | acting node only from the visible set (404 otherwise); resource ids resolve inside the acting node only (404 elsewhere); operations on another node evaluate on that node, never on the acting node (3.4); subtree lists are read-only, writes on a row go to the row's node with its own `X-OAX-Tenant` (UX 9.2); run, model and webhook credentials ignore the header; cache keys of per-tenant data include the tenant (rule for reviewers) |
| **Stale permissions after revoke or move** | per-root epoch checked on every request (shared cache), expiry evaluated per request, writes recheck under the tree lock; residual window only for multi-replica installations without Valkey (30 s default, documented) |
| **Expired `pentest` still active** | per-request expiry check; database check that `pentest` has an expiry; reaper only for cleanup |
| **Enumeration** of nodes and users | unknown and invisible nodes give the same 404 from the same path; slug paths resolve fully before the visibility check; tree endpoint returns ancestors as names only; grant targets must be visible users (404 otherwise); error details never name invisible nodes; `access.denied` audited and rate-limited |
| **Cross-organisation leakage** | same-organisation trigger on bindings; cross-organisation moves remove bindings of other-organisation users (ADR 0013 9.2) |
| **Token scope bypass** | token scopes intersect with effective permissions at every node |
| **Upward leakage through aggregates** | usage of ancestors only as the tightest remaining headroom number (ADR 0013 7.4); `scope=subtree` never includes ancestors or siblings; counts in the tree endpoint only for visible nodes |
| **Clamp regression** (write authority flowing down before S5) | `INHERITED_READ_ONLY` constant with a route-table test: with the clamp on, every write route is `403` for a user whose only binding is inherited |

### 12. Implementation slices

Each slice is one PR for a Sonnet agent, with the security-review points the reviewer (Opus)
checks before merge. Every slice adds its tests to the suites in section 13 and keeps
`pnpm test`, the tenancy probes and the OpenAPI drift check green.

| # | Slice | Content | Depends on | Unblocks (UX) | Security review |
| --- | --- | --- | --- | --- | --- |
| S1 | Bindings table and resolver | migration 0018 (planned as 0017) with backfill and down path, `trb_same_org` trigger, `global_roles` write-through, `pentest` added to `ROLES` (not grantable yet), pure resolver `packages/core/src/tenancy/roles.ts` with `permissions`/`source` on `RoleBinding`, `bindingsFor` loads the home organisation tagged by node, `hasPermission`/`visibleTeams`/`visibleAgents` read `permissions`; **no behaviour change** | W13-1 | - | migration equivalence test (effective permissions identical for every seeded user and node); trigger refuses cross-org rows |
| S2 | Acting node and read-only inheritance | `X-OAX-Tenant` (id or slug path) for the visible set, `X-OAX-Acting-Tenant` header, `INHERITED_READ_ONLY` clamp, authz epoch and tree snapshot (section 6), `GET /v1/me` with `actingTenant`, `homeTenant`, bindings with node/source/inherit/expiry, `visibleTenantCount` | S1 | A2 #156 -> U4 for all users | 404 parity (unknown vs invisible, timing class); clamp route-table test; epoch invalidation tests |
| S3 | Subtree reads | `?scope=node|subtree` and `tenant` on rows for agents, runs, approvals, events, costs summary, budgets, audit (audit only with `audit:read`), server-built predicate (3.5), `?tenantId=` narrowing; `GET /v1/tenants/tree` with counts and `myRoles`/`inheritedRoles`; `GET /v1/tenants` = visible nodes | S2 | A4 #158 -> U6, U11; A3 #157 -> U5 | property test "no row outside the visible subtree"; ancestors only as names; viewer never gets audit rows |
| S4 | Role-binding API | `GET/POST/PATCH/DELETE /v1/tenants/{id}/role-bindings`, bulk `enable-inheritance` (platform admin, dry run), grant rules 1 to 9, audit events of section 10, invalidation; use-case bindings refused (`422 use_case_bindings_unsupported`) | S2 | U5 role actions, "Users & roles" | each grant rule has a refusal test; no self-grant; last admin; grantee enumeration |
| S5 | Write inheritance and child creation | remove the clamp; `POST /v1/tenants { parentId }` for inheriting tenant admins; `PATCH /v1/tenants/{id}` (name) for tenant admins; `GET /v1/me/access?tenant=` (explain: effective permissions with sources) | S4 | A6 #160 -> U8; U9 (writes on rows of other nodes) | route-table walk with inherited admin vs direct admin vs none; confused-deputy tests (body names another node) |
| S6 | `pentest` | grantable with expiry rules, notifications, `pentest.session_started`, reaper with `tenant.role_expired`, console badge data in `/v1/me` | S4 | U8 badge; demo user `pentest@example.org` of #162 gets the real role | route-table walk: every write route refused, every read route allowed; expiry at the boundary second |
| S7 | Locate | `GET /v1/locate/{kind}/{id}` over the visible set | S3 | A9 #163 -> U9 deep links | 404 parity with non-existent ids |
| S8 | Use-case bindings and attachment | migration for `tenants.use_case` (if W13-1 follow-up has not added it), `PATCH /v1/tenants/{id} { useCase }`, use-case filter in every service that filters by team today (agents, runs, events, costs, budgets, audit, approvals), lift `use_case_bindings_unsupported` | S5 | U5 "use-case admin" fixtures, demo user `vuln-owner@example.org` | service walk: every list and detail route honours the use-case filter (fail-closed test with a fake new route); attach needs tenant admin |
| S9 | Role restrictions | table usage, `PUT/DELETE /v1/tenants/{id}/role-restrictions`, resolver integration, `role_restricted` reason for A6 | S5 | A6 reason `role_restricted` | restrictions never add, never touch ancestors' bindings or admin |
| S10 | Move and conversion hooks | grant-relevant parts of W13-11/W13-14/W13-15: inheriting-admin rule for moves, dry-run "who gains/loses access", epoch bumps, binding removal on cross-org moves, property tests for move invariants | S5 and W13-11 | Tenants page Move action | move invariant property tests; no access gained by the mover |

Recommended order: S1 -> S2 -> S3 -> S4 -> S5 -> S6 -> S7 -> S8 -> S9, with S10 merged together with
W13-11. S2 and S3 alone already give every tenant admin and viewer the read views of their subtree
(the minimal useful slice); write inheritance (S5) comes only after the grant API (S4) exists, so
that nobody needs database edits to opt in. In the UX order of `multi-tenant-ux.md` section 13,
"(W13-6)" is satisfied for A2 by S2, for A3/A4 by S3, for A6 by S5 and for A9 by S7.

### 13. Test plan

**Property tests** (pure resolver, a seeded random generator in Vitest so failures replay; random
forests up to depth 6 and 200 nodes, random bindings of all roles with random
`inherit`, expiries and restrictions):

- **Nothing flows up or sideways**: for every node N, `effectiveAt(S, N)` equals
  `effectiveAt(S', N)` where `S'` drops every binding whose node is not in `chain(N)`; and drops
  every non-inheriting binding whose node is not N.
- **Inheritance is opt-in**: with all `inherit = false`, `effectiveAt(N)` contains only bindings on
  N (plus team and agent bindings of N).
- **Monotonicity**: adding a binding never removes a permission anywhere; adding a restriction
  never adds one; restrictions on R never change effective permissions from bindings above R.
- **Expiry**: for every binding with `expiresAt = t`, it contributes at `t - 1 ms` and not at `t`.
- **Platform admin**: `admin` everywhere, independent of bindings.
- **Clamp**: with the clamp on, inherited bindings never yield a non-read permission.
- **Move invariant** (S10): after moving X under Q, effective permissions at nodes outside
  `subtree(X)` are unchanged; inside, they equal (bindings on nodes of `subtree(X)`) union
  (inheriting bindings of `chain(Q)`); the mover's coverage set is unchanged.
- **Attach invariant** (S8): attaching C to `u` changes effective permissions only inside
  `subtree(C)` and only for holders of inheriting bindings on `u` at C's parent.
- **Reference implementation**: a naive recursive evaluator (walk parents one by one from the
  database) is compared with the snapshot-based resolver and the SQL predicate of 3.5 on PGlite
  for random trees.

**Integration and probes** (`tenancy.test.ts` extended):

- `X-OAX-Tenant` with sibling, cousin, ancestor (without an inheriting binding there) and another
  organisation: `404`, identical body to a non-existent id; slug paths with an invisible middle
  segment: `404`.
- `scope=subtree` on every supporting route never returns a row outside the visible subtree, for
  combinations of `tenantId` filters, cursors and team-scoped users.
- Route-table walks: `viewer` 403 on audit routes; `pentest` allowed on every read route, refused
  on every write route; inherited-only principal refused on every write route while the clamp is
  on.
- Grant API: every rule of section 7 with a refusal test; audit events written in the binding
  node's partition.
- Cache: revoke then the next request (same replica) is refused; with a simulated second replica
  sharing Valkey, refused after the epoch bump; without shared cache, refused after the TTL;
  move then request uses the new chain.
- Migration: snapshot of flat tenants with global roles, team and agent bindings upgrades with
  identical permissions; down migration; `global_roles` write-through.
- Demo seed (#162): the five demo users get their documented roles (`pentest` with expiry after
  S6, use-case admin after S8) and the tour still works.

### 14. API changes (summary)

| Change | Slice |
| --- | --- |
| `X-OAX-Tenant: <id | slug path>` for any visible node; `X-OAX-Acting-Tenant` response header | S2 |
| `GET /v1/me`: `actingTenant { id, slug, slugPath, name, path[] }`, `homeTenant`, `bindings[] { tenantId, tenantSlugPath, role, useCase, inherit, expiresAt, source }`, `visibleTenantCount`; `permissions` = effective at the acting node | S2 |
| `?scope=node|subtree`, `?tenantId=` and `tenant` on rows: agents, runs, approvals, events, event sources, connections, costs summary (`groupBy=tenant`), budgets, audit | S3 |
| `GET /v1/tenants/tree?root=&depth=&include=counts`, `GET /v1/tenants/search?q=`; `GET /v1/tenants` returns visible nodes | S3 |
| `GET/POST /v1/tenants/{id}/role-bindings`, `PATCH/DELETE /v1/tenants/{id}/role-bindings/{bindingId}` (`inherit` required on POST) | S4 |
| `POST /v1/tenants/{rootId}/role-bindings/enable-inheritance { roles, dryRun }` (platform admin) | S4 |
| `POST /v1/tenants { parentId }` and `PATCH /v1/tenants/{id}` for inheriting tenant admins | S5 |
| `GET /v1/me/access?tenant=` (own effective permissions with sources) and `GET /v1/tenants/{id}/access?userId=` (`users:read`) | S5 |
| `actions` on detail responses (#160), computed with the same resolver | S5 + A6 |
| role `pentest` in enums and `docs/roles.md` | S6 |
| `GET /v1/locate/{kind}/{id}` | S7 |
| `PATCH /v1/tenants/{id} { useCase }`; `useCase` on role bindings | S8 |
| `GET/PUT/DELETE /v1/tenants/{id}/role-restrictions` | S9 |
| Error codes: `inheritance_required`, `self_grant`, `grant_exceeds_own`, `expiry_required`, `expiry_too_long`, `last_admin`, `binding_limit_exceeded`, `use_case_bindings_unsupported`, `restriction_on_admin` | S4 to S9 |
| Deprecated: `globalRoles` on user create/patch (write-through to non-inheriting bindings for one release) | S1 |

## Consequences

- Positive: upgrading changes no one's access; inheritance is visible and deliberate per binding,
  and every opt-in is an audited grant.
- Positive: the existing services keep their permission code: they receive effective bindings at
  the acting node in the shape they already understand.
- Positive: the first two slices give tenant admins and viewers subtree read views without any
  write authority flowing down, which unblocks most of the multi-tenant console.
- Positive: no recursive queries; the per-organisation snapshot bounds the work by the node limit.
- Negative: an organisation upgraded from flat tenants needs one explicit step (platform admin
  bulk opt-in) before root admins administer sub-tenants they did not create; until then the
  console must explain why a root admin does not see a child.
- Negative: a second cache key (epoch) is read on every request; the snapshot costs up to about
  150 KB per organisation in the cache.
- Negative: multi-replica installations without Valkey keep a revocation window of the auth cache
  TTL (unchanged from today).
- Negative: use-case bindings arrive late (S8) because every service has to learn the use-case
  filter; until then use-case admins are approximated by team bindings in the demo.

## Alternatives considered

- **Every node binding inherits** (ADR 0013 7.3 as written): simplest, but the first child created
  under an upgraded tenant would silently expose its content to every existing admin, auditor and
  viewer of the parent. Rejected for opt-in.
- **Inheritance per role** (e.g. admins always inherit, viewers never): fewer choices, but the
  owner's demo already needs an inheriting `pentest` and a node-local admin; a per-binding flag is
  one boolean and explains itself in the console.
- **Materialise inherited bindings into descendants** (copy rows down): fast reads, but moves,
  revocations and restrictions would have to rewrite many rows, and a missed rewrite is a
  privilege leak. Rejected.
- **Recursive CTE per request**: correct, but recursion on every request; the path and the
  bounded snapshot make it unnecessary.
- **Cache effective permissions per (principal, node)**: more cache entries and a larger
  invalidation surface for a computation that costs well under a millisecond. Rejected.
- **Evaluate subtree lists node by node in the client**: the client could request nodes it should
  not see and would need N requests. Rejected; the server builds one predicate.

## Open questions (owner decisions needed)

1. **Console default for the inherit checkbox** on new grants: the API requires the field;
   recommendation: the console shows "This tenant only" preselected and "This tenant and all
   sub-tenants" as the explicit choice, for every role.
2. **Who may opt root admins in after an upgrade**: recommendation: platform admins only (bulk
   endpoint with dry run). Alternative: allow a root admin to opt in their own binding while the
   root has no children.
3. **Node-pinned API tokens**: recommendation: keep tokens user-level now and add an optional
   `tenantId` pin later (default unpinned, today's behaviour).
4. **Self-grant**: recommendation: refused for everyone but platform admins (no user widens their
   own access, not even with a second admin's consent; that admin grants instead).
5. **Last-admin protection on roots**: recommendation: yes (`409 last_admin`).
6. **Use-case bindings into attached nodes only with `inherit = true`**: ADR 0013 7.2 includes
   attached nodes always; this ADR makes it the same opt-in as for nodes. Confirm.
7. **`pentest` audit depth**: recommendation: grant, session start, expiry and denials; no
   per-read audit entries. Alternative: audit every read of a `pentest` principal (heavier audit
   volume).
8. **Multi-replica without Valkey**: accept the 30 s revocation window (recommendation, as today),
   or refuse to start more than one replica without a shared cache.
