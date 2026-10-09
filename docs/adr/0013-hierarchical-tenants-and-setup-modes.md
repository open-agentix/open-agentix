# ADR 0013: Hierarchical tenants and setup modes

- Status: Accepted (accepted by the owner 2026-10-09; the owner decisions of 2026-10-09 on all eight
  original open questions are incorporated, see "Owner decisions")
- Date: 2026-10-09 (amended 2026-10-09 with the owner decisions)
- Plan items: W13-1 to W13-16 (section 15; wave 13 of the
  [implementation plan](../IMPLEMENTATION-PLAN.md))
- Builds on: [ADR 0002](0002-audit-hash-chain.md) (audit hash chain),
  [ADR 0003](0003-policy-engine-audit-and-control-agents.md) (policies, stricter wins),
  [ADR 0007](0007-tenants-as-isolation-boundary.md) (tenants as the isolation boundary),
  [ADR 0009](0009-model-proxy.md) (reservations, `ModelAccountingService`),
  [ADR 0012](0012-connections-instances-scopes-and-data-protection.md) (connection instances,
  central grants, retention, erasure)
- Amends: ADR 0007 (a tenant may have a parent; visibility of descendants; nodes may change
  organisation), ADR 0009 section 4.3 (lock set and limits of the reserve transaction), ADR 0012
  sections 2 and 7 (grants and tenant settings are inherited down the tree; section 7.7: platform
  admins see content by default, section 7 of this ADR)
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

### Owner decisions (2026-10-09)

The first version of this ADR ended with eight open questions. The owner answered all of them on
2026-10-09; the answers are binding for this ADR and are worked into the sections named below.

| # | Question | Decision | Where |
| --- | --- | --- | --- |
| 1 | What does single-tenant mode show of costs? | a simple **monthly sum plus the cost per run**; budgets and use cases are not hidden entirely, they stay available beyond that (collapsed, optional) | 12.2 |
| 2 | Guaranteed minimum share of the parent budget for children? | **optional and configurable per node**, off by default | 4.1 |
| 3 | Headroom leases? | **yes, for prioritised use cases**, introduced when contention is measured | 5.5 |
| 4 | Depth limit? | **default structure of 2 levels**; any number of further levels can always be added. No fixed small limit; only a technical safety maximum | 2 |
| 5 | Convert a team into a sub-tenant? | **yes** | 9.3 |
| 6 | Visibility of ancestors, metadata-only option? | **admin sees everything, tenant admin sees everything in the tenant, use-case admin sees the own use case and its children**; no metadata-only option | 7 |
| 7 | Move a subtree into another organisation? | **allowed** | 9.2 |
| 8 | Currency and units? | **one global admin setting for all** (not per organisation), default **USD** | 12.5 |

Related showcase decisions of the same day ([showcase agents](../showcase-agents.md)): the fixed
role `viewer` keeps **no** `audit:read`; a new fixed role `pentest` reads everything including
`audit:read` (section 7.5); anonymous showcase guests act as `viewer`.

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
  - `depth smallint not null` (0 for roots), check `depth <= 32` (technical safety maximum, see
    below),
  - `limits jsonb not null default '{}'` (section 4), `settings jsonb not null default '{}'`
    (inheritable settings, section 3),
  - `use_case text null`: optional attachment of a child node to a use case of its parent
    (section 7.2); `converted_from_team uuid null` (section 9.3).
  The unique index on `slug` is replaced by `tenants_parent_slug_uq (coalesce(parent_id, root
  sentinel), slug)`: slugs are unique among siblings, root slugs stay globally unique. A node is
  addressed by id or by its **slug path** `acme/div-a/team-a`.
- Why a materialized path and not an adjacency list with recursive CTEs, `ltree` or a closure
  table: subtree and chain queries are single index lookups without recursion; the path is short
  (bounded by the safety maximum below); text paths work identically in PostgreSQL and PGlite (no
  extension); moves are rare and rewrite only the paths of the moved subtree. A closure table would
  make moves and inserts O(depth x subtree) rows and is not needed at this depth.
- **Depth: default structure 2 levels, more at any time (owner decision 4).** The wizard and the
  console offer a structure of **2 levels below the root** by default (organisation -> department
  -> team), and the console tree opens these two levels. **Any number of further levels can be
  added at any time** with "add sub-tenant" on any node; there is no small depth limit in the product
  and no setting has to be changed first. The only bound is a **technical safety maximum of 32
  levels below the root**, which an operator may only lower with `OAX_TENANT_MAX_DEPTH` (1 to 32,
  default 32), never raise (database check `depth <= 32`; creating or moving a node beyond it is
  `422 tenant_depth_exceeded`). Why 32 and why a maximum at all:
  - **Lock set**: every reservation takes one advisory lock per capped node of the chain
    (section 5.1), at most 33 plus the tree lock. That stays well inside PostgreSQL's default lock
    table sizing (`max_locks_per_transaction = 64`, shared across connections), so a deep tree
    cannot exhaust the lock table of a default installation.
  - **Index entry size**: the path is 37 bytes per level, so 33 levels are about 1.2 KB, well below
    the B-tree entry limit of about 2.7 KB for `tenants_path_idx` and for the reservation index on
    `tenant_path`.
  - **Bounded work per request**: the effective-value resolver reads at most 33 rows per request
    (section 3); without a bound, a runaway script could create chains that make every request and
    every reservation slower.
  - 32 levels is far beyond any organisational chart seen in practice (large enterprises rarely go
    beyond 8 to 10), so it never limits a real structure; it only stops loops and mistakes.
  `OAX_TENANT_MAX_NODES_PER_ROOT` (default 1000, configurable) remains as a guard against runaway
  automation; it limits the number of nodes, not the depth.
- `tenant_usage_counters (tenant_id, period, spent_micros, tokens, runs_started,
  carried_micros, carried_tokens, carried_runs)`, primary key `(tenant_id, period)`, `period` =
  month (UTC, the ledger's `month`). A row exists only for nodes that have at least one cap or a
  guaranteed minimum (sections 4 and 5.2); it holds the **settled** usage of the node's subtree.
  The `carried_*` columns hold usage that stays counted at a node for the rest of the period after
  a subtree left it (moves, section 9) or that a converted team brought with it (section 9.3);
  reconciliation adds them to what it computes from the ledger. Active reservations are not stored
  in counters (they are read from `model_reservations`), so a crashed worker can never leave a
  counter inflated.
- `model_reservations` gains `tenant_path text not null` (copied from the run's tenant at reserve
  time, rewritten for active rows on a move) with index `(status, tenant_path text_pattern_ops)`
  where `status = 'active'`.
- `cost_ledger` gains `root_id` (the organisation at settlement time, so that a later move into
  another organisation does not shift past costs between organisations, section 9.2); subtree cost
  reports join `tenants.path` (reports are not on the hot path).
- `installation_settings` (single row): `mode` (`single | multi`), `setup_completed_at`,
  `setup_version`, and the global display units of section 12.5 (`display_currency`,
  `usd_exchange_rate`, `rate_updated_at`, `token_unit`).
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
| Guaranteed minimum (optional, section 4.1) | `limits.guaranteed` per cap kind | **not inherited**: it is a relation between a node and its parent's own cap | sum over siblings `<=` the parent's own cap; `<=` the node's own cap if set |
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
- Operator access (ADR 0012 7.7) is **no longer a per-node setting**: inside the tree there is no
  metadata-only mode (owner decision 6, section 7); see section 7.4 for platform admins.
- Effective values are computed per request from the chain (at most 33 rows, cached per request and
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
  does **not** reserve anything for the child. Reserving part of the parent's cap for a child is
  the separate, optional **guaranteed minimum** of section 4.1.
- Team, use-case and (with W2-5) agent budgets stay as additional scopes **inside** a node and are
  checked as today. They never cross nodes.
- Period: calendar month in UTC, as the cost ledger. Runs caps count runs started in the period;
  token caps count settled input plus output tokens; concurrency caps count active runs and active
  model reservations of the subtree at that moment.

#### 4.1 Guaranteed minimums (optional, per node)

Owner decision 2: a node may be given a **guaranteed minimum share** of its parent's cap. It is
**off by default** (no guarantee = the pure cap model above) and configured per node and per cap
kind (cost, tokens, runs; concurrency as a number of slots).

- **Setting**: `limits.guaranteed = { monthlyBudgetMicros?, monthlyTokens?, monthlyRuns?,
  concurrentRuns? }` on the child, either as an absolute value or as `{ percentOfParent }`
  (resolved against the parent's own cap at check time). It is set by the **parent's** admins, like
  the child's cap (a node never grants itself headroom).
- **Preconditions** (write time, `422 guarantee_invalid` with the reason): the parent has an **own**
  cap of that kind (a guarantee against an inherited cap would have to lock and track nodes above
  the parent; `guarantee_requires_parent_cap`); the sum of all siblings' guarantees is `<=` the
  parent's own cap (`guarantees_exceed_parent`); the guarantee is `<=` the child's own cap if one is
  set. Unlike caps, **guarantees add up**, because they reserve real headroom. When a parent later
  lowers its cap below the sum of its children's guarantees, the guarantees are scaled down
  proportionally at check time and the console marks them `shadowed`.
- **Rule**: for a parent `P` with own cap `C` and children `c` with guarantee `g_c` and subtree
  usage `u_c` (settled plus active reservations), the unused guarantee of a child is
  `r_c = max(0, g_c - u_c)`. A call from inside the subtree of child `x`, or from `P` itself
  (`x = none`), must satisfy, in addition to the cap rule of section 4:

  ```text
  usage(subtree(P)) + reserved(subtree(P)) + this_call + sum(r_c for every child c != x)  <=  C
  ```

  So siblings and the parent's own agents cannot eat into what is still guaranteed to `x`, while
  `x` can use its guarantee and, beyond it, whatever is still free in the shared pool up to its own
  cap and every ancestor's cap.
- **Scope**: a guarantee protects a child only against its siblings and its parent's own usage
  inside the parent's cap. It does not protect the parent's subtree against the parent's siblings;
  that needs a guarantee on the parent itself (guarantees compose level by level).
- **Concurrency guarantees** reserve slots: `concurrentRuns` slots of the parent's
  `maxConcurrentRuns` stay available to the child while the child uses fewer.
- **Period**: guarantees are per period like caps and do not roll over; unused guarantee at the end
  of the month is gone.
- **Locking**: because the parent has an own cap, it is in the L1 lock set of every reservation,
  settlement and expiry in its subtree (section 5.1). The sibling counters and sibling reservations
  that `r_c` needs are therefore read under a lock that every writer of them also holds, so the
  check is exact. Nodes with a guarantee get a counter row (section 2) even without an own cap.
- **Cost**: a guarantee strands headroom by design (an idle child keeps its share). The console
  shows the reserved but unused amount on the parent's usage bar, so admins see what it costs.

### 5. Reservation against all ancestors under lock (`ModelAccountingService`)

#### 5.1 Lock order and deadlock avoidance

Locks are taken in a fixed hierarchy; a transaction never acquires a lock of a lower level after
one of a higher level:

| Level | Lock | Mode | Taken by |
| --- | --- | --- | --- |
| L0 | tree lock of the root: `pg_advisory_xact_lock_shared(TREE_NS, key(root_id))` / `pg_advisory_xact_lock(TREE_NS, key(root_id))` | shared for reserve, settle, expire, run admission; **exclusive** for move, cap creation or removal, node deletion | all |
| L1 | accounting lock of every **capped** node and every node with a **guaranteed minimum** (section 4.1) in the chain, plus the calling node: `pg_advisory_xact_lock(ACCOUNTING_NS, key(id))` | exclusive | reserve, settle, expire |
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
   For every capped node `P` in the chain whose children carry guarantees (section 4.1), the
   unused guarantees of the children that are **not** on the caller's path are added to `used`
   of `P`'s limit (code `control_budget_guaranteed`, details `{ tenant, reservedForChildren }`
   without naming the siblings to callers who cannot see them).
6. Concurrency: the session and leaf checks stay; each capped node with
   `maxConcurrentModelCalls` adds `count(active reservations under path(A)) < cap`.
7. Lease path (section 5.5): if the leaf holds an active headroom lease for the run's use case,
   step 2 takes L0 shared and the leaf's L1 lock only, and in step 4 the ancestors up to the
   lease's grantor are replaced by one limit: the lease's outstanding amount. When the lease does
   not cover the call, the reservation falls back to the full path above.
8. Insert the reservation with `tenant_path`.

#### 5.3 Settle and expire

Settlement and the reaper take the same L0 and L1 locks (computed from the reservation's
`tenant_path`), write the ledger line exactly as today, and add the actual cost and tokens to the
counter row of every capped node in the chain (`insert ... on conflict (tenant_id, period) do
update set spent_micros = spent_micros + excluded.spent_micros, ...`). Ledger line and counter
updates are in one transaction, so they cannot diverge. "Capped node" here and in section 5.2
includes nodes that carry a guaranteed minimum. A nightly reconciliation job recomputes counters
from the ledger (plus the `carried_*` columns, section 2), corrects differences and writes
`budget.counter_drift` (counts only); a drift is a bug signal, not an expected path.

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
acceptable for v0.x volumes and is the same order as today's per-tenant lock.

**Headroom leases (owner decision 3: yes, for prioritised use cases, when contention is
measured).** Leases are built, but switched on only when two conditions hold:

1. **Measured contention.** W13-4 ships the metric `oax_accounting_lock_wait_seconds{root}`
   (histogram of L0/L1 wait per reserve) and `oax_accounting_lock_timeouts_total{root}`. Leases
   become available for an organisation when its p95 lock wait exceeds
   `OAX_LEASE_CONTENTION_P95_MS` (default 50) over a 15-minute window or any lock timeout
   occurred; the console's usage page shows the measurement, so the decision is visible.
2. **Prioritised use case.** Only use cases marked `priority: high` on a node
   (`settings.prioritizedUseCases: [<useCase>]`, set by a tenant admin of that node or above) get
   leases. Everything else keeps the exact per-call path above.

Mechanics:

- A **lease** `budget_leases (id, tenant_id, use_case, grantor_id, kind, amount, consumed,
  expires_at, status)` is granted to a leaf node for one prioritised use case by a background
  refill (never on the request path) under the full L0/L1 lock set of the leaf's chain. The leased
  amount counts as an **active reservation at every capped ancestor up to and including the
  grantor** (the highest capped node in the chain), so the invariant of section 4 holds while the
  lease exists.
- Calls of that use case in that leaf then reserve against the lease under the **leaf's lock
  only** (plus the leaf's own checks); the hot path no longer touches the root lock.
- Settlement adds actual usage to the counters as usual and reduces the lease's outstanding
  amount by the same value; on expiry (`OAX_LEASE_TTL_SECONDS`, default 60) or when the period
  ends, the unused remainder is released in one transaction.
- **Size**: at most `OAX_LEASE_MAX_SHARE` (default 5 %) of the grantor's remaining headroom and
  never more than the leaf's own remaining cap. A lease is not granted when the grantor's
  remaining headroom is below 10 % of its cap, so near the limit every call goes through the exact
  path again and the hard stop stays precise.
- **Guarantees win over leases**: the headroom available for leases excludes unused guarantees of
  other children (section 4.1).
- Leases strand at most `lease size x number of prioritised leaves` for at most one TTL; the usage
  page shows leased headroom separately. Lowering a cap revokes outstanding leases (calls in flight
  settle normally).
- Events: `budget.lease_granted`, `budget.lease_released` (amounts only), and the switch-on
  decision `budget.leases_enabled { root, p95Ms }`.

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

Owner decision 6: **admin sees everything, tenant admin sees everything in the tenant, use-case
admin sees the own use case and its children.** There is no metadata-only option between levels
of the tree.

#### 7.1 The three admin scopes

| Scope | Who | Sees and administers |
| --- | --- | --- |
| **Admin** (installation) | platform admin (`users.platform_admin`, today's platform operator) | **everything** in every organisation: structure, settings, runs including content, costs, audit; acts in any node with `X-OAX-Tenant` |
| **Tenant admin** | `admin` binding on a node | **everything in that node and its whole subtree**, including run content of descendants; grants roles on the node and its descendants |
| **Use-case admin** | `admin` binding on a node **restricted to one use case** | the **own use case and its children** in that node (7.2): its agents, runs including content, costs, budgets, audit entries; nothing else of the node |

The other fixed roles (`agent-engineer`, `integrator`, `operator`, `auditor`, `viewer`, and the new
`pentest`, section 7.5) use the same scoping: bound on a node they apply to the subtree, bound to a
use case they apply to the use case and its children.

#### 7.2 Use cases and their children

A use case is the `labels.useCase` value of an agent definition inside a node (as today, cost
attribution and `use_case_budgets`). Its **children** are:

- **sub-use cases**: use case labels with the use case as a path prefix (`support` has the children
  `support/billing` and `support/billing/refunds`; `/` is the separator, matching is per segment),
- **attached child nodes**: child tenants of the node whose `tenants.use_case` names the use case
  or one of its sub-use cases, **with their whole subtree** (a use case that grew into its own
  sub-tenant, for example after a team conversion, section 9.3, stays under its use-case admin).

A use-case admin therefore sees exactly: agents, runs, events, costs, budgets and audit entries of
the node that carry the use case or a sub-use case, plus everything in the attached child nodes.
Other use cases of the node, node-level settings, node users and connections owned by the node are
not visible beyond the names needed to use them (an inherited connection can be used by the use
case's agents as before, its endpoint and secret references stay hidden).

#### 7.3 Bindings and granting

- **Bindings** move from "global roles of the home tenant" to `tenant_role_bindings (user_id,
  tenant_id, role, use_case text null, expires_at timestamptz null)`; `use_case null` means the
  whole node and subtree. On migration every global role becomes a binding on the user's home
  tenant without use case (no behaviour change). Team and agent bindings stay inside their node.
  A user may hold bindings on several nodes of one organisation, never across organisations
  (platform admins excepted).
- **Granting**: a tenant admin of `N` may grant roles on `N` and its descendants, with or without a
  use case; a use-case admin may grant roles only for the own use case, its sub-use cases and its
  attached child nodes. Nobody grants a role they do not hold on that scope themselves, and nobody
  grants on an ancestor or sibling.
- **Caps and budgets**: a use-case admin sets budgets of sub-use cases and caps of attached child
  nodes, never the budget of the own use case (set by the tenant admin of the node), consistent
  with "a node never raises its own ceiling".
- **No removal of inherited oversight**: a descendant cannot remove or restrict an ancestor's
  bindings on itself. It can add **role restrictions** for its subtree (e.g. in team A,
  `agent-engineer` lacks `agents:publish`); restrictions remove permissions and never add any, and
  they never apply to tenant admins of ancestors or to platform admins. The role set stays fixed
  (now seven roles with `pentest`); custom roles are not part of this decision.

#### 7.4 Acting node, subtree views and what is visible upwards

- **Acting node**: every request still acts in exactly one node (no ambient multi-tenant queries,
  ADR 0007 stays intact). `X-OAX-Tenant: <id | slug path>` is allowed for any node in the caller's
  visible subtree, not only for platform admins. Read views that make sense across a subtree (runs,
  costs, audit, budgets) accept `?scope=subtree`, implemented with the path prefix and the same
  permission check on the acting node; for use-case-scoped bindings the use case filter (7.2) is
  added to the query, never left to the client.
- **Upwards**: a user sees the names and slugs of the ancestors on the path (breadcrumb) only.
  Siblings, cousins and ancestors' resources stay 404, exactly as another tenant today. Of
  ancestors, descendants see effective values with their source node name and, when blocked, the
  blocking node and the remaining headroom of the tightest ancestor as a number; not the usage of
  siblings or a breakdown of the ancestor's counter.
- **Content inside an organisation** follows the bindings: tenant admins (and other roles with read
  permissions) of an ancestor read descendants' run content. There is **no** per-node
  `ancestorAccess` or metadata-only switch (open question 6 of the first version, answered no).
  Units that need stronger separation from each other are separate organisations.
- **Platform admins** see everything (7.1). This changes the default of ADR 0012 section 7.7:
  `operatorAccess` is no longer a tenant setting and defaults to `full` in both modes. The
  metadata-only mode with break-glass access (ADR 0012 7.7) remains available only as an
  **installation-wide opt-in** (`OAX_OPERATOR_ACCESS=metadata`) for installations where the platform
  admin is a service provider for other companies; it never applies between levels of one
  organisation. In single-tenant mode the one user is platform admin and tenant admin of the
  default tenant.

#### 7.5 Fixed roles `viewer` and `pentest`

Showcase decisions of 2026-10-09 ([showcase agents](../showcase-agents.md) section 5):

- `viewer` stays as today: `agents:read`, `runs:read`, `events:read`, `costs:read`, **without**
  `audit:read`. Anonymous showcase guests act as `viewer`.
- New fixed role **`pentest`**: read access to everything, including the audit log:

  ```text
  pentest = agents:read, runs:read, events:read, sources:read, connections:read, policies:read,
            audit:read, audit:verify, costs:read, users:read, tokens:read, settings:read
  ```

  No `write`, `execute`, `approve`, `cancel` or `audit:export` (export is a bulk data transfer, not
  needed to test; a tester who needs it gets `auditor` explicitly). Secret values stay unreadable
  through every API as for every role; `tokens:read` shows token metadata only. Because the role
  sees users, settings and all content of its scope, a `pentest` binding **must** carry
  `expires_at` (at most `OAX_PENTEST_MAX_DAYS`, default 30), can be granted only by a tenant admin
  or platform admin, and is announced to the tenant admins of the bound node
  (`tenant.role_bound { role: pentest, expiresAt }`).

### 8. Audit hash chain

- Entries keep `tenant_id` = the acting node (partition key outside the hash, ADR 0002/0007). The
  path is **not** stored in entries, because nodes can move; visibility is computed from the
  current tree: admins and auditors of an ancestor see the entries of its subtree.
- `POST /v1/audit/verify` for a node user verifies the chain and reports issues of the visible
  subtree only (extends today's rule).
- With W7-1 (per-tenant chains) the chain unit is the **organisation (root)**, not every node:
  moves inside an organisation then never cross chains, and verification of a subtree is a filter
  on one chain. Moves across organisations hand over between two chains with linked entries and
  never rewrite history (section 9.2).
- New events (names and numbers, never secret values): `tenant.created`, `tenant.moved { from,
  to }` (written in old and new parent partitions), `tenant.limits_changed { field, from, to }`,
  `tenant.settings_changed { field, from, to }`, `tenant.deleted`, `tenant.role_bound` /
  `tenant.role_unbound`, `tenant.role_restricted`, `budget.blocked_by_ancestor { ancestor, kind }`,
  `budget.counter_drift`, `budget.guarantee_changed`, `budget.lease_granted`,
  `budget.lease_released`, `budget.leases_enabled`, `tenant.move_requested`,
  `tenant.move_approved`, `tenant.move_rejected`, `tenant.moved_out`, `tenant.moved_in`,
  `team.converted { team, tenant }`, `setup.completed { mode }`, `setup.mode_changed { from, to }`,
  `installation.units_changed { field, from, to }`.

### 9. Moving nodes and converting teams

#### 9.1 Moves inside an organisation

`POST /v1/tenants/{id}/move { parentId, dryRun, clamp }` (tenant admin of both the old and the new
parent, or platform admin):

- Takes the L0 **exclusive** lock of the root; rewrites `path`, `depth` of the subtree and
  `tenant_path` of active reservations; recomputes the counters of every capped node in the old
  and new chain for the current period. Usage of the moved subtree in the current period **stays
  counted** at the old ancestors that are not also new ancestors (`carried_*`, section 2) and is
  **added** to the new ancestors' counters: moving a subtree never frees or hides budget headroom
  within a period (no cap evasion by moving).
- Validates narrowing against the new parent's effective values; violations are listed and the
  move is refused unless `clamp: true`, which marks the moved node's wider own values as shadowed
  (section 3) instead of editing them.
- `dryRun: true` reports the effect: values that become shadowed and caps that would block the
  subtree immediately.

#### 9.2 Moves into another organisation

Owner decision 7: a subtree may be moved into **another organisation**. The same endpoint is used
with a `parentId` in another organisation; because two organisations and two audit chains are
involved, the move is a **two-party request** and has stricter rules.

**Consent and approval**

1. **Request**: a tenant admin of the moved node's parent (or of any ancestor of it), or a platform
   admin, calls `POST /v1/tenants/{id}/move { parentId, dryRun: false, clamp, connectionMap,
   secretRefMap, drain }`. The result is a `tenant_move_requests` row (`pending`, expires after 7
   days) with the dry-run report attached, not a move.
2. **Approval**: a tenant admin of the target parent (or of any ancestor of it) approves
   (`POST /v1/tenant-moves/{id}/approve`) or rejects it. The source side cannot approve for the
   target. A platform admin may approve both sides, but then must give a `reason`, and the tenant
   admins of **both** organisation roots are notified.
3. **Data protection**: the request names both organisations as they appear in the processing
   records (ADR 0012 7.5). The approval text states that run content, costs and audit references of
   the subtree become visible to the target organisation's admins. If the installation marks
   organisations as separate controllers (`settings.dataController` on a root), the approval also
   requires a tenant admin of the **source** root (not only of the moved node's parent).
4. Approving executes the move synchronously; any validation that fails at that moment refuses it
   (the dry-run report may be outdated).

**Locks**

- L0 **exclusive** on **both** roots, acquired in ascending lock-key order (the same total order as
  L1, so two opposite moves cannot deadlock). This blocks every reservation, settlement, expiry,
  run admission and structural change in both organisations for the duration of the move (a few
  queries per moved node; `OAX_MOVE_LOCK_TIMEOUT_MS`, default 10 000, then `503`, nothing changed).
- The audit append for both chains happens inside the same transaction after L0 (level L2; with
  per-organisation chains, W7-1, the two chain locks are taken in lock-key order as well).

**Audit chain per organisation root**

- History is **never rewritten or copied**. Entries written while the subtree belonged to the source
  organisation stay in the source chain.
- The source chain gets `tenant.moved_out { nodes, toRoot, subtreeDigest }`; the target chain gets
  `tenant.moved_in { nodes, fromRoot, sourceEntry: { chain, seq, hash } }`, which references the
  hash of the `moved_out` entry. The pair is the hand-over link: verification of either chain shows
  where the subtree came from or went, and a verifier with access to both can check the link.
- Visibility after the move: the target organisation's admins can read the moved nodes' **historic**
  entries in the source chain (filtered by the moved node ids and `seq <= moved_out.seq`) and
  verify them with the source chain's checkpoints, read-only. The source organisation's admins
  keep read access to the entries written under their organisation (their own accountability
  record) until the source retention ends, and lose access to everything after the move.
- Before W7-1 (one global chain) the two entries are written in the two partitions of the same
  chain; the rules for visibility are the same.

**Budget counters**

- Usage of the current period stays counted at the source ancestors (`carried_*`) and is added to
  the target ancestors' counters, as for moves inside an organisation (9.1). The dry run reports
  target caps that this would exhaust immediately; the move is refused in that case unless
  `acceptBlocked: true` is given in the request and approved.
- Guarantees (4.1) of moved nodes are dropped (they referred to the old parent's cap); the target
  parent's admins set new ones. Headroom leases of the subtree are released before the move.
- Cost ledger lines keep their `tenant_id`; reports of the source organisation keep showing the
  pre-move cost of the subtree for the periods in which it belonged to them (ledger lines are
  attributed by the organisation recorded at settlement: `cost_ledger.root_id`, added by this
  ADR's migration for that purpose).

**Secrets, connections and grants**

- Connection instances **owned inside** the moved subtree move with it, together with their secret
  references. Every secret reference must match the target chain's `secret_refs` patterns
  (section 3); otherwise `secretRefMap` must map it to a new reference that does, else the move is
  refused (`422 secret_ref_not_allowed`). Secret values are never copied, exported or read; the
  target side must be able to resolve the (mapped) reference in its own secret store.
- Instances **inherited from outside** the subtree (from source ancestors) and central grants made
  to source ancestors are no longer available. `connectionMap` maps each one that agents in the
  subtree use to an instance visible at the target parent, or to `disable`; an unmapped one refuses
  the move (`422 unmapped_connection`). Mapped bindings are re-validated against the target's tool
  profiles and narrowing rules.
- Policies and guidelines of source ancestors stop applying; those of the target chain apply
  (union, stricter wins). The dry run lists the effective policy difference.
- API tokens and agent service principals of the moved nodes are **revoked and re-issued** on the
  target side (tokens were issued under the source organisation's governance); webhook URLs keep
  their ids, their signing secrets are rotated.
- Role bindings of users whose home tenant is in the source organisation are removed (users never
  hold bindings across organisations, 7.3); the dry run lists them, and target admins re-grant.

**What is refused**

| Condition | Code |
| --- | --- |
| target parent inside the moved subtree (cycle) | `422 move_cycle` |
| resulting depth above the technical maximum, or target root above `OAX_TENANT_MAX_NODES_PER_ROOT` | `422 tenant_depth_exceeded`, `422 tenant_node_limit_exceeded` |
| active runs, active reservations or runs waiting for approval in the subtree (unless `drain: true`, which stops admission for the subtree and waits up to the lock timeout) | `409 subtree_busy` |
| stored data in a region the target chain does not allow (stored data cannot be clamped) | `422 move_region_conflict` |
| data classified above the target chain's `maxClassification` | `422 move_classification_conflict` |
| unmapped inherited connection, or secret reference not allowed by the target | `422 unmapped_connection`, `422 secret_ref_not_allowed` |
| narrowing violations without `clamp: true` | `422 not_narrowing` |
| moving the default tenant, or moving a root (merging organisations) by anyone but a platform admin with approval of both roots' tenant admins | `403 move_not_allowed` |
| expired or already decided request | `409 move_request_closed` |

A **shorter retention** in the target chain is not a refusal: it applies from the move on, and the
dry run reports how much stored content the next retention run will purge.

#### 9.3 Converting a team into a sub-tenant

Owner decision 5: a team can be converted into a child node of its tenant.
`POST /v1/teams/{id}/convert-to-tenant { slug, name, useCase?, dryRun }` (tenant admin of the
team's node, or platform admin):

- Takes the L0 exclusive lock of the root. Refused with `409 subtree_busy` while agents of the team
  have active runs, reservations or pending approvals.
- Creates the child node under the team's node (narrowing validation as for any new child;
  `use_case` optionally attaches it to a use case, 7.2) and sets `converted_from_team`.
- **Moves**: the team's agents with their versions, triggers, event sources and agent-scoped
  bindings; team-scoped policy bindings become bindings on the new node. Team members get
  `tenant_role_bindings` on the new node with their team role.
- **Budget**: the team's monthly budget becomes the child's own cap (validated `<=` the parent's
  effective cap). The team's spend of the current period is written to the child's counter as
  `carried_*`, so the child continues the month where the team stood; the parent's counters are
  unchanged because they already contain that spend.
- **Stays in the parent**: historic runs, cost ledger lines and audit entries (immutable history in
  the parent's partition; the parent's tenant admins see both anyway), connection instances (the
  child inherits them, section 6), use case budgets of the parent (the dry run lists those that
  only the team's agents used, so the admin can recreate them on the child).
- **Tokens**: API tokens scoped to the team keep working only in the parent and are listed in the
  dry run for re-issue on the child.
- The team row is archived with a reference to the new node; `team.converted { team, tenant }` is
  written in the parent's partition and `tenant.created` in the child's.
- The reverse (tenant into team) is not offered: it would merge two isolation scopes. Teams that
  are not converted stay lightweight groups inside a node.

### 10. Data protection and deletion

- Retention, region and PII settings (ADR 0012 section 7) are inherited with
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
- Teams are **not** converted to child tenants automatically. They stay lightweight groups inside
  a node. Organisations that want "team A" as an isolated unit with its own budget cap and
  connections convert it on demand (section 9.3) or create a new child tenant.
- `cost_ledger.root_id` is backfilled with the tenant's id (every tenant is a root after the
  migration).
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
| Console | no tenant switcher, no Tenants page, no central connections or grants view, no scope pickers (everything is created on the default tenant); costs as a **simple monthly sum plus the cost of every run** (owner decision 1); budgets and use cases are **not hidden entirely**: one optional monthly budget, use case budgets and the use case filter stay available in a collapsed "Budgets" section | tree navigation (2 levels open by default), tenant switcher (breadcrumb), effective values with "inherited from", grants, guarantees, subtree views |
| Defaults | `OAX_PLATFORM_CONNECTIONS_DEFAULT_GRANT=all` behaviour, retention as ADR 0012 defaults | ADR 0012 defaults (default deny for central instances) |
| Admin visibility | the one user is platform admin and sees everything | platform admins see everything (section 7.4); metadata-only only with the installation-wide opt-in |
| Users | the bootstrap admin; more users can be added (they stay in the default tenant) | per node |

- **Single -> multi**: always allowed (`PATCH /v1/installation { mode: "multi" }`, platform
  operator); the default tenant becomes the first organisation (rename offered).
- **Multi -> single**: allowed only when exactly one tenant exists and it has no children
  (`409 mode_requires_single_tenant` otherwise).

#### 12.3 Wizard

Shown to the bootstrap administrator on the first login while `setup_completed_at` is null.
Steps: (1) mode, with the two recommendations as written above; (2) organisation name and slug
(single-tenant: the default tenant's display name only; multi-tenant: optionally the default
2-level structure, e.g. departments and teams, that can be extended later at any depth);
(3) display currency and units (section 12.5, default USD); (4) model providers and MCP servers
(instances per ADR 0012, connection test per ADR 0011 section 8; may be skipped); (5) budget
(optional monthly cap on the root; single-tenant: one field, skippable); (6) summary. Every step
is saved immediately, the wizard can be left and resumed, and `POST /v1/setup/complete` records
`setup.completed`.

Headless installs (Helm, Compose, IaC) set `OAX_SETUP_MODE=single|multi` (and optionally
`OAX_SETUP_ORG_NAME`, `OAX_DISPLAY_CURRENCY`); the wizard is then skipped and the values are
applied at startup once.

#### 12.4 Security of the setup endpoints

`GET /v1/setup` is public but returns only `{ required: boolean }`. All setup writes require an
authenticated platform operator; there is no unauthenticated "claim this installation" flow (the
bootstrap admin comes from configuration as today). After completion the setup write routes answer
`409 setup_completed`, except the mode switch.

#### 12.5 Currency and units: one global setting

Owner decision 8: currency and units are **the same for everybody**, set once by a platform admin
for the whole installation, **not per organisation or node**; the default is **USD** (providers
price in USD).

- `PATCH /v1/installation { displayCurrency, usdExchangeRate, tokenUnit }` (platform admin):
  `displayCurrency` is an ISO 4217 code (default `USD`); for any other currency
  `usdExchangeRate` (units of the display currency per USD) is required and entered by the admin.
  There is no automatic rate download (no outbound call from the control node for this; a rate
  importer can be added later as an explicit, pinned connection). `tokenUnit` chooses how token
  counts are shown (`raw`, `k`, `M`).
- **Storage stays micro-USD** for every price, ledger line, budget, cap, guarantee and lease, as
  today. Inputs in the display currency are converted at the current rate when written; the audit
  event records the entered value, currency and rate (`tenant.limits_changed`).
- A rate change changes **displayed** values, never enforcement: a cap entered as 300 EUR is stored
  as its USD equivalent at that day's rate and is shown as "about 300 EUR" afterwards. The console
  shows the rate date next to converted values.
- Every organisation, report, export (with an extra `currency` and `rate` column) and alert uses
  the same setting; API responses keep `...Micros` fields in USD and add `display` values.
- Changing the setting writes `installation.units_changed`.

### 13. API and console sketch

API (OpenAPI additions generated by the implementing tasks):

| Method and path | Who | Purpose |
| --- | --- | --- |
| `GET /v1/setup`, `PUT /v1/setup/{step}`, `POST /v1/setup/complete` | public (status) / operator | wizard |
| `GET /v1/installation`, `PATCH /v1/installation` | platform admin (read: any user) | mode, display currency and units (12.5) |
| `POST /v1/tenants` (`parentId` optional) | operator for roots; `admin` of the parent for children | create |
| `GET /v1/tenants/tree?root=` | any user | visible tree (ids, slugs, names, depth, status `active | blocked`) |
| `GET /v1/tenants/{id}/effective` | `settings:read` on the node | effective values with source node and `shadowed` flags |
| `PATCH /v1/tenants/{id}/limits`, `PATCH /v1/tenants/{id}/settings` | `settings:write` on the parent for caps (a node cannot raise its own cap), on the node for narrowing settings | own values |
| `GET /v1/tenants/{id}/usage?period=` | `costs:read` | counters of the node, per-child breakdown (only children visible to the caller), headroom of the tightest ancestor |
| `PATCH /v1/tenants/{id}/limits` with `guaranteed` | `settings:write` on the parent | guaranteed minimums (4.1) |
| `GET /v1/tenants/{id}/leases` | `costs:read` | active headroom leases and the contention measurement (5.5) |
| `POST /v1/tenants/{id}/move`, `DELETE /v1/tenants/{id}` | see sections 9, 10 | structure; across organisations the move returns a request |
| `GET /v1/tenant-moves`, `POST /v1/tenant-moves/{id}/approve`, `.../reject` | tenant admin of the target side (approve), either side (read) | cross-organisation moves (9.2) |
| `POST /v1/teams/{id}/convert-to-tenant` | tenant admin of the team's node | team conversion (9.3) |
| `PUT/DELETE /v1/tenants/{id}/role-bindings` (with optional `useCase`, `expiresAt`), `.../role-restrictions` | `users:write` on the node, or a use-case admin for the own use case | roles (7.3) |
| `GET /v1/runs`, `/v1/costs`, `/v1/audit`, `/v1/budgets` with `?scope=subtree` | as today on the acting node | subtree views |
| `POST /v1/agents/{id}/disable`, `.../enable` | `agents:publish` on the agent (implemented, UX slice A7) | switch an agent off without deleting it; see `docs/ux/multi-tenant-ux.md` section 1.2.2 |

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
  - parent exhausted -> every descendant at depths 1 to 5 and at the technical maximum (32) is
    refused for model calls and run admission; events are recorded as not started
    (`budget_exhausted`); a raise of the cap unblocks immediately;
  - parent spend counts against the parent's own cap together with its children;
  - month rollover resets counters; lowering a cap below usage blocks at once; in-flight
    reservations settle;
  - guaranteed minimums: siblings and the parent's own agents are refused once only the unused
    guarantee of another child is left; the guaranteed child still gets its share; guarantees that
    exceed the parent cap are refused at write time and scaled when the parent lowers its cap;
  - headroom leases: the invariant holds with leases outstanding; leases are not granted below the
    10 % headroom threshold; lowering a cap revokes them; only prioritised use cases get them.
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
  removal of ancestor bindings; a use-case admin sees the own use case, its sub-use cases and
  attached child nodes and gets 404 for other use cases of the node; `viewer` gets 403 on audit
  routes; `pentest` reads every read route and is refused on every write route (route-table walk);
  `pentest` bindings without `expiresAt` are refused.
- **Moves and conversions**: inside an organisation (counters carried, no headroom gained); across
  organisations: request and approval rules, both roots locked in key order (two opposite moves in
  parallel never deadlock), hand-over entries link the chains and both chains verify, every refusal
  of the table in 9.2 has a test, unmapped connections and disallowed secret refs refuse,
  tokens are re-issued; team conversion moves agents and members, carries the period spend, keeps
  history in the parent.
- **Units**: conversion on write, audit of entered value and rate, a rate change never changes
  enforcement, single global setting applied in every organisation.
- **Migration**: a snapshot with flat tenants, budgets, global roles and active reservations
  upgrades to roots with identical behaviour (existing test suite green on the migrated data);
  down migration.
- **Setup**: wizard API state machine, headless `OAX_SETUP_MODE`, mode switch rules, and the full
  API test suite executed in both modes (authorization identical); console tests (en, de) for the
  hidden elements in single-tenant mode.

### 15. Work breakdown (wave 13)

| Wave | Item | Content | Depends on |
| --- | --- | --- | --- |
| 13a | W13-1 Tenant tree model | migration (section 2, 11, incl. `use_case`, `cost_ledger.root_id`, `carried_*`), tree service (create child, tree, technical depth maximum 32 and node limit, default 2-level structure, slug paths), `X-OAX-Tenant` slug paths, isolation probes | - |
| 13a | W13-2 Effective settings resolver | `packages/core/src/tenancy/effective.ts`, narrowing validation, `GET .../effective`, publish checks for model allowlist and run budget ceilings | W13-1 |
| 13a | W13-3 Setup modes and wizard API | `installation_settings`, `/v1/setup*`, `/v1/installation`, `OAX_SETUP_MODE`, upgrade defaults, global display currency and units (12.5, default USD, `OAX_DISPLAY_CURRENCY`) (owner task NEW-11, API half) | - |
| 13b | W13-4 Hierarchical caps in accounting | counters, lock hierarchy L0/L1/L2 with sorted keys, reserve/settle/expire over the chain, reconciliation job, `BudgetsService` chain verdicts, run admission `budget_exhausted`, alerts `blocked_by_ancestor`, lock-wait metrics for 5.5, Postgres concurrency tests | W13-1, PLAT-00 (Postgres CI job) |
| 13b | W13-5 Further caps | runs, tokens, concurrency caps on the same counters | W13-4 |
| 13b | W13-6 Roles and visibility | `tenant_role_bindings` with `use_case` and `expires_at`, the three admin scopes (7.1), use-case children (7.2), role restrictions, subtree views, grant rules, new fixed role `pentest`, `viewer` without `audit:read` (unchanged, now tested), `operatorAccess` default `full` with installation-wide opt-in | W13-1 |
| 13c | W13-7 Connections and grants inheritance | `inherit`, overrides, chain namespace, credential resolution by owning node | W13-2, W12 (ADR 0012) |
| 13c | W13-8 Policies and guidelines inheritance | chain union, stricter wins | W13-2 |
| 13c | W13-9 Audit | subtree visibility, verify scope, new events, W7-1 alignment note | W13-1 |
| 13c | W13-10 Console | tree (2 levels open, "add sub-tenant" at any depth), switcher, effective chips, limits and guarantee forms, blocked banner, wizard UI incl. currency step, single-tenant simplification (monthly sum plus cost per run, collapsed budgets and use cases; NEW-11 UI half), move requests and approvals, team conversion dialog, en and de | W13-2, W13-3, W13-4 |
| 13c | W13-13 Guaranteed minimums | section 4.1: `limits.guaranteed`, write-time validation, check in reserve, scaling when a parent lowers its cap, counters for guaranteed nodes, tests | W13-4, W13-5 |
| 13d | W13-11 Move inside an organisation, delete, export | sections 9.1 and 10 (carried counters), crypto-shredding per node | W13-4, W12 data protection |
| 13d | W13-14 Team to sub-tenant conversion | section 9.3 | W13-6, W13-11 |
| 13d | W13-15 Move into another organisation | section 9.2: move requests and approval, two-root locking, hand-over entries (two partitions before W7-1, two chains after), connection and secret reference mapping, token re-issue, refusal table | W13-11, W13-7, W13-9 (W7-1 for per-organisation chains) |
| 13d | W13-12 Docs and deployment | `docs/tenancy.md`, `docs/budgets.md`, `docs/setup.md`, `docs/roles.md` (admin scopes, `pentest`), Helm `setup.mode` and `displayCurrency` (mirror issue in open-agentix-helm), Compose env | all |
| 13e | W13-16 Headroom leases (gated) | section 5.5; built when the W13-4 metrics show contention (p95 lock wait above the threshold or lock timeouts) in a real installation; only for prioritised use cases | W13-4, measured contention |

Wave 13a items can start in parallel; W13-4 is the critical path and the riskiest change (it
touches money and locking) and gets a security and concurrency review before merge. W13-13 and
W13-15 touch money and cross-organisation data and get the same review. W13-16 is not scheduled
until contention is measured (owner decision 3).

## Consequences

- Positive: organisations can model departments and teams with inherited governance; the owner's
  budget rule is enforced exactly and stays correct under concurrency, because it reuses the
  reservation design of ADR 0009 with more limits in the same tightest-limit computation.
- Positive: narrowing-only inheritance makes the effective configuration of any node explainable
  ("inherited from ...", "limited by ...") and prevents a child from escaping its parent's
  governance.
- Positive: single-tenant users get a simple console without a second code path; switching to
  multi-tenant later loses nothing.
- Positive: the structure can grow without configuration (any depth up to a technical maximum
  nobody reaches), teams can become sub-tenants, and subtrees can change organisation without
  losing their audit history.
- Negative: every reservation in an organisation with a root cap serialises on the root lock;
  acceptable now, leases for prioritised use cases are the planned escape hatch once contention is
  measured.
- Negative: guaranteed minimums strand headroom by design and make the cap check of a parent depend
  on its children's usage; they are off by default.
- Negative: moves across organisations are the most complex operation in this ADR (two locks, two
  chains, re-binding of connections and secrets, token re-issue); they are two-party requests and
  have a long refusal list rather than a best-effort mode.
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
- **Configurable small depth limit (default 4, maximum 8)**: the first version of this ADR. Rejected
  by the owner (decision 4): structures must be extendable at any time; only a technical safety
  maximum remains.
- **Metadata-only access for ancestor admins (`ancestorAccess`)**: rejected by the owner
  (decision 6); separate organisations are the way to separate units.
- **Display currency per organisation**: rejected by the owner (decision 8); one global setting.
- **Moves across organisations only as export plus import**: loses the link between the audit
  chains and forces re-creating agents; rejected (decision 7) in favour of the hand-over move.

## Open questions

### Answered by the owner on 2026-10-09

All eight questions of the first version are answered (see "Owner decisions" at the top):

1. Single-tenant costs: monthly sum plus cost per run; budgets and use cases stay available
   (section 12.2).
2. Guaranteed minimums: optional, configurable per node (section 4.1).
3. Headroom leases: yes, for prioritised use cases, when contention is measured (section 5.5,
   W13-16).
4. Depth: default 2 levels, any number of further levels; technical maximum 32 only (section 2).
5. Team to sub-tenant conversion: yes (section 9.3).
6. Visibility: admin everything, tenant admin everything in the tenant, use-case admin the own
   use case and its children; no metadata-only option (section 7).
7. Moving a subtree into another organisation: allowed (section 9.2).
8. Currency and units: one global admin setting, default USD (section 12.5).

### Remaining

1. **Use-case children** (section 7.2): the ADR defines the children of a use case as sub-use cases
   by `/` prefix plus child nodes attached with `tenants.use_case`. Does this match the intended
   meaning of "use-case admin sees the own use case and its children"?
2. **Platform admins and content** (section 7.4): "admin sees everything" changes the ADR 0012 7.7
   default to `operatorAccess: full`; the metadata-only mode with break-glass stays only as an
   installation-wide opt-in for service-provider installations. Is keeping that opt-in wanted?
3. **Caps entered in another currency** (section 12.5): stored in USD at the day's rate, so the
   displayed value drifts with the rate. Alternative: store the entered currency and re-convert at
   check time (enforcement then follows the rate). Keep USD storage?
4. **Thresholds** proposed without measurements: lease switch-on at p95 lock wait 50 ms, lease size
   5 %, lease TTL 60 s, `pentest` bindings at most 30 days, move requests expire after 7 days.
5. **Cross-organisation moves between separate controllers** (section 9.2): is the extra approval
   by the source root's tenant admin enough, or should such moves be limited to platform admins?
6. **Root moves** (merging two organisations): allowed only for platform admins with approval of
   both roots; confirm, or refuse entirely.
