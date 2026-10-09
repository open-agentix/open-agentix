# ADR 0013: Hierarchical tenants and setup modes

- Status: Proposed
- Date: 2026-10-09
- Plan items: W13-1 to W13-12 (section 15; to be added to the
  [implementation plan](../IMPLEMENTATION-PLAN.md) as wave 13)
- Builds on: [ADR 0002](0002-audit-hash-chain.md) (audit hash chain),
  [ADR 0003](0003-policy-engine-audit-and-control-agents.md) (policies, stricter wins),
  [ADR 0007](0007-tenants-as-isolation-boundary.md) (tenants as the isolation boundary),
  [ADR 0009](0009-model-proxy.md) (reservations, `ModelAccountingService`),
  [ADR 0012](0012-connections-instances-scopes-and-data-protection.md) (connection instances,
  central grants, retention, erasure)
- Amends: ADR 0007 (a tenant may have a parent; visibility of descendants), ADR 0009 section 4.3
  (lock set and limits of the reserve transaction), ADR 0012 sections 2 and 7 (grants and
  tenant settings are inherited down the tree)
- Related: W2-5 (agent budgets, alert delivery), W5-1 (tenant-scoped identity providers), W7-1
  (per-tenant audit chains), W7-4 (data residency)

## Context

What exists on `main` (commit `71fd586`):

- **Flat tenants.** `tenants` (`apps/api/src/db/schema.ts`) has `id`, a globally unique `slug`,
  `name`, `monthly_budget_micros` and `secret_refs`. There is no parent. Every query filters by
  exactly one `tenant_id` taken from the principal (ADR 0007); rows of another tenant are 404.
- **Users and roles.** A user has one home tenant (`users.tenant_id`); global roles
  (`users.global_roles`), team roles (`team_members`) and agent-scoped bindings
  (`agent_role_bindings`) apply inside that tenant only. The role set is fixed
  (`packages/core/src/rbac.ts`: `admin`, `agent-engineer`, `integrator`, `operator`, `auditor`,
  `viewer`). Platform operators (`users.platform_admin`) create tenants and act in any tenant with
  `X-OAX-Tenant`.
- **Teams** are groups inside a tenant with their own optional monthly budget
  (`teams.monthly_budget_micros`); use cases have budgets in `use_case_budgets`.
- **Budgets.** `BudgetsService.scopeUsages` returns the tenant, use-case and team monthly scopes of
  a run from the cost ledger. `ModelAccountingService.reserve` (PR #80, ADR 0009 section 4.3) takes
  a per-tenant advisory lock (`pg_advisory_xact_lock(ACCOUNTING_LOCK_NS, hashtext(tenantId))`),
  sums settled ledger cost plus active reservations per scope, finds the tightest limit and
  refuses or clamps the output bound. Settlement and the expiry reaper take the same lock.
  Concurrency limits are per session and per tenant.
- **Audit.** One global hash chain, serialised by a global advisory lock; every entry carries its
  tenant as a partition key outside the hash. Per-tenant chains are W7-1.
- **Setup.** A fresh installation creates the `default` tenant and, from `OAX_BOOTSTRAP_ADMIN`, a
  bootstrap administrator who is also platform operator. There is no first-run dialog; the console
  always shows every tenant-related feature, even when only one person uses one tenant.

The owner asked for two things (task notes of 2026-10-09):

1. **A setup dialog on first start** with two modes: **single-tenant** (recommended for private
   projects such as a homelab: one agent, simple costs, one user; simplified interface, no tenant
   switcher, one default tenant, budgets optional) and **multi-tenant** (recommended for companies
   with several agents, cost centres, budgets and so on).
2. **Hierarchical tenants.** A main tenant has any number of sub-tenants, which may have
   sub-tenants of their own (department A -> area A -> team A / team B). Budgets, limits, models,
   connections, roles and policies are **optional** per tenant and **inherited**. The budget rule,
   meant exactly like this: if the main tenant has 300 EUR per month, **every** sub-tenant may use
   up to 300 EUR, the children's budgets are **not** added up, a child can never exceed its
   parent's budget, and once the parent's total (the actual spend of the parent and all its
   children together) is reached, **all** of them are blocked. This is a **cap model with a shared
   counter at every ancestor**, not a split of the parent budget. The same holds for limits (runs,
   tokens, concurrency), model allowlists (children may only narrow, never widen), connections and
   policies.

## Decision

Tenants form a forest: every tenant may have a parent. A root tenant is an **organisation**; the
tree below it is that organisation's structure. Every node is still a full tenant in the sense of
ADR 0007 (own agents, runs, connections, costs, audit partition); the tree adds three things:
**inheritance** of settings with narrowing only, **caps with shared counters** at every ancestor,
and **downward visibility** for the administrators of an ancestor. The setup mode is a
presentation and onboarding choice; it never changes what the API enforces.

### 1. Terms

| Term | Meaning |
| --- | --- |
| Node | A row in `tenants`. "Tenant" and "node" are used interchangeably |
| Root, organisation | A node without a parent. The default tenant is a root |
| Parent, child, ancestor, descendant | As usual; a node is **not** its own ancestor |
| Chain of a node | The node and all its ancestors, ordered root first |
| Subtree of a node | The node and all its descendants |
| Own value | What is stored on a node (may be absent = "inherit") |
| Effective value | What applies to a node after inheritance (section 3) |
| Cap | A numeric upper limit (budget, run count, tokens, concurrency) on a node; it bounds the **sum over the node's subtree** |
| Counter | The settled usage of a node's subtree in the current period |

### 2. Data model: tree with a materialized path

Migration `0013_tenant_hierarchy.sql` (number follows the reserved `0011` of ADR 0010 and `0012`
of ADR 0012; it shifts if those land later):

- `tenants` gains
  - `parent_id uuid null references tenants(id) on delete restrict`,
  - `root_id uuid not null` (self for roots),
  - `path text not null`: the ids of the chain, root first, as `/<uuid>/<uuid>/.../` (fixed 37
    characters per level, ends with `/`); index `tenants_path_idx (path text_pattern_ops)` so that
    the subtree is `path like '<path of node>%'` and the chain is the ids in the node's own path,
  - `depth smallint not null` (0 for roots), check `depth <= 8`,
  - `limits jsonb not null default '{}'` (section 4), `settings jsonb not null default '{}'`
    (inheritable settings, section 3).
  The unique index on `slug` is replaced by `tenants_parent_slug_uq (coalesce(parent_id, root
  sentinel), slug)`: slugs are unique among siblings, root slugs stay globally unique. A node is
  addressed by id or by its **slug path** `acme/div-a/team-a`.
- Why a materialized path and not an adjacency list with recursive CTEs, `ltree` or a closure
  table: subtree and chain queries are single index lookups without recursion; the path is short
  (depth limit); text paths work identically in PostgreSQL and PGlite (no extension); moves are
  rare and rewrite only the paths of the moved subtree. A closure table would make moves and
  inserts O(depth x subtree) rows and is not needed at this depth.
- **Depth limit**: `OAX_TENANT_MAX_DEPTH` (levels below the root), default **4** (organisation ->
  division -> area -> team -> sub-team), hard maximum 8 (database check). The limit bounds the lock
  set of every reservation (section 5) and keeps the console tree usable. Creating or moving a node
  beyond it is `422 tenant_depth_exceeded`. Optional `OAX_TENANT_MAX_NODES_PER_ROOT` (default
  1000) guards against runaway automation.
- `tenant_usage_counters (tenant_id, period, spent_micros, tokens, runs_started)`, primary key
  `(tenant_id, period)`, `period` = month (UTC, the ledger's `month`). A row exists only for nodes
  that have at least one cap (section 5.2); it holds the **settled** usage of the node's subtree.
  Active reservations are not stored in counters (they are read from `model_reservations`), so a
  crashed worker can never leave a counter inflated.
- `model_reservations` gains `tenant_path text not null` (copied from the run's tenant at reserve
  time, rewritten for active rows on a move) with index `(status, tenant_path text_pattern_ops)`
  where `status = 'active'`.
- `cost_ledger` keeps `tenant_id` only; subtree cost reports join `tenants.path` (reports are not on
  the hot path).
- `installation_settings` (single row): `mode` (`single | multi`), `setup_completed_at`,
  `setup_version`.
- Deleting a node with children is refused (`409 tenant_has_children`); see section 10 for
  deletion and erasure.

### 3. Inheritance and override: narrowing only

Every inheritable setting has an **own value** per node (absent = inherit) and an **effective
value** computed along the chain by a pure resolver in `packages/core/src/tenancy/effective.ts`.
The resolver returns, per field, the effective value and the **source node** ("inherited from
Division A"), which the console and `GET /v1/tenants/{id}/effective` show.

| Setting | Own value on a node | Effective value | Write-time rule on a child |
| --- | --- | --- | --- |
| Monthly budget (cap) | `limits.monthlyBudgetMicros` | every cap in the chain applies at once (section 4); the displayed effective cap is the minimum | `<=` effective cap of the parent, else `422 limit_exceeds_parent` |
| Runs, tokens per month (caps) | `limits.monthlyRuns`, `limits.monthlyTokens` | as budget | as budget |
| Concurrency caps | `limits.maxConcurrentRuns`, `limits.maxConcurrentModelCalls` | as budget (counted over the subtree) | as budget |
| Run and step budget ceilings | `limits.maxRunCostUsd`, `limits.maxRunTokens` | minimum along the chain; publish refuses an `agents.md` budget above it | `<=` parent |
| Model allowlist | `settings.models: ["provider/model" or "provider/*"]` | intersection along the chain; absent = no restriction at that level | must be a subset of the parent's effective list (`422 not_narrowing`) |
| Allowed regions (ADR 0012 7.1) | `settings.allowedRegions` | intersection | subset |
| Retention (ADR 0012 7.2) | `settings.retention` | the shortest along the chain | may only shorten |
| Operator access (ADR 0012 7.7) | `settings.operatorAccess` | `metadata` wins over `full` | may only go to `metadata` |
| Secret reference patterns (ADR 0008) | `secret_refs` | a ref is allowed only if every node in the chain that sets patterns allows it | patterns must be covered by the parent's |
| Max classification | `settings.maxClassification` | the lowest along the chain | may only lower |
| Policies, guidelines | bundles bound to the node | **union** of all bundles in the chain, evaluated stricter-wins (deny > require_approval > allow), as platform bundles today | a child adds bundles; it cannot disable or edit an ancestor's bundle |
| Connections, grants | section 6 | inherited down, narrowed per child | section 6 |
| Roles | section 7 | bindings apply to the subtree; per-node role restrictions remove permissions | section 7 |

Rules that hold for every field:

- **Narrowing only.** A child can make an effective value stricter, never looser. The write is
  validated against the parent's effective value at the time of the write.
- **Parents can tighten later.** When an ancestor tightens a value below a descendant's own value,
  the descendant's own value is **kept** (no cascading rewrite, no surprise edits) but no longer
  effective; the resolver and the console mark it `shadowed` ("limited by Division A"). Runtime
  enforcement uses the effective value only, so a shadowed value never widens anything.
- **Absent means inherit**, never "unlimited". There is no way for a child to opt out of an
  ancestor's value.
- Effective values are computed per request from the chain (at most 9 rows, cached per request and
  invalidated on any tenant write via the existing cache invalidation path); they are never
  materialised in descendants.

### 4. Caps with shared counters (the budget rule)

For every cap kind `k` (cost, tokens, runs, concurrency) and every node `A` that sets a cap:

```text
usage_k(subtree(A)) + reserved_k(subtree(A)) + this_call_k  <=  cap_k(A)
```

must hold **for every capped node `A` in the chain of the calling node**. Consequences, which are
exactly the owner's rule:

- A child without an own cap can use up to its parent's cap (the parent's check is the only one
  that binds it). With parent 300 EUR, **each** child may use up to 300 EUR.
- Caps of siblings are **not added**: two children with 300 EUR each under a 300 EUR parent are
  valid; together they can never spend more than 300 EUR, because both draw from the parent's
  counter.
- A child can never exceed its parent: its own cap is validated `<=` the parent's (section 3), and
  even a shadowed own cap cannot help because the parent's counter is checked too.
- When the parent's subtree usage reaches the parent's cap, **every** node of the subtree (at any
  depth) is blocked for that cap kind until the period ends or the cap is raised. Cost caps block
  at the limit (the existing hard-stop rule of monthly scopes, `blockAtLimit`).
- A child cap smaller than the parent's gives the child its own ceiling inside the shared pool; it
  does **not** reserve anything for the child. Guaranteed minimums (reserving parent headroom for a
  child) are not part of this decision (open question 2).
- Team, use-case and (with W2-5) agent budgets stay as additional scopes **inside** a node and are
  checked as today. They never cross nodes.
- Period: calendar month in UTC, as the cost ledger. Runs caps count runs started in the period;
  token caps count settled input plus output tokens; concurrency caps count active runs and active
  model reservations of the subtree at that moment.

### 5. Reservation against all ancestors under lock (`ModelAccountingService`)

#### 5.1 Lock order and deadlock avoidance

Locks are taken in a fixed hierarchy; a transaction never acquires a lock of a lower level after
one of a higher level:

| Level | Lock | Mode | Taken by |
| --- | --- | --- | --- |
| L0 | tree lock of the root: `pg_advisory_xact_lock_shared(TREE_NS, key(root_id))` / `pg_advisory_xact_lock(TREE_NS, key(root_id))` | shared for reserve, settle, expire, run admission; **exclusive** for move, cap creation or removal, node deletion | all |
| L1 | accounting lock of every **capped** node in the chain plus the calling node: `pg_advisory_xact_lock(ACCOUNTING_NS, key(id))` | exclusive | reserve, settle, expire |
| L2 | audit chain lock (existing `AUDIT_LOCK`) | exclusive | audit append inside settlement |

- Inside L1, locks are acquired **sorted by their numeric lock key** (ascending, duplicates
  removed), not by depth. A global total order makes deadlocks impossible even when two ids hash to
  the same key (`key(id)` = today's `hashtext(id)`, an `int4`); a collision only causes extra
  serialisation, never a deadlock. Settlement, the reaper and run admission use the same function
  to build the lock set, so no code path can take L1 locks in another order.
- The leaf (calling) node is always in the L1 set, so the existing per-tenant serialisation and
  concurrency counting keep their meaning.
- Uncapped ancestors are **not** locked: they have no limit to protect and no counter (their
  subtree usage for reports comes from the ledger). Only an organisation that actually sets caps
  pays for them.
- L0 shared locks do not contend with each other. They exist so that structural changes (moving a
  node, adding or removing a cap and thereby a counter) see no reservation in flight and no
  reservation sees a half-changed tree.
- `lock_timeout` for accounting transactions (`OAX_ACCOUNTING_LOCK_TIMEOUT_MS`, default 5 000):
  a timeout is answered `503 model_proxy_unavailable` (retryable, no reservation made), never a
  silent pass.

#### 5.2 Reserve

`reserve(scope, req)` keeps its contract (ADR 0009 section 4.3) and changes inside:

1. Load the run (tenant from the run row, as today), then the chain of the run's tenant
   (`select ... from tenants where id = any(<ids from path>)`).
2. Take L0 shared on the root, then L1 on the sorted key set.
3. Re-read the chain under the lock (a move may have finished between 1 and 2; if the path
   changed, restart once, then refuse with `503`).
4. Build the limit list: run and step budgets (unchanged), team/use-case scopes of the leaf
   (unchanged), and for every capped node `A` in the chain one limit per cap kind:
   `used = counter(A).spent + sum(active reservations where tenant_path like path(A) || '%')`,
   `limit = cap(A)`, `blockAtLimit = true`, code `control_budget_tenant`, details
   `{ tenant: <slug path of A>, inherited: A != leaf }`. The leaf's own monthly budget is now just
   the chain entry for the leaf.
5. The existing tightest-limit computation (`allowedBy`) clamps or refuses unchanged, so the
   output bound shrinks to what the tightest ancestor still allows.
6. Concurrency: the session and leaf checks stay; each capped node with
   `maxConcurrentModelCalls` adds `count(active reservations under path(A)) < cap`.
7. Insert the reservation with `tenant_path`.

#### 5.3 Settle and expire

Settlement and the reaper take the same L0 and L1 locks (computed from the reservation's
`tenant_path`), write the ledger line exactly as today, and add the actual cost and tokens to the
counter row of every capped node in the chain (`insert ... on conflict (tenant_id, period) do
update set spent_micros = spent_micros + excluded.spent_micros, ...`). Ledger line and counter
updates are in one transaction, so they cannot diverge. A nightly reconciliation job recomputes
counters from the ledger, corrects differences and writes `budget.counter_drift` (counts only); a
drift is a bug signal, not an expected path.

#### 5.4 Hard stop

- **New calls** in any descendant of an exhausted node are refused in the reserve transaction
  (`403 control_budget_tenant`, clients must not retry).
- **In-flight calls** finish within their reservation; the reservation already counted against
  every ancestor, so the cap cannot be exceeded (ADR 0009 guarantee, upper-bound mode). The
  mid-stream hard stop of ADR 0009 section 6.3 is unchanged.
- **Running runs** fail at their next model call with the same code; the control agent's mid-run
  monthly check (`BudgetsService.verdictForRun`) evaluates the whole chain too.
- **New runs** (API, CLI, event triggers, cron) are refused at admission with
  `403 budget_exhausted { tenant, cap }` when any capped ancestor is exhausted for cost or runs, so
  that events do not pile up failing runs. Events are still stored and their run is recorded as
  not started with reason `budget_exhausted` (no silent drop).
- **Priced tool calls** keep today's post-hoc accounting and can overshoot by one call (documented
  in `docs/budgets.md`), now at every ancestor level.
- **Alerts** (50/80/100 %) are raised per capped node to that node's admins; when an ancestor
  reaches 100 %, every descendant admin receives one "blocked by <ancestor>" alert per period
  (`budget.blocked_by_ancestor`), so teams learn why they stopped without seeing sibling usage.
- **Lowering a cap** below the current usage blocks the subtree immediately for new calls;
  granted reservations settle normally (ADR 0009 rule).

#### 5.5 Cost of the design

Every reservation of an organisation with a root cap serialises on the root's L1 lock. The
critical section is two short queries and one insert (single-digit milliseconds), which is
acceptable for v0.x volumes and is the same order as today's per-tenant lock. If it becomes a
bottleneck, the documented follow-up is **headroom leases**: an ancestor hands a child a slice of
its remaining headroom that the child consumes under its own lock and returns on expiry (open
question 3). Leases keep the invariant but add complexity and stranded headroom, so they are not
the default.

### 6. Connections across the tree (amends ADR 0012)

- A connection instance created on node `N` is visible and usable in the subtree of `N` by default
  (`inherit: true`). The creator may set `inherit: false` to keep it on `N` only.
- A descendant can **narrow** an inherited instance for its own subtree, never widen it:
  disable it (`connection_overrides.enabled = false`), choose a subset of tool profiles, a lower
  `max_classification`, a smaller instance budget or rate limit. It cannot edit the instance,
  its endpoint or its secrets.
- **One flat namespace per chain**: a node's names plus all inherited names. Creating a name that
  an ancestor already provides to this node is `409 name_taken`; creating a name on an ancestor
  that a descendant already uses is refused too (the ancestor's admin sees the subtree, so this
  reveals nothing new). No shadowing, consistent with ADR 0012 section 2.
- Central (platform) instances: a grant (ADR 0012 section 2) is made to a node and inherited by its
  subtree; descendants narrow it like any inherited instance. A grant to a root covers the whole
  organisation.
- **Credentials**: an inherited instance uses the secrets of the node that owns it. The credential
  broker and the model proxy resolve secret references against the **owning** node's
  `secret_refs` and namespace, never the calling node's, and audit the call in the calling node's
  partition with `ownerTenant`. Shared credentials inside one organisation are the normal case and
  are labelled "inherited from <node>" in the processing record (ADR 0012 7.5).
- Budgets and rate limits per instance count over every node that uses it (one counter per
  instance, as ADR 0012 section 5).

### 7. Visibility and roles across the tree (amends ADR 0007)

- **Downward only.** A role binding on node `N` applies to the subtree of `N`. A user sees the
  nodes where they hold a binding, their subtrees, and the **names and slugs of the ancestors on
  the path** (breadcrumb) only. Siblings, cousins and ancestors' resources stay 404, exactly as
  another tenant today.
- **Bindings** move from "global roles of the home tenant" to `tenant_role_bindings (user_id,
  tenant_id, role)`; on migration every global role becomes a binding on the user's home tenant
  (no behaviour change). Team and agent bindings stay inside their node. A user may hold bindings
  on several nodes of one organisation, never across organisations (platform operators excepted).
- **Granting**: an `admin` of `N` may grant roles on `N` and its descendants, never on an ancestor
  or sibling, and never a role they do not hold themselves on that node.
- **No removal of inherited oversight**: a descendant cannot remove or restrict an ancestor's
  bindings on itself. It can add **role restrictions** for its subtree (e.g. in team A,
  `agent-engineer` lacks `agents:publish`); restrictions remove permissions and never add any.
  The role set stays fixed; custom roles are not part of this decision.
- **Acting node**: every request still acts in exactly one node (no ambient multi-tenant queries,
  ADR 0007 stays intact). `X-OAX-Tenant: <id | slug path>` is now allowed for any node in the
  caller's visible subtree, not only for platform operators. Read views that make sense across a
  subtree (runs, costs, audit, budgets) accept `?scope=subtree`, implemented with the path prefix
  and the same permission check on the acting node.
- **What descendants see of ancestors**: effective values with their source node name and, when
  blocked, the blocking node and the remaining headroom of the tightest ancestor as a number; not
  the usage of siblings or a breakdown of the ancestor's counter.
- **Content access** inside one organisation follows the bindings (an ancestor `admin` can read a
  descendant's run content). ADR 0012 7.7 (`operatorAccess`, break-glass) keeps applying to
  platform operators across organisations; a node may set `operatorAccess: metadata` for its
  subtree.
- Platform operators keep their role; in single-tenant mode the one user is platform operator and
  admin of the default tenant.

### 8. Audit hash chain

- Entries keep `tenant_id` = the acting node (partition key outside the hash, ADR 0002/0007). The
  path is **not** stored in entries, because nodes can move; visibility is computed from the
  current tree: admins and auditors of an ancestor see the entries of its subtree.
- `POST /v1/audit/verify` for a node user verifies the chain and reports issues of the visible
  subtree only (extends today's rule).
- With W7-1 (per-tenant chains) the chain unit is the **organisation (root)**, not every node:
  moves inside an organisation then never cross chains, and verification of a subtree is a filter
  on one chain. Moves across organisations are not allowed (section 9).
- New events (names and numbers, never secret values): `tenant.created`, `tenant.moved { from,
  to }` (written in old and new parent partitions), `tenant.limits_changed { field, from, to }`,
  `tenant.settings_changed { field, from, to }`, `tenant.deleted`, `tenant.role_bound` /
  `tenant.role_unbound`, `tenant.role_restricted`, `budget.blocked_by_ancestor { ancestor, kind }`,
  `budget.counter_drift`, `setup.completed { mode }`, `setup.mode_changed { from, to }`.

### 9. Moving nodes

`POST /v1/tenants/{id}/move { parentId, dryRun }` (admin of both the old and the new parent, or
platform operator; root nodes cannot be moved under another root, and nodes cannot change
organisation):

- Takes the L0 **exclusive** lock of the root; rewrites `path`, `depth` of the subtree and
  `tenant_path` of active reservations; recomputes the counters of every capped node in the old
  and new chain from the ledger for the current period.
- Validates narrowing against the new parent's effective values; violations are listed and the
  move is refused unless `clamp: true`, which marks the moved node's wider own values as shadowed
  (section 3) instead of editing them.
- `dryRun: true` reports the effect: values that become shadowed and caps that would block the
  subtree immediately.

### 10. Data protection and deletion

- Retention, region, operator access and PII settings (ADR 0012 section 7) are inherited with
  narrowing only (section 3).
- **Export** (`POST /v1/tenant/export?scope=subtree`) bundles the subtree.
- **Deleting a node**: only leaf nodes; agents must be archived first; the node's data key is
  destroyed (crypto-shredding, ADR 0012 7.6) per node, audit payloads are tombstoned, the audit
  metadata stays. Deleting a whole subtree is an explicit recursive operation for the organisation
  admin (`DELETE /v1/tenants/{id}?recursive=true`, confirmation token, leaves first).
- Data subject erasure works per organisation (a person may appear in several nodes).

### 11. Migration from the flat model

- Every existing tenant becomes a **root** (`parent_id null`, `root_id = id`, `depth 0`,
  `path '/<id>/'`). The default tenant stays the default root. Nothing is nested automatically.
- `tenants.monthly_budget_micros` moves to `limits.monthlyBudgetMicros` (column kept one release
  as a generated mirror for rollback, then dropped). A counter row for the current month is created
  from the ledger for every tenant with a budget.
- Global roles become `tenant_role_bindings` on the home tenant; `users.global_roles` is kept
  read-only for one release.
- `model_reservations.tenant_path` is backfilled from the tenant; active reservations at upgrade
  time are few (they expire within minutes) and are backfilled in the same migration.
- Teams are **not** converted to child tenants. They stay lightweight groups inside a node.
  Organisations that want "team A" as an isolated unit with its own budget cap and connections
  create a child tenant; a later helper may convert a team into a child node (open question 5).
- Installation mode on upgrade: `multi` if more than one tenant exists, else `single`;
  `setup_completed_at` is set (no wizard for existing installations); the console shows a one-time
  notice with the option to switch modes.
- The migration is additive; the down path drops the new columns and tables and is tested.

### 12. Setup modes and the first-run wizard

#### 12.1 Principle

The mode changes **what the console shows and which defaults onboarding applies**. It never
changes authorization, isolation, or what the API accepts: every endpoint works in both modes, and
the tenancy isolation tests run in both. This keeps one code path and makes switching safe.

#### 12.2 Modes

| | Single-tenant (homelab, private project) | Multi-tenant (company) |
| --- | --- | --- |
| Tenants | the default root only; creating a second root or a child switches to multi-tenant first | organisations and sub-tenants |
| Console | no tenant switcher, no Tenants page, no central connections or grants view, no scope pickers (everything is created on the default tenant); costs as a simple monthly total and per run; budgets optional and collapsed | tree navigation, tenant switcher (breadcrumb), effective values with "inherited from", grants, subtree views |
| Defaults | `OAX_PLATFORM_CONNECTIONS_DEFAULT_GRANT=all` behaviour, `operatorAccess: full` (the operator is the owner), retention as ADR 0012 defaults | ADR 0012 defaults (default deny for central instances, `operatorAccess: metadata`) |
| Users | the bootstrap admin; more users can be added (they stay in the default tenant) | per node |

- **Single -> multi**: always allowed (`PATCH /v1/installation { mode: "multi" }`, platform
  operator); the default tenant becomes the first organisation (rename offered).
- **Multi -> single**: allowed only when exactly one tenant exists and it has no children
  (`409 mode_requires_single_tenant` otherwise).

#### 12.3 Wizard

Shown to the bootstrap administrator on the first login while `setup_completed_at` is null.
Steps: (1) mode, with the two recommendations as written above; (2) organisation name and slug
(single-tenant: the default tenant's display name only); (3) model providers and MCP servers
(instances per ADR 0012, connection test per ADR 0011 section 8; may be skipped); (4) budget
(optional monthly cap on the root; single-tenant: one field, skippable); (5) summary. Every step
is saved immediately, the wizard can be left and resumed, and `POST /v1/setup/complete` records
`setup.completed`.

Headless installs (Helm, Compose, IaC) set `OAX_SETUP_MODE=single|multi` (and optionally
`OAX_SETUP_ORG_NAME`); the wizard is then skipped and the values are applied at startup once.

#### 12.4 Security of the setup endpoints

`GET /v1/setup` is public but returns only `{ required: boolean }`. All setup writes require an
authenticated platform operator; there is no unauthenticated "claim this installation" flow (the
bootstrap admin comes from configuration as today). After completion the setup write routes answer
`409 setup_completed`, except the mode switch.

### 13. API and console sketch

API (OpenAPI additions generated by the implementing tasks):

| Method and path | Who | Purpose |
| --- | --- | --- |
| `GET /v1/setup`, `PUT /v1/setup/{step}`, `POST /v1/setup/complete` | public (status) / operator | wizard |
| `GET /v1/installation`, `PATCH /v1/installation` | operator | mode |
| `POST /v1/tenants` (`parentId` optional) | operator for roots; `admin` of the parent for children | create |
| `GET /v1/tenants/tree?root=` | any user | visible tree (ids, slugs, names, depth, status `active | blocked`) |
| `GET /v1/tenants/{id}/effective` | `settings:read` on the node | effective values with source node and `shadowed` flags |
| `PATCH /v1/tenants/{id}/limits`, `PATCH /v1/tenants/{id}/settings` | `settings:write` on the parent for caps (a node cannot raise its own cap), on the node for narrowing settings | own values |
| `GET /v1/tenants/{id}/usage?period=` | `costs:read` | counters of the node, per-child breakdown (only children visible to the caller), headroom of the tightest ancestor |
| `POST /v1/tenants/{id}/move`, `DELETE /v1/tenants/{id}` | see sections 9, 10 | structure |
| `PUT/DELETE /v1/tenants/{id}/role-bindings`, `.../role-restrictions` | `users:write` on the node | roles |
| `GET /v1/runs`, `/v1/costs`, `/v1/audit`, `/v1/budgets` with `?scope=subtree` | as today on the acting node | subtree views |

Who sets a child's cap: the **parent's** admins (a node never raises its own ceiling); a child's
admin can set a **lower** own cap for a grandchild or narrow other settings on its own node.

Console: a tree in the Tenants page (expand, search, status badge, usage bar per node showing
own, subtree and cap); a tenant switcher as breadcrumb with a tree popover; the limits form shows
the parent's effective cap as the maximum; inherited values carry an "inherited from <node>" chip
and shadowed own values a "limited by <node>" chip; a blocked banner on every page of a blocked
subtree ("Budget of Division A is used up for October; runs are paused until 1 November or until
Division A raises it"). In single-tenant mode all of this is hidden (section 12.2).

### 14. Test strategy

- **Resolver unit tests** (pure, `packages/core`): every field of section 3, absent/inherit,
  shadowed values after a parent tightens, intersection and min semantics, source attribution;
  generated random chains (seeded) compared against a straightforward reference implementation.
- **Narrowing validation**: each write rule refuses widening with the documented code; move with
  and without `clamp`.
- **Caps (PostgreSQL, opt-in job added by PLAT-00, same harness as the accounting tests of
  PR #80)**:
  - one child alone can spend up to the parent cap; a second child is refused once the parent
    counter is full (caps not summed);
  - two children with own caps of 300 under a parent cap of 300: combined settled plus reserved
    never exceeds 300;
  - parent exhausted -> every descendant at depths 1 to 4 is refused for model calls and run
    admission; events are recorded as not started (`budget_exhausted`); a raise of the cap unblocks immediately;
  - parent spend counts against the parent's own cap together with its children;
  - month rollover resets counters; lowering a cap below usage blocks at once; in-flight
    reservations settle.
- **Concurrency**: 200 parallel reservations spread over random leaves of a random tree with caps
  at random levels; invariant after every run: for every capped node, settled plus active reserved
  `<= cap`; counters equal the ledger. Run with interleaved settlements, expiries, cap changes and
  moves; assert no deadlock (`lock_timeout` never hit in the deadlock test, PostgreSQL deadlock
  detector never fires) and no lost update. A dedicated test forces two ids with colliding lock
  keys.
- **Isolation** (`tenancy.test.ts` probes extended): sibling resources 404; ancestor resources 404
  for descendant users; descendant resources visible to ancestor admins; `X-OAX-Tenant` refused
  outside the visible subtree; `?scope=subtree` never returns rows outside it; usage endpoint never
  shows siblings to a child.
- **Roles**: inherited bindings, restrictions only remove, no grant above one's own role, no
  removal of ancestor bindings.
- **Migration**: a snapshot with flat tenants, budgets, global roles and active reservations
  upgrades to roots with identical behaviour (existing test suite green on the migrated data);
  down migration.
- **Setup**: wizard API state machine, headless `OAX_SETUP_MODE`, mode switch rules, and the full
  API test suite executed in both modes (authorization identical); console tests (en, de) for the
  hidden elements in single-tenant mode.

### 15. Work breakdown (wave 13)

| Wave | Item | Content | Depends on |
| --- | --- | --- | --- |
| 13a | W13-1 Tenant tree model | migration (section 2, 11), tree service (create child, tree, depth and node limits, slug paths), `X-OAX-Tenant` slug paths, isolation probes | - |
| 13a | W13-2 Effective settings resolver | `packages/core/src/tenancy/effective.ts`, narrowing validation, `GET .../effective`, publish checks for model allowlist and run budget ceilings | W13-1 |
| 13a | W13-3 Setup modes and wizard API | `installation_settings`, `/v1/setup*`, `/v1/installation`, `OAX_SETUP_MODE`, upgrade defaults (owner task NEW-11, API half) | - |
| 13b | W13-4 Hierarchical caps in accounting | counters, lock hierarchy L0/L1/L2 with sorted keys, reserve/settle/expire over the chain, reconciliation job, `BudgetsService` chain verdicts, run admission `budget_exhausted`, alerts `blocked_by_ancestor`, Postgres concurrency tests | W13-1, PLAT-00 (Postgres CI job) |
| 13b | W13-5 Further caps | runs, tokens, concurrency caps on the same counters | W13-4 |
| 13b | W13-6 Roles and visibility | `tenant_role_bindings`, role restrictions, subtree views, grant rules | W13-1 |
| 13c | W13-7 Connections and grants inheritance | `inherit`, overrides, chain namespace, credential resolution by owning node | W13-2, W12 (ADR 0012) |
| 13c | W13-8 Policies and guidelines inheritance | chain union, stricter wins | W13-2 |
| 13c | W13-9 Audit | subtree visibility, verify scope, new events, W7-1 alignment note | W13-1 |
| 13c | W13-10 Console | tree, switcher, effective chips, limits forms, blocked banner, wizard UI, single-tenant simplification (NEW-11 UI half), en and de | W13-2, W13-3, W13-4 |
| 13d | W13-11 Move, delete, export | section 9 and 10, crypto-shredding per node | W13-4, W12 data protection |
| 13d | W13-12 Docs and deployment | `docs/tenancy.md`, `docs/budgets.md`, `docs/setup.md`, Helm `setup.mode` (mirror issue in open-agentix-helm), Compose env | all |

Wave 13a items can start in parallel; W13-4 is the critical path and the riskiest change (it
touches money and locking) and gets a security and concurrency review before merge.

## Consequences

- Positive: organisations can model departments and teams with inherited governance; the owner's
  budget rule is enforced exactly and stays correct under concurrency, because it reuses the
  reservation design of ADR 0009 with more limits in the same tightest-limit computation.
- Positive: narrowing-only inheritance makes the effective configuration of any node explainable
  ("inherited from ...", "limited by ...") and prevents a child from escaping its parent's
  governance.
- Positive: single-tenant users get a simple console without a second code path; switching to
  multi-tenant later loses nothing.
- Negative: every reservation in an organisation with a root cap serialises on the root lock;
  acceptable now, leases are the escape hatch.
- Negative: ancestor admins can read descendants' content inside an organisation; organisations
  that need stronger separation between units must use separate roots (organisations).
- Negative: counters are a second source of truth next to the ledger; mitigated by single-
  transaction updates and nightly reconciliation.
- Negative: tenants, teams and use cases are three grouping concepts; the documentation must say
  when to use which.

## Alternatives considered

- **Split budgets** (a parent's budget is divided among children, children's budgets add up to the
  parent's): explicitly not what the owner wants; stranded budget and constant re-balancing.
  Rejected.
- **Check only the leaf's own budget, aggregate later**: overshoot by any amount under
  concurrency. Rejected (same reason as ADR 0009).
- **Sum the ledger over the subtree on every reservation** instead of counters: correct, but cost
  grows with ledger volume on the hot path. Rejected; counters plus active reservations.
- **Counters for reserved amounts too**: faster reads, but a crash between reserve and settle
  inflates counters; active reservations are few and indexed. Rejected.
- **One global accounting lock**: simplest deadlock story, but serialises all organisations.
  Rejected; per-root tree lock plus sorted node locks.
- **Lock by depth order (root to leaf)**: deadlock-free on a tree only as long as hashed lock keys
  never collide; sorting by the key itself is free and always safe. Rejected in favour of key
  order.
- **PostgreSQL `ltree` or a closure table**: see section 2. Rejected for now.
- **Adjacency list with recursive CTEs**: no extra column, but recursion on every request and
  every reservation. Rejected.
- **Make teams the hierarchy** (nested teams inside one tenant): teams share one isolation scope,
  connections and policies; the requirement asks for inherited, separately governed units, which
  tenants already are. Rejected.
- **Separate single-tenant build or API**: two code paths and a security difference between modes.
  Rejected; the mode is presentation and defaults only.

## Open questions

1. Single-tenant mode, "one agent, one-time costs": is a simple monthly total plus per-run cost
   what is meant, or should single-tenant mode also hide budgets and use cases entirely?
2. Guaranteed minimums for children (reserve part of the parent's cap for a child) as an optional
   later feature, or never?
3. Headroom leases (section 5.5): introduce only when measured contention requires it?
4. Default depth limit 4 below the root: enough, or should it be 3 (owner example: department ->
   area -> team)?
5. Offer a converter "team -> child tenant", or keep teams and tenants strictly separate?
6. Should ancestor admins' content access to descendants be configurable per node
   (`ancestorAccess: metadata`), at the cost of weaker oversight?
7. May platform operators move a subtree to another organisation (needs a chain hand-over with
   W7-1), or is that always export plus import?
8. Currency: caps are stored in micro-USD like every budget today; the owner's example uses EUR.
   Display currency per organisation with a configured rate, or stay USD-only until v1.0?
