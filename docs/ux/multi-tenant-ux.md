# Multi-tenant UX for the console

- Status: Proposed (design for review; nothing here is implemented yet)
- Date: 2026-10-09
- Scope: `apps/ui` (console), with the API gaps it needs
- Builds on: [ADR 0007](../adr/0007-tenants-as-isolation-boundary.md),
  [ADR 0012](../adr/0012-connections-instances-scopes-and-data-protection.md),
  [ADR 0013](../adr/0013-hierarchical-tenants-and-setup-modes.md) (tenant tree, roles, setup
  modes; section 13 sketches the console), [tenancy](../tenancy.md), [demo](../demo.md)
- API gaps: issues [#155](https://github.com/open-agentix/open-agentix/issues/155) to
  [#164](https://github.com/open-agentix/open-agentix/issues/164) (label `ux`)
- Wireframes: [`wireframes/`](wireframes/) (low-fi SVG) and ASCII sketches inline

## 1. Problem

Owner feedback (2026-10-09): in the multi-tenant console it is **not clear which agents belong to
which tenant or team**. The console was built for one tenant; ADR 0013 turns tenants into a tree
with inherited budgets, policies and roles, and the console has no concept of "where am I" yet.

### 1.1 What the console shows today (commit `586e4d5`)

| Screen | Today | Consequence |
| --- | --- | --- |
| Shell (`layout/AppShell.tsx`) | brand, sidebar, user name and role names; **no tenant anywhere**, although `/v1/me` returns `tenant {id, slug, name}` | the user cannot tell in which tenant they act |
| Agents list (`features/agents/AgentsPage.tsx`) | name, description, published version, team, draft updated. Description, team and updated carry `hide-sm`: on a phone only **name and version** remain (owner screenshot of the demo, German UI, 2026-10-09) | no tenant, use case, owner, status, last run or spend; no filter except free text |
| Agents list, team column | resolved with `useTeamNames(can('users:read'))` | a `viewer` (no `users:read`) sees "–" for every team |
| Agent detail, Overview | "Owner team" from the parsed definition; use case only in the `agents.md` source | no tenant path, no "who may edit", no inherited budgets or policies |
| Runs, approvals, events, connections, costs, audit | one tenant, no tenant column; costs can group by `tenant` only for platform admins with `allTenants=true` | no cross-tenant view for tenant admins; no scope indicator |
| Tenant switching | API: `X-OAX-Tenant`, platform admins only; console: **none** | a platform admin cannot see the second demo tenant (`acme-labs`) at all |
| Tenants page | none (ADR 0013 section 13 plans one) | the tree (W13-1, merged) is invisible |
| Single-tenant installs | everything shown (teams, budgets, scopes) | noise for homelab users (ADR 0013 12.2) |

The demo seed makes this visible: `default` holds five agents and `acme-labs` one; the demo user
sees five rows with names and versions and nothing that says "tenant" (the screenshot).

### 1.2 What the API returns today

| Endpoint | Fields relevant here | Missing for this design |
| --- | --- | --- |
| `GET /v1/agents` | `id, name, teamId, description, latestVersion, latestVersionId, draftUpdatedAt, createdAt`; since slice A1 (#155) also `tenant`, `useCase`, `ownerTeam`, `status`, `lastRun`, `monthSpendUsd`, `budget` and the filters `teamId`, `useCase`, `status`, `q` (see "Agent summary API" below) | `sort` (disable and enable: slice A7, see 1.2.2) |
| `GET /v1/me` | `user`, `tenant {id, slug, name}`, `platformAdmin`, `permissions`, `bindings [{role, teamId}]`; since slice A2 (#156) also `actingTenant`, `homeTenant`, `bindings[].tenantId/tenantSlugPath/useCase/expiresAt`, `visibleTenantCount`, `installationMode` | per-node bindings (W13-6) |
| `GET /v1/tenants` | flat list of the caller's reach, with `parentId`, `depth`, `slugPath`; since slice A3 (#157) also `GET /v1/tenants/tree` (visible tree, counts, roles) and `GET /v1/tenants/search` | colour and use case of a node (need W13-2, W13-6) |
| `GET /v1/runs`, approvals, events, costs, audit, budgets | one tenant; `allTenants` for platform admins on costs and audit | `scope=subtree` with a tenant on each row (#158) |
| (none) | | effective governance with source (#159), allowed actions with reasons (#160), locate for deep links (#163), preferences (#164) |

### 1.2.1 Agent summary API (slice A1)

`GET /v1/agents` (and `GET /v1/agents/{id}`, `POST /v1/agents`, `PUT /v1/agents/{id}/draft`) return
these additive, read-only fields. No new permission: they follow `agents:read`, and the two that
touch other data are `null` when the caller may not read that data.

| Field | Meaning | Visibility |
| --- | --- | --- |
| `tenant` | `{ id, slug, slugPath, name }` of the acting tenant; `slugPath` lists the slugs from the organisation root (`acme/security`) | `agents:read` |
| `useCase` | `labels.useCase` of the latest published version; of the draft while the agent was never published | `agents:read` |
| `ownerTeam` | `{ id, slug, name }` or `null` | `agents:read`, same as `GET /v1/teams` (any signed-in user of the tenant) |
| `status` | `draft` (never published), `published` (draft equals latest version), `changed` (draft differs), `disabled` (switched off, wins over the other three; slice A7) | `agents:read` |
| `lastRun` | `{ id, status, createdAt }` of the newest run, or `null` | only runs the caller may read (`runs:read`, team and agent scopes) |
| `monthSpendUsd` | spend of this agent in the current UTC month | `null` without `costs:read` for the agent |
| `budget` | the monthly budget closest to its limit among tenant, use case and team: `{ limitUsd, spentUsd, percentUsed, source, sourceName }`; `spentUsd` is the spend of the whole budget scope | `null` without `costs:read` or when no scope has a limit |

Query parameters: `teamId`, `useCase` (the use case or any sub-use case, matching per `/` segment as
in ADR 0013 section 7.2), `status`, `q` (case-insensitive substring of name, description or use
case; before A1 only the name). Filters combine with AND and are applied **after** the visibility
scope, so a filter can only narrow the result: a team or use case of another tenant, or one the caller
cannot see, yields an empty page, indistinguishable from an unknown value. Paging stays keyset-based
on `(createdAt, id)`, so pages are stable under any filter.

Cost: one query for the page plus a fixed number of batched lookups (tenant and ancestors, teams,
draft/version comparison, last run as one lateral join, spend and budget aggregates); nothing runs per
agent. Migration `0015_agent_summary_fields` adds the denormalised `agents.use_case` column (kept
current on create, draft update before the first publish, and publish) and the indexes
`agents_tenant_created_idx` and `agents_tenant_use_case_idx`; its down script is
`apps/api/drizzle/down/0015_agent_summary_fields.down.sql`. The backfill of never published agents
reads `useCase:` from the draft text with a regular expression, so an exotic YAML layout may leave it
empty until the next draft save. `labels.useCase` is limited to 200 characters (`MAX_USE_CASE_LENGTH`, the same
length `PUT /v1/budgets/use-cases/{useCase}` accepts), because a btree entry above about 2.7 kB is an
error in PostgreSQL; the backfill leaves longer legacy values empty instead of aborting.
The migration runs inside drizzle's migration transaction, so the two indexes are built without
`CONCURRENTLY`: the `ALTER TABLE` lock on `agents` (one row per agent, not per run) is held until
the backfill and both index builds commit, which is short at realistic sizes.

Known gaps:

- (closed by slice A7, section 1.2.2) `status: disabled` is returned and is a filter value.
- `changed` compares the draft with the latest version **byte for byte**. A cosmetic edit (whitespace,
  comments) counts as `changed` although publishing it would be a no-op.
- No `sort` parameter (`lastRun`, `spend`): the list stays ordered by creation time. A sort by last run
  or spend needs a keyset over an aggregate and is left to a follow-up.
- The budget model has no per-agent limit, so `budget.source` is `tenant`, `use_case` or `team`
  (the issue's `agent` source does not exist). Use case budgets match the exact label, like the hard
  stop; sub-use cases do not inherit a parent's budget.
- Scope is the acting tenant only; subtree and "All my tenants" listing is slice A4 (#158).
  `tenant.slugPath` exposes the slugs of the acting tenant's ancestors to its members. ADR 0013
  section 7.4 allows exactly this ("a user sees the names and slugs of the ancestors on the path
  (breadcrumb) only"); no ids, settings or resources of ancestors are returned.
- `budget.spentUsd` is the spend of the whole scope (tenant, use case or team), also for callers whose
  `costs:read` is limited to one team or agent. This matches `GET /v1/budgets` today, which shows the
  same totals to every `costs:read` holder; narrowing both is tracked in #174.

### 1.2.1a Acting tenant and tenant tree (slices A2 and A3)

Implemented in #156 and #157; the contract is `openapi.yaml`, the rules are in
[tenancy](../tenancy.md#acting-in-the-tree). Decisions worth knowing for the console:

- `actingTenant.path` is the breadcrumb, **root first and ending with the acting tenant**; the
  compatibility field `tenant` equals `actingTenant` (it is the tenant the request acts in, not the
  home tenant; use `homeTenant` for that).
- `installationMode` is `multi` exactly when `visibleTenantCount > 1`. A viewer, or an admin of a
  leaf node, gets `single` even in a large installation: there is nothing for them to switch to,
  and the answer reveals nothing about tenants they cannot see.
- Before per-node bindings (W13-6) only the global `admin` role reaches below the home node;
  other roles see the home node only.
- Count fields are `null` when the caller may not read them (the console shows an em dash, not 0);
  `counts` itself is `null` unless `include=counts`.
- Ancestors above the caller's node are `visible: false` path stubs. The tree is capped by `limit`
  (`truncated`); use `root=` and `depth=` to load a large tree level by level.

### 1.2.2 Disable and enable agents (slice A7, #161)

`POST /v1/agents/{id}/disable` and `POST /v1/agents/{id}/enable` switch an agent off and on without
deleting it. Both need `agents:publish` on the agent (team or agent-scoped binding, API token scope
`agents:publish`), take an optional body `{ "reason": "<= 500 characters" }` (control, zero-width and bidi characters
are removed and line breaks folded into spaces before it is stored and audited) and return the agent
detail (`200`). Another tenant's agent, or one the caller cannot read, is `404`; a reader without
`agents:publish` (viewer, operator, auditor, token with `agents:read` only) is `403`.

| Field | Meaning |
| --- | --- |
| `status: disabled` | wins over `draft`, `published` and `changed`; also a value of the `status` filter (the other three filter values only match enabled agents) |
| `disabledAt`, `disabledBy`, `disabledReason` | when, `{ id, displayName }` of the user (resolved inside the acting tenant only, else `null`) and the optional reason; all `null` while the agent is enabled. Visible to every `agents:read` holder, like the members of a team |

Behaviour of a disabled agent:

- **No new runs.** Every trigger passes `RunsService.enqueue`: the manual API run
  (`POST /v1/agents/{id}/runs`, also for a pinned older version), webhook and mail-in ingest, Kafka
  and cron event sources, the cron triggers of the definition and the demo scenarios. A refused
  trigger gets `409 agent_disabled` (HTTP callers), the event is stored all the same, nothing is
  queued, and the refusal is audited as `run.refused` with `reason: agent_disabled`, the trigger as
  actor (`manual:<user>`, `webhook:<source>`, `cron:<schedule>`) and the metric
  `oax_runs_refused_total{trigger,reason}`. Webhook senders get `202` with `runId: null` and the new
  field `reason: "agent_disabled"` (no error to retry on); event sources stay bound and enabled.
  The scheduler drops the cron jobs of the definition and the cron event sources bound to the agent
  on its next reload (within 60 s), so a disabled agent causes no change-gate probe, event or audit
  entry per tick; a tick that still fires is refused and audited (without the probe).
- **Handovers.** A pipeline hands over between steps *inside one run* (`run-nodes`); there is no
  handover that starts another agent, so nothing can bypass the check. If agent-to-agent calls
  arrive later they must start the callee through `enqueue`.
- **Queued runs wait.** Runs that were queued before `disable` returned are not cancelled and not
  claimed: the worker claim skips runs of disabled agents, they start after `enable` (or are
  cancelled by hand). **Running runs finish** (and can be cancelled with `runs:cancel` as usual);
  approvals, steps, cost accounting and the audit of a running run are untouched.
- **Versions stay.** Published versions remain immutable and readable; drafts can still be edited and
  new versions published while disabled (publishing does not enable).
- **Idempotent.** Disabling a disabled agent (or enabling an enabled one) returns `200` with the
  unchanged state: the first actor, time and reason are kept and no second audit entry is written.
- **Audit.** `agent.disabled` (payload `reason`) and `agent.enabled` (payload `reason`,
  `wasDisabledAt`) with the user as actor, written in the same transaction as the change.

No admission race: `enqueue` reads the agent row `FOR SHARE` in the transaction that inserts the run,
and the worker's claim locks it the same way. `disable` updates that row, so it either commits first
(the enqueue/claim then sees `disabled_at` and refuses) or waits until the in-flight enqueue/claim has
committed. A run admitted or claimed before `disable` returned counts as started or queued before the
switch-off; none can start after it returned. This is proven by service-level tests and, on a real
PostgreSQL with several connections, by `apps/worker/test/agent-disable.pg.test.ts` (opt in with
`OAX_TEST_DATABASE_URL`).

Migration `0016_agent_disable` adds `agents.disabled_at`, `disabled_by`, `disabled_reason` (nullable,
reason limited to 500 characters by a check); existing agents stay enabled. Down script:
`apps/api/drizzle/down/0016_agent_disable.down.sql` (disabled agents become enabled when it runs).
Known gaps: no automatic cancellation of queued runs on disable, no per-agent "disable until"
timestamp, no bulk disable, and the W3-6 archive (which implies disabled) is still to come; the
console buttons arrive with a later slice.

### 1.3 Users and jobs

| Who (ADR 0013 roles) | Typical question in the console |
| --- | --- |
| Platform admin | "Which organisation is burning money? Switch into Acme and look at a failed run." |
| Tenant admin (root or department) | "What runs in my subtree, who owns it, which team is near its cap?" |
| Use-case admin | "Show my use case and its attached sub-tenant only; raise a sub-use-case budget." |
| Agent engineer, operator | "My team's agents in *this* tenant; publish, run, approve without picking the wrong tenant." |
| Viewer, guest (demo) | "What is this agent, who owns it, is it healthy?" (read only) |
| Pentest | "Read everything in my bound scope, incl. audit, for a fixed period; never change anything." |

## 2. Principles

1. **Always say where.** Every page shows the acting tenant; every row that can come from more
   than one tenant shows its tenant. No page relies on the user remembering a switch.
2. **One acting tenant, explicit wider views.** Requests act in exactly one node (ADR 0007, ADR
   0013 7.4). Lists may *read* the visible subtree when the user turns that on; writes always
   happen in the row's own tenant and the confirmation says which one.
3. **The URL is the truth.** Acting tenant, filters, group-by and scope live in the URL
   (`?tenant=default/security&scope=subtree&useCase=…`), so tabs are independent, links are
   shareable and reload-safe. `localStorage` only remembers *recent* tenants and saved views.
4. **Explain, do not hide, what the user could do.** Hide what a role can never use (whole areas
   without read permission); disable with a reason what is blocked by scope, state or budget.
5. **Single-tenant stays simple.** In single mode (ADR 0013 12.2) none of the tenant UI below
   renders. Until `installationMode` exists (#156) the rule is "only one visible tenant".
6. **Never leak.** UI never shows names, counts or existence of nodes the user cannot see; empty
   states are written so they do not imply hidden data.

## 3. Terminology (EN and DE)

Technical terms stay English in German (owner rule, UI-I18N-01). Proposed glossary; the
decisions marked "decide" are open owner questions (section 14).

| Concept | EN label | DE label | Note |
| --- | --- | --- | --- |
| Node of the tree | Tenant | Tenant | already used in both locales |
| Root node | Organization | Organisation | ADR uses "organisation"; EN UI uses US spelling (decide) |
| Child node | Sub-tenant | Sub-Tenant | "Add sub-tenant" / "Sub-Tenant anlegen" |
| `labels.useCase` | Use case | Use Case | today DE "Anwendungsfall"; switch to "Use Case" (decide) |
| Group inside a tenant | Team | Team | unchanged |
| Owner of an agent (`owner:`) | Owner team | Owner-Team | today DE "Verantwortliches Team" (decide) |
| Tenant + use case + team of a thing | Scope | Scope | chip label; alternative DE "Bereich" (decide) |
| Current tenant only | This tenant | Nur dieser Tenant | scope toggle |
| Visible subtree | All my tenants | Alle meine Tenants | scope toggle; never "all tenants" |
| Inherited value | Inherited from {tenant} | Geerbt von {tenant} | ADR 0013 section 3 |
| Shadowed own value | Limited by {tenant} | Begrenzt durch {tenant} | ADR 0013 section 3 |
| Roles | Platform admin, Tenant admin, Use-case admin, Agent engineer, Integrator, Operator, Auditor, Viewer, Pentest | Plattform-Admin, Tenant-Admin, Use-Case-Admin, Agent Engineer, Integrator, Operator, Auditor, Viewer, Pentest | role names stay English in DE except the admin compounds |
| Agent status | Draft, Published, Changed, Disabled | Entwurf, Veröffentlicht, Geändert, Deaktiviert | "Changed" = draft differs from the published version |
| Budget use | Budget used | Budgetverbrauch | |
| Switch tenant | Switch tenant | Tenant wechseln | |

i18n keys live under a new `tenancy.*` namespace (`tenancy.tenant`, `tenancy.scope.thisTenant`,
`tenancy.inheritedFrom`, …) so the terms are defined once and reused by every page.

## 4. Information architecture

### 4.1 Where the acting tenant is shown and switched

```text
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ [A] open-agentix │ [EO] Example Org / Security ▾      ⌕ Search (Ctrl K)    ⚑ 1   (AA) │  top bar
├──────────────────┴───────────────────────────────────────────────────────────────────┤
│ Example Org  ›  Security  ›  Agents                                                   │  breadcrumb
│ Agents                                         Scope: [Security ▾] [This tenant|All my]│  page header
```

- **Tenant switcher** (top bar, left after the brand): a button with the tenant's colour tile and
  initials, the slug path shortened from the left ("… / Product / Payments") and a caret. It opens
  a popover (desktop) or a bottom sheet (phone) with: search field (name or slug path), **Recent**
  (last 5, from `localStorage` per user, later #164), **Tree** (visible nodes, 2 levels open by
  default as in ADR 0013 12.2, lazy children), each node with role badge and pending-approval
  count. Keyboard: `Ctrl/Cmd K` then `t`, or `g t`. Wireframe:
  [`wireframes/tenant-switcher.svg`](wireframes/tenant-switcher.svg).
- **Breadcrumb** under the top bar: tenant path (ancestors as text, only the names ADR 0013 7.4
  allows; ancestors the user cannot act in are not links) followed by the page. On phones it
  collapses to "… › Security › Agents".
- **Switching** keeps the page (Agents in A → Agents in B), drops item ids (a run of A does not
  exist in B), moves focus to the page `h1`, announces "Now working in Example Org / Security"
  in a polite live region and shows a short toast with "Undo" (switch back).
- **Implementation:** the acting tenant is a URL search param `tenant` (slug path) on every app
  route; the API client sends it as `X-OAX-Tenant`; TanStack Query keys include it so caches of
  two tenants never mix. Without the param the home tenant applies. The API echoes the tenant it
  used (`X-OAX-Acting-Tenant`, #156); a mismatch shows a blocking error instead of data.
- **Hidden** when only one tenant is visible or in single mode.

### 4.2 The scope chip

Every list and detail page shows a **scope chip** in the header: tenant colour tile + tenant name,
and, when a filter narrows it, use case and team: `[EO Security · vulnerability-management ·
team-security]`. Clicking it opens the filter panel (lists) or the ownership panel (details). On
rows the same chip appears in compact form (tile + last path segment, full path in a tooltip and
in the accessible name).

### 4.3 Navigation

The sidebar keeps its groups (Overview, Build, Operate, Govern). Changes:

- New entry **Tenants** (group Govern, first) for users who can see more than one node or hold
  admin on any node; hidden in single mode.
- "Users & teams" becomes "Users & roles" in multi mode (roles are bound to nodes, teams are one
  kind of binding); the team tab stays.
- The pending-approvals count in the nav counts the current scope (this tenant or all my
  tenants, following the user's last choice), and its tooltip says which.

### 4.4 Tenant colour and label

Each tenant gets a deterministic colour token (hash of id → one of 12 tokens with text contrast
>= 4.5:1 in light and dark theme) unless a tenant admin picks one (`settings.display.color`,
#157). Colour is **never** the only signal: the tile always shows two initials and the name is
always nearby. Platform admins acting outside their home organisation get a thin top border in
the tenant colour plus the label "Acting in Acme Labs" (cross-organisation safety, section 9).

## 5. List pages

Applies to Agents first, then Runs, Approvals, Events, Connections, Costs and Audit. Wireframes:
[`wireframes/agents-desktop.svg`](wireframes/agents-desktop.svg),
[`wireframes/agents-mobile.svg`](wireframes/agents-mobile.svg).

### 5.1 Agents list columns

| Column | Content | Source | Phone |
| --- | --- | --- | --- |
| Name | link + description below in muted text | today | line 1 |
| Status | badge Draft / Published vX.Y.Z / Changed / Disabled | #155, #161 | line 1, right |
| Tenant | compact scope chip; shown when scope is "All my tenants" or the tree has children | #155 | line 2 |
| Use case | text, sub-use cases with `/` | #155 | line 2 |
| Owner team | team name (readable for viewers) | #155 | line 2 |
| Last run | status dot + relative time, links to the run | #155 | line 3 |
| Budget used | small bar + percent of the tightest scope, tooltip "Team budget (Security): 41 of 50 USD" | #155 | line 3 |
| Updated | relative time | today | hidden |

Rows needing attention (last run failed, budget >= 80 %, status Changed for > 7 days) get a
warning icon with text in the status cell, not only colour.

```text
Desktop (scope: All my tenants, grouped by tenant)
┌─────────────────┬────────────┬──────────────────────┬──────────────┬───────────────┬─────────┐
│ Name            │ Status     │ Use case             │ Owner team   │ Last run      │ Budget  │
├─ [EO] Example Org (1) ────────────────────────────────────────────────────────────────────────┤
│ release-watch   │ Published  │ operations           │ Platform     │ ● ok · 2 h    │ ▓░░ 12 %│
├─ [SE] Example Org / Security (3) ─────────────────────────────────────────────────────────────┤
│ cve-triage      │ Published  │ vulnerability-mgmt   │ Security     │ ● ok · 5 min  │ ▓▓▓ 82 %│
│ hardening-review│ Changed    │ governance           │ Security     │ ✕ failed · 1 d│ ▓░░ 20 %│
│ ticket-updater  │ Published  │ vulnerability-mgmt   │ Security     │ ● ok · 3 h    │ ▓▓▓ 82 %│
├─ [PR] Example Org / Product (2) ──────────────────────────────────────────────────────────────┤
│ feature-builder │ Draft      │ software-factory     │ Product      │ –             │ –       │
│ docs-helper     │ Published  │ software-factory     │ Product      │ ● ok · 1 d    │ ▓░░  4 %│
└─────────────────┴────────────┴──────────────────────┴──────────────┴───────────────┴─────────┘
6 agents in 3 tenants                                                   View: [Needs attention ▾]
```

```text
Phone (card rows, nothing important hidden)
┌───────────────────────────────┐
│ ≡ [SE] … / Security ▾    (AA) │
│ Example Org › Security        │
│ Agents              [Filter 2]│
│ [This tenant | All my tenants]│
├───────────────────────────────┤
│ cve-triage        Published   │
│ [SE] Security · vuln-mgmt     │
│ Team Security                 │
│ ● ok 5 min ago   ▓▓▓▓░ 82 %   │
├───────────────────────────────┤
│ hardening-review  Changed  ⚠  │
│ [SE] Security · governance    │
│ ✕ failed 1 d ago ▓░░░░ 20 %   │
└───────────────────────────────┘
```

### 5.2 Filters, group-by and sort

- Filter bar (desktop) / filter sheet (phone, button shows the number of active filters):
  Tenant (tree picker, only in "All my tenants"), Use case (with sub-use cases), Owner team,
  Status, Last run (ok / failed / never), Budget (>= 80 %). Free-text search stays.
- **Group by**: none, Tenant, Use case, Owner team. Group headers show name, count and (tenant)
  the colour tile; they are collapsible and are `rowgroup`s with a heading for screen readers.
- Sort: name, last run, budget used, updated.
- All of it is reflected in the URL; "Clear filters" resets to the page default.

### 5.3 "This tenant" vs "All my tenants"

A segmented control next to the scope chip. "This tenant" = acting node only (default).
"All my tenants" = the visible subtree (`scope=subtree`, #158); it is shown only when the user can
see more than one node, and its label carries the count ("All my tenants (3)"). The choice is
remembered per page in the URL and as the last choice in `localStorage`.

### 5.4 Saved views

Named presets of a page's URL query, stored per user in `localStorage` first and later via
`/v1/me/preferences` (#164). Built-in views per page: Agents: "All", "My teams", "Needs
attention", "Drafts and changes"; Runs: "Failed today", "Waiting for approval"; Costs: "This month
by tenant". A view never stores the acting tenant unless the user ticks "pin to this tenant".

### 5.5 Permission-aware empty states

Empty states never imply hidden data and always offer the next sensible step.

| Situation | Message (EN) | Action |
| --- | --- | --- |
| No agents in this tenant, user can create | "No agents in Security yet." | New agent, Use the wizard |
| No agents here, other visible tenants have some | "No agents in Security. 5 agents in your other tenants." | Show all my tenants |
| No agents, read only | "No agents in Security yet. Ask a tenant admin of Security to add one." | – |
| Filters hide everything | "No agents match these filters." | Clear filters |
| Use-case admin, nothing in the own use case | "No agents in vulnerability-management yet." | New agent (pre-filled use case) |
| Tenant blocked by an ancestor budget | banner (ADR 0013 13) above the list, list still shown | Open Tenants |

## 6. Detail pages: the ownership panel

Agent, run, connection, event source and policy details get an **Ownership** panel (right column
on desktop, first collapsible section on phones). Wireframe:
[`wireframes/agent-ownership.svg`](wireframes/agent-ownership.svg).

```text
┌ Ownership ───────────────────────────────────────────┐
│ Tenant     [SE] Example Org › Security               │
│ Use case   vulnerability-management                  │
│ Owner team Security · 3 members                      │
│ Can edit   Agent engineers of team Security,         │
│            tenant admins of Security and Example Org │
│ You        Viewer — read only                        │
├ Budgets this month ──────────────────────────────────┤
│ Team Security          41 / 50 USD   ▓▓▓▓▓▓▓▓░ 82 %  │ ← tightest, "blocks first"
│ Use case vuln-mgmt     41 / 80 USD   ▓▓▓▓▓░░░░ 51 %  │
│ Security (tenant cap)  63 / 120 USD  ▓▓▓▓▓░░░░ 53 %  │
│ Example Org (cap)     118 / 300 USD  ▓▓▓░░░░░░ 39 %  │  Inherited from Example Org
├ Policies and guidelines ─────────────────────────────┤
│ baseline (policy)          Inherited from Example Org│
│ company (guideline)        Platform                  │
│ secure-coding (guideline)  This agent                │
│ Models  anthropic/*, ollama/*  Limited by Example Org│
└──────────────────────────────────────────────────────┘
```

- Each inherited item says **Inherited from {tenant}** (chip, link if the user can act there);
  shadowed own values say **Limited by {tenant}** (ADR 0013 section 3). Data: #159.
- "Can edit" lists roles and scopes, not people, unless the user has `users:read`.
- "You" states the user's effective role on this item, which explains every disabled control.
- The run detail shows the same tenant/use case/team header and "Charged to" with the budget
  scopes the run counted against.

## 7. Tenants overview page

Route `/tenants`, wireframe [`wireframes/tenants-overview.svg`](wireframes/tenants-overview.svg).

```text
Tenants                                    [Search tenants]  [+ Add sub-tenant]  Month: Oct ▾
┌──────────────────────────────────┬────────┬───────┬────────────┬──────────┬──────────────────┐
│ Tenant                           │ Agents │ Runs  │ Spend      │ Pending  │ Your role        │
│                                  │        │ 30 d  │ / cap      │ approvals│                  │
├──────────────────────────────────┼────────┼───────┼────────────┼──────────┼──────────────────┤
│ ▾ [EO] Example Org               │ 1 (6)  │ 12(58)│ 118 / 300  │ 0 (1)    │ Tenant admin     │
│   ▸ [SE] Security                │ 3      │ 40    │  63 / 120  │ 1        │ Tenant admin ⤓   │
│     [PR] Product                 │ 2      │  6    │  22 / –    │ 0        │ Tenant admin ⤓   │
└──────────────────────────────────┴────────┴───────┴────────────┴──────────┴──────────────────┘
(n) = including sub-tenants   ⤓ = inherited from an ancestor binding   – = no own cap (inherits)
```

- ARIA treegrid; two levels open (ADR 0013 12.2); lazy children; search filters and expands the
  path to matches.
- Counts: own and, in brackets, subtree (#157). Spend shows own cap or "–" (inherits) and a usage
  bar with own, subtree and cap (ADR 0013 13); blocked nodes show a red "Blocked by Example Org"
  badge with text.
- Role badges per node: direct binding vs inherited (⤓ icon + tooltip "From Example Org").
  Use-case-scoped bindings show "Use-case admin · vulnerability-management".
- Row actions (by permission): Open (switch to tenant), Add sub-tenant, Limits, Roles, Move (W13-11),
  Convert team (W13-14). Selecting a row opens a side panel with effective values (#159).
- Use-case admins see only their attached child nodes plus the ancestor path as plain text.

## 8. Role-aware UI

### 8.1 Hidden vs disabled

| Rule | Treatment | Example |
| --- | --- | --- |
| The user lacks the **read** permission for an area in every node they can see | hide the nav entry and its page | `viewer`: no Audit, Users, Tokens |
| The action exists for the user's role elsewhere, but not here (scope) | disable with reason | engineer of team Security looking at a Product agent: "Edit needs Agent engineer in Product" |
| Blocked by state | disable with reason | "Publish: no changes since v1.0.0"; "Run: agent is disabled" |
| Blocked by budget | disable with reason + link | "Run: budget of Example Org is used up for October" |
| Demo read-only | disable with reason | "Read-only demo" (one wording everywhere) |
| Not allowed for the role at all (e.g. `pentest` writes) | hide write controls, show a read-only badge in the header | "Pentest · read only · until 2026-11-08" |

Disabled controls stay focusable (`aria-disabled="true"`, not `disabled`) so keyboard and
screen-reader users can reach the reason (tooltip + `aria-describedby`). Reasons come from the
`actions` block (#160); until it exists the console derives them from `/v1/me` permissions.

### 8.2 What each role sees

| Element | Viewer | Pentest | Operator | Agent engineer | Use-case admin | Tenant admin | Platform admin |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Tenant switcher | own nodes | bound subtree | own nodes | own nodes | attached nodes | subtree | all organisations |
| Tenants page | – (one node) / read | read | read | read | own use case nodes | full | full |
| Agents list | read | read | read | edit own team | edit own use case | edit | edit |
| Agent edit / publish | disabled, reason | hidden + badge | disabled, reason | enabled in scope | enabled in scope | enabled | enabled |
| Run, cancel, approve | disabled, reason | hidden + badge | enabled | run, cancel | enabled in scope | enabled | enabled |
| Audit | hidden | read + verify | hidden | hidden | read in scope | read | read all |
| Users & roles | hidden | read | hidden | hidden | grant in use case | grant in subtree | all |
| Budgets / limits | read | read | read | read | sub-use cases, attached nodes | children's caps | all |

## 9. Cross-tenant safety

1. **Confirmation names the target.** Every write confirmation (publish, run, disable, approve,
   delete, budget change, role grant) states the tenant path as part of the question: "Publish
   cve-triage v1.1.0 in **Example Org › Security**?" The confirm button repeats the verb only.
2. **Writes go to the row's tenant.** In "All my tenants" lists, a row action sends
   `X-OAX-Tenant` of the row, not the acting tenant; the confirmation shows it, and if it differs
   from the acting tenant the dialog says "This acts in Security, not in Example Org."
3. **Type to confirm** for destructive or wide actions (delete tenant, move subtree, cross-org
   move, recursive delete): type the tenant's slug path.
4. **Unsaved drafts block switching**: switching tenant with an unsaved editor asks first.
5. **Cross-organisation**: platform admins acting outside their home organisation get the
   coloured top border and "Acting in Acme Labs" label (4.4), and their first write there per
   session asks for confirmation.
6. **Deep links**: a link to a resource in another visible tenant switches with a notice instead
   of 404 (#163); console URLs carry `?tenant=`.
7. **Mismatch guard**: if `X-OAX-Acting-Tenant` differs from the console's tenant, the page stops
   and shows "Tenant changed in another place; reload" (no silent mixed data).
8. **Forms pre-fill the tenant** (new agent, new connection, new budget) from the acting tenant,
   show it as a read-only field with "Change" (opens the switcher), never as a silent default.

## 10. Mobile layout (<= 600 px)

- Top bar: menu, tenant switcher (tile + last path segment, max 40 % width), avatar; the
  breadcrumb sits as one line below, truncated from the left.
- Lists render as **card rows** (three lines, section 5.1) instead of hiding columns with
  `hide-sm`; a shared `ResponsiveList` component replaces `VirtualTable` rows below 600 px.
- Filters, group-by and saved views open in one bottom sheet; the scope toggle stays visible
  under the title.
- Switcher, filters and ownership open as bottom sheets with a drag handle and a close button;
  focus is trapped; Esc and back gesture close.
- Touch targets >= 44 x 44 px; the page never scrolls horizontally (the owner screenshot shows a
  table at the edge of the viewport).
- Detail pages put the ownership panel first (collapsed to one summary line: "Security · vuln-mgmt
  · Team Security · Viewer").

## 11. Accessibility

- Tree and treegrid follow the WAI-ARIA patterns (`role="tree"`/`treegrid`, `aria-expanded`,
  `aria-level`, arrow keys, Home/End, type-ahead); the switcher search is a combobox with
  `aria-activedescendant`.
- Breadcrumb: `<nav aria-label="Tenant path">` with `aria-current="page"`.
- Chips and tiles carry text (initials + name in the accessible name); colour never carries meaning
  alone; contrast >= 4.5:1 for text, >= 3:1 for bars and focus rings, in light and dark theme.
- Tenant switch: focus to `h1`, polite live-region announcement, document title includes the
  tenant ("Agents · Security · open-agentix").
- Disabled-with-reason controls stay focusable (8.1). Group headers are headings inside
  `rowgroup`s. Reduced motion respected for sheets and tree expansion.
- Tests: axe checks in the UI test suite for each new component; keyboard-only walkthrough of
  switcher, filter sheet and tree in the acceptance criteria.

## 12. Demo data

The demo must show the tree to be convincing. Proposal (issue #162, fictional data on
`example.org` only):

```text
Example Org (demo)               root, cap 300 USD        release-watch (operations)
├── Security                     cap 120 USD              cve-triage, ticket-updater (vulnerability-management)
│                                                         hardening-review (governance)   ← 1 pending approval
└── Product                      no own cap (inherits)    feature-builder (draft), docs-helper (software-factory)
Acme Labs (demo)                 separate organisation    log-summary (operations)
```

Users: `admin@example.org` (tenant admin, root), `security-lead@example.org` (tenant admin,
Security), `vuln-owner@example.org` (use-case admin, vulnerability-management),
`viewer@example.org` (viewer, Product), `pentest@example.org` (pentest on root, expiring).
Deterministic ids so links survive the nightly reset. The sign-in hint lists the roles so visitors
can compare what each sees; the tour step "Agents, tenants and roles" points at the switcher.

## 13. Slice plan

Each slice is one PR a Sonnet agent can implement (console slices: `apps/ui` only, i18n EN+DE,
tests with MSW handlers, no API change unless stated). "Needs" lists API issues; console slices
whose API is missing may ship behind the existing fallback named in the slice.

| # | Slice | Needs | Size |
| --- | --- | --- | --- |
| U1 | Tenancy glossary + shell context | – | S |
| U2 | Responsive card rows for lists | – | M |
| A8 | Demo seed tree (#162) | service-layer child creation (exists) | M |
| A1 | Agent summary fields (#155) | – | M |
| U3 | Agents list v2: columns, filters, group-by | A1 | M |
| A7 | Agent disable/enable (#161) | – | S |
| U4 | Tenant switcher + breadcrumb (platform admins first) | `GET /v1/tenants`, `X-OAX-Tenant` (exist); A2 for others | M |
| A2, A3 | Acting tenant in `/v1/me` (#156), tree endpoint (#157) | W13-6 for non-platform users | M + M |
| U5 | Tenants overview page | A3 | M |
| A4 | `scope=subtree` on lists (#158) | W13-6 | L |
| U6 | "All my tenants" toggle + tenant column + empty states | A4 | M |
| A5 | Effective governance per agent (#159) | W13-2 | M |
| U7 | Ownership panel on agent and run details | A5 (fallback: team, use case, tenant only) | M |
| A6 | Allowed actions with reasons (#160) | – | M |
| U8 | Disabled-with-reason pattern + role badges | A6 (fallback: `/v1/me` permissions) | M |
| U9 | Cross-tenant safety: confirmations, URL tenant, mismatch guard, deep links | U4; A9 (#163) for deep links | M |
| A9 | Locate a resource's tenant for deep links (#163) | W13-6 | S |
| U10 | Saved views (localStorage) | U3 | S |
| U11 | Runs, approvals, events, connections, costs, audit parity | A4, U6 | L (split per page if needed) |
| A10 | Preferences endpoint (#164) | – | S |
| U12 | Accessibility and mobile audit pass, axe in CI | all above | S |

**Recommended order:** U1 → U2 → A8 → A1 → U3 → A7 → U4 → (W13-6) → A2 → A3 → U5 → A4 → U6 →
A6 → U8 → U9 → A9 → (W13-2) → A5 → U7 → U10 → U11 → A10 → U12. U1, U2 and A8 can start in
parallel today and already fix the owner's screenshot (tenant visible, team/use case/status on
phones, a real tree in the demo). Everything that shows other nodes to non-platform users waits
for W13-6 (roles and visibility), because the console must never be ahead of the API's
authorization.

### Acceptance criteria per console slice

**U1 Tenancy glossary + shell context.** `tenancy.*` keys in `en.json` and `de.json` per section
3; acting tenant (from `/v1/me.tenant`) shown in the top bar and sidebar footer as tile + name;
`TenantTile` and `ScopeChip` components with deterministic colour (12 tokens, contrast-tested in
both themes); document title includes the tenant; hidden when one tenant is visible. Tests: render
in EN and DE, contrast unit test of the token table, single-tenant hides.

**U2 Responsive card rows.** `ResponsiveList` renders `VirtualTable` columns as three-line cards
below 600 px using per-column `mobileLine: 1 | 2 | 3 | 'hidden'`; Agents and Runs adopt it; team
name readable without `users:read` (fallback: slug from the definition); no horizontal scroll at
320 px. Tests: viewport 375 px snapshot of agents and runs; a viewer sees team names.

**U3 Agents list v2.** Columns of section 5.1; filters, group-by and sort from 5.2 as URL search
params validated in `router.tsx`; attention marker; group headers as headed rowgroups. Tests:
each filter, group-by tenant/use case/team, URL round-trip, empty states of 5.5 rows 1, 4.

**U4 Tenant switcher + breadcrumb.** Popover/bottom sheet with search, recent (5,
`localStorage` per user id, try/catch), tree (2 levels); `?tenant=` param on every app route;
client sends `X-OAX-Tenant`; query keys include the tenant; focus and live-region behaviour of
4.1; Undo toast. First version for platform admins from `GET /v1/tenants`. Tests: keyboard-only
switch, cache separation (no row of tenant A after switching to B), reload keeps the tenant.

**U4 as implemented (first version, platform admins).** Deviations from the slice text, all
because the API has no tenant tree yet (A2 to A4):

- `GET /v1/tenants` returns `id, slug, name` but no parent or path, and `GET /v1/me` returns the
  acting tenant without `slugPath`. The switcher therefore shows a flat, alphabetical, searchable
  list (plus Recent) instead of the two-level tree, and groups nothing by organisation. The
  breadcrumb learns ancestors only from `tenant.slugPath` of loaded agent summaries and shows the
  tenant name alone before that.
- The acting tenant is **not** a `?tenant=` URL parameter yet (deep links need #163): it is kept per
  browser tab in `sessionStorage` and shown in the shell, so a copied URL never silently carries or
  loses a tenant. Query keys do not include the tenant; instead a switch cancels all requests and
  resets every cached query except the list of switchable tenants.
- There is no Undo toast (the toast component has no action yet); the toast and the polite live
  region announce "Switched to ...".
- The switcher is shown when `GET /v1/tenants` returns two or more tenants. The mismatch guard on
  `X-OAX-Acting-Tenant` (#156) and the unsaved-draft guard belong to U9.

**U5 Tenants overview.** Treegrid per section 7 with counts, cap bars, role badges (direct vs
inherited), search, row actions gated by permission, side panel with effective values when
available. Tests: keyboard tree navigation, use-case admin sees only attached nodes (fixture),
blocked badge text.

**U6 All my tenants.** Segmented control with count; tenant column and group-by tenant appear in
subtree scope; row actions send the row's tenant; permission-aware empty states 5.5. Tests: toggle
URL state, row action targets the row's tenant, empty state with "5 agents in your other tenants".

**U7 Ownership panel.** Section 6 for agents and runs; "Inherited from" / "Limited by" chips;
tightest budget flagged; "You" line. Fallback without #159: tenant, use case, owner team only.
Tests: inherited and shadowed rendering, viewer sees roles not people.

**U8 Disabled with reason.** `ActionButton` that takes an `actions` entry and renders enabled,
`aria-disabled` with reason, or hidden per 8.1; pentest/viewer read-only header badge; demo
reason unified. Tests: each reason code in EN and DE, focusable disabled controls.

**U9 Cross-tenant safety.** `ConfirmDialog` takes a `target` tenant and renders it in the
question; type-to-confirm variant; unsaved-draft guard on switch; cross-organisation border and
first-write confirmation; mismatch guard on `X-OAX-Acting-Tenant`; deep-link switch with notice
(when #163 exists). Tests: every write dialog names the tenant (test walks the dialogs), mismatch
stops rendering.

**U10 Saved views.** Save/rename/delete views per page in `localStorage` (per user id), built-in
views of 5.4, view menu in the filter bar. Tests: storage blocked → views still work for the
session.

**U11 Parity for other lists.** Runs, approvals, events, connections, costs (group by tenant for
tenant admins), audit: scope chip, scope toggle, tenant column, filters by tenant/use case/team.
Tests per page as in U6.

**U12 Accessibility and mobile pass.** axe checks for all new components in the UI test suite;
manual keyboard walkthrough documented in `docs/verification/`; 320 px and 375 px screenshots of
each page; contrast in both themes.

## 14. Owner decisions needed

1. **Labels.** EN "Organization" (US) or "Organisation" (matches the ADR)? DE "Use Case" instead
   of "Anwendungsfall"? DE "Owner-Team" instead of "Verantwortliches Team"? Chip label "Scope" in
   both languages, or DE "Bereich"? Recommendation: Organization / Organisation, Use Case,
   Owner-Team, Scope.
2. **Default scope for tenant admins**: open lists in "This tenant" (safer, recommended) or "All my
   tenants" (more overview)?
3. **Tenant colour**: deterministic only, or let tenant admins pick from 12 tokens (#157,
   recommended: both, pick overrides)?
4. **Demo**: rename the default tenant's display name to "Example Org (demo)" and move five agents
   into sub-tenants (#162). Scenario runs then run in `security`. OK?
5. **Agent status "Disabled"** (#161): ship before the W3-6 archive work, or together with it?
6. **Saved views shared with a team** (#164, later): wanted at all?

## 15. Not in scope

- Implementation of W13-2/W13-4/W13-6 themselves (this document only consumes them).
- Wizard and setup-mode screens (W13-10 covers them; this design only says what single mode
  hides).
- Competitive comparison: `competitive-landscape` notes did not exist when this was written; add a
  section when they do.
