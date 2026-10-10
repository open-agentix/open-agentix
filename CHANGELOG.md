# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Telemetry core hardening (ADR 0015 slice S1)**: a closed attribute allowlist for spans
  (`packages/core/src/telemetry`: key, type, length cap and value set per span kind; every string
  passes the `ContextGuard`; unknown keys are dropped and counted), a single `withSpan` wrapper
  that hands out a guarded span, an export-boundary exporter that re-applies the allowlist to every
  span, the pinned convention version (`GENAI_SEMCONV_PIN`), `OTEL_EXPORTER_OTLP_PROTOCOL`
  (`http/protobuf` default, `http/json`), `OAX_OTEL_HEADERS_SECRET` (exporter headers from a secret
  reference), a bounded export queue and export timeout (`OAX_OTEL_MAX_QUEUE`,
  `OAX_OTEL_EXPORT_TIMEOUT_MS`), the counters `oax_otel_spans_dropped_total`,
  `oax_otel_export_failures_total{reason}`, `oax_otel_attributes_dropped_total{key_class}` and
  `oax_otel_redactions_total{kind}`, `trace_id` and `span_id` in log lines written inside a span,
  parsing and validation of all OpenTelemetry keys of ADR 0015 section 14 (the later-slice keys have
  no effect yet), and `docs/observability.md`.
- **API and core: tenant role bindings table, pure role resolver and shadow check (ADR 0014
  slice S1, #186)**: migration `0018_tenant_role_bindings` (additive, down script and snapshot
  included; ADR 0014 planned 0017, which `0017_approvals_tenant_status_idx` took) adds
  `tenant_role_bindings` (user, node, role, `inherit` default `false`, expiry, grantor; the trigger
  `trb_same_org` keeps a binding inside the user's home organisation and a guard on `users` keeps
  the user there), `tenant_role_restrictions` and `tenants.authz_epoch` (both unused yet). Every
  entry of `users.global_roles` is backfilled as a non-inheriting binding on the home tenant, and
  every write of `global_roles` (user create and patch, first tenant admin, bootstrap admin,
  LDAP/OIDC group mapping) now also writes the bindings in the same transaction. The pure resolver
  `effectiveAt` in `@openagentix/core` (`packages/core/src/tenancy/roles.ts`) turns raw bindings, the
  acting node and the time into `RoleBinding[]` with `permissions`, `useCase` and `source`; the
  checks (`hasPermission`, `visibleTeams`, `visibleAgents`, `effectivePermissions`, approvals) read
  the narrowed `permissions`. The role `pentest` exists (read-only) but cannot be granted before
  slice S6 (`GRANTABLE_ROLES`). **No behaviour change**: the legacy bindings stay authoritative and
  the API only compares them with the resolver in shadow mode
  (`oax_role_bindings_shadow_total{outcome}`, `OAX_ROLE_BINDINGS_SHADOW`, default on). See
  `docs/tenancy.md` and ADR 0014 "Implementation status".
- **API and core: reconcile the role binding mirror and prepare the cache of raw grants (ADR 0014
  slice S1b, #216, #217)**: prerequisites for S2, **no change to what authorises** (the legacy
  bindings still decide). `tenant_role_bindings` is recomputed from `users.global_roles` in both
  directions, one transaction per user with the user row locked first, so rows written by an older
  application version during a rolling deploy or after an application-only rollback are repaired:
  at start-up, every hour (`OAX_ROLE_BINDINGS_RECONCILE_INTERVAL_SECONDS`, `0` = start-up only;
  `OAX_ROLE_BINDINGS_RECONCILE=false` turns it off), for the user of a shadow `mismatch`
  (rate-limited) and on demand with `pnpm --filter @openagentix/api db:reconcile-bindings
  [-- --dry-run]`; counted in `oax_role_bindings_reconcile_fixes_total` and
  `oax_role_bindings_reconcile_runs_total`. Same-key rule (fail closed): removing a role from
  `global_roles` now revokes a binding of the same user, home node and role in any shape; adding
  never hides or overwrites one. Migration `0019_trb_home_move` (additive, down script) applies the
  same-key rule in the database for every writer of `users` (older versions, directory syncs,
  `psql`): a role removed from `global_roles` loses its binding in the same statement, and a home
  change inside the organisation moves the legacy-key rows with the user. `serializeGrants` /
  `reviveGrants` give raw grants a JSON-safe cache form (ISO expiries, strict parsing, invalid is a
  cache miss) and `loadRawGrants` is now one statement, so one principal build holds one
  connection. See `docs/tenancy.md` and ADR 0014 "Implementation status".
- **UI: tenants overview page (UX slice U5)**: a lazy `Tenants` page (`/tenants`, nav entry only in
  `multi` mode, with `visibleTenantCount > 1` or below other tenants) over `GET /v1/tenants/tree`:
  accessible treegrid (arrows, Home/End, `*`, `+`/`-`, Enter switches; roving tabindex), two levels
  open, tenant tile, direct and inherited role badges with text and explanation, compact counts
  (own and subtree), spend with budget bar when a cap is shown, pending approvals badge, `-` plus
  "Not permitted" for counts the caller may not read (never 0), truncated banner, path stubs for
  ancestors, "Switch to this tenant" for platform admins (disabled with a reason for everybody
  else), debounced search in the URL (`?q=`), skeleton, error and empty states, and a card list
  with depth indicators below 600 px. EN/DE under `tenancy.overview.*`.
- **Demo: platform-admin visitor account, sign-in hint with all accounts, scenario tenant**: the
  demo seed adds `owner@example.org` ("Olga Owner", fictional), a platform admin (the same
  `users.platform_admin` mechanism as the seed's bootstrap owner) that sees all four demo tenants and
  the tenant switcher; the other accounts are unchanged. The demo stays read-only for it: the
  read-only hook ignores the principal, the allowlist is exported as `DEMO_ALLOWED_MUTATIONS` and a
  test walks every mutating route as the owner. The sign-in hint box lists every demo account with a
  one-line role description (EN/DE) and fills in the one you click. Scenario runs are created in the
  Security tenant only, whatever tenant the caller acts in; `GET /v1/demo/scenarios` and the `202`
  answer of `POST /v1/demo/scenarios/{id}/run` carry that `tenant`, and the dashboard names it and
  offers a switch (or explains that the account cannot open it). `docs/demo.md` updated.
- **API: acting tenant in `/v1/me`, `X-OAX-Tenant` by slug path and the tenant tree (UX
  slices A2 and A3, #156 and #157)**: `GET /v1/me` adds `actingTenant` (with the breadcrumb `path`),
  `homeTenant`, `bindings[].tenantId/tenantSlugPath/useCase/expiresAt`, `visibleTenantCount` and
  `installationMode` (`single | multi`, derived from what the caller can act in). `X-OAX-Tenant`
  accepts an id, a slug or a slug path; platform admins act everywhere, everybody else (tenant
  admins included) in the own node only until role bindings can inherit down the tree (ADR 0014,
  opt-in per binding); every other node is the same `404`, without a lookup that could time other
  slugs. Every authenticated response carries `X-OAX-Acting-Tenant: <slug path>`.
  `GET /v1/tenants/tree?root=&depth=&include=counts&limit=` returns the visible tree (path stubs
  for ancestors, the caller's roles per node, counts of agents, runs of 30 days, pending
  approvals, spend and cap only where the caller may read them, capped with `truncated`),
  `GET /v1/tenants/search?q=` finds nodes by name or slug, and `GET /v1/tenants` now returns the
  caller's reach with `parentId`, `depth` and `slugPath` (additive). Migration
  `0017_approvals_tenant_status_idx` (additive, down script and snapshot included);
  `openapi.yaml` and the UI client types are regenerated, the console comes with later slices.
  See `docs/tenancy.md`.
- **API: disable and enable agents (UX slice A7, #161)**: `POST /v1/agents/{id}/disable` and
  `/enable` (permission `agents:publish` on the agent, optional `reason` up to 500 characters with
  control, invisible and bidi characters removed, idempotent,
  audited as `agent.disabled` / `agent.enabled`). A disabled agent accepts no new runs: manual API
  runs, webhook and mail-in ingest, event sources, cron triggers and demo scenarios are refused with
  `409 agent_disabled` and a `run.refused` audit entry (the event is still stored; webhook senders
  get `202` with `runId: null` and `reason: "agent_disabled"`), and the worker never claims its
  queued runs; the check runs under a row lock, so no run can start after `disable` returned. Cron
  triggers and cron event sources of a disabled agent are not scheduled (no change probe per tick).
  Running runs finish unless cancelled; published versions stay immutable and visible. Agent
  summaries gain `status: disabled` (also a `status` filter value), `disabledAt`, `disabledBy`
  (`{ id, displayName }`) and `disabledReason`. Migration `0016_agent_disable` (additive, down
  script included); `openapi.yaml` and the UI client types are regenerated, the buttons come with a
  later slice. See `docs/ux/multi-tenant-ux.md` section 1.2.2.
- **UI: tenant switcher, breadcrumb and cross-tenant confirmations (UX slice U4)**: principals
  that may act in more than one tenant (platform admins, as `GET /v1/tenants` reports) get a tenant
  switcher in the top bar (phones, bottom sheet) and the sidebar header (desktop): an accessible
  combobox popover with search by name or slug, the five most recent tenants (per user, in
  `localStorage`), the current tenant marked, and full keyboard use (arrow keys, Home/End, Enter,
  Escape, focus returns to the button, or to the page heading after a switch). The choice is the
  acting tenant of every API call (`X-OAX-Tenant`, also for downloads and event streams), is kept per
  browser tab (`sessionStorage`, never a token in `localStorage`), and a switch cancels in-flight
  requests and drops every cached query, so no data of the previous tenant stays visible; it is
  announced as "Switched to ..." and item pages (agent, run) return to their list. A stale choice
  (the API answers 404 for the tenant) falls back to the home tenant with a message. With one
  tenant the switcher and the breadcrumb are hidden and the static tile stays. A breadcrumb shows
  the tenant path and the page, with an "Acting in ..." label and the tenant colour as a top
  border outside the home tenant. The new `ConfirmTenantAction` wrapper names the target tenant in
  the publish, revoke token, delete connection and cancel run confirmations. No API change; the
  tenant tree (parent, path) arrives with the A2 to A4 slices. EN and DE keys under `tenancy.*`.
- **UI: Agents list v2 (UX slice U3)**: the agents page shows name and version, a status badge
  (Draft, Published, Changed, with an attention marker for a failed last run, a budget of 80 % or
  more, or changes unpublished for over 7 days), the tenant chip, use case, owner team, the last run
  (status and relative time, linking to the run) and the budget use as an accessible progress bar
  with the tightest scope in its label. A filter bar (search, status, owner team, use case) and a
  group-by option (none, use case, owner team; sticky headed groups, card groups on phones) keep
  their state in the URL, so views are deep-linkable and back/forward work. Filters are applied by
  the API (`teamId`, `useCase`, `status`, `q`), paging uses the keyset cursor ("Load more").
  Permission-aware empty states separate "no agents match these filters" from "no agents visible to
  you in this tenant"; loading skeletons replace the spinner; phones keep every field in the card
  rows. The owner team now comes with the agent, so viewers no longer depend on `GET /v1/teams` for
  the team name. Sorting is not part of this slice (the API has no `sort`). EN and DE keys under
  `agents.*` and `tenancy.*`.
- **API: agent summary fields and list filters (UX slice A1, #155)**: `GET /v1/agents`,
  `GET /v1/agents/{id}`, `POST /v1/agents` and `PUT /v1/agents/{id}/draft` return `tenant`
  (`id, slug, slugPath, name`), `useCase`, `ownerTeam` (`id, slug, name`, readable with
  `agents:read`), `status` (`draft`, `published`, `changed`), `lastRun` (`id, status, createdAt`,
  only runs the caller may read), `monthSpendUsd` and `budget` (the monthly tenant, use case or team
  budget closest to its limit; both `null` without `costs:read`). The list accepts the filters
  `teamId`, `useCase` (prefix per `/` segment), `status` and an extended `q` (name, description,
  use case) that narrow within the caller's visibility; paging is unchanged. The fields are
  additive; the `agents.use_case` column and two indexes arrive with migration
  `0015_agent_summary_fields` (down script included). Gaps: no `sort`,
  `changed` is a byte-wise comparison of draft and latest version. See `docs/ux/multi-tenant-ux.md`.
  `labels.useCase` is now limited to 200 characters (the length use case budgets already accept):
  a longer label is a validation error instead of an internal error on the new index; the backfill
  leaves such legacy values empty.
- **Demo seed as a tenant tree with stable ids (A8, #162)**: the demo data set now has the root
  "Example Org (demo)" with the sub-tenants `security` (cve-triage, ticket-updater, hardening-review,
  the three scenarios and the pending approval) and `platform` (feature-builder), plus the separate
  organisation `acme-labs`. Tenants, agents and seeded runs get deterministic UUIDv5 ids, so links
  survive the nightly reset (`TenantsService.create/createChild`, `AgentsService.create`,
  `RunsService.enqueue` and `IngestService.ingestEvent` accept an optional fixed id; behaviour is
  unchanged without it). **Demo behaviour change:** the sign-in users now live in `security`,
  `contractor@` in `platform`. Docs: `docs/demo.md`.
- **UI: tenancy context and mobile card rows (UX slices U1, U2 of `docs/ux/multi-tenant-ux.md`)**:
  new `tenancy.*` i18n namespace (EN and DE) for the tenant glossary; the active tenant from
  `GET /v1/me` is shown as a tile plus name in the top bar (phones) and the sidebar header
  (desktop), and a Scope chip appears under the title of the agents, runs, events, connections,
  costs and audit pages. Tenant tile colours are deterministic (12 tokens, contrast >= 4.5:1 in
  both themes). On phones (<= 600 px) the agents, runs, audit, events and costs lists render
  three-line card rows (name, status, tenant chip, team, last change) instead of hiding columns.
- **Kubernetes Job runner wired into the worker (RM-24)**: `apps/worker` now starts the
  `kubernetes-job` runner when `OAX_RUNNERS_ENABLED` lists it and `OAX_K8S_JOB_ENABLED=true`
  (off by default, no cluster client otherwise), next to or instead of the container runner, with a
  per-runner control URL slot (both runners read `OAX_NODE_CONTROL_URL` for now). Fail closed: the process refuses to start outside a cluster or with an
  incomplete configuration. New settings `OAX_K8S_IMAGE`, `OAX_K8S_TOOLBOX_IMAGES`,
  `OAX_K8S_CONTROL_PLANE_POD_SELECTOR`/`_NAMESPACE_SELECTOR`/`_CIDRS`/`_PORTS`, `OAX_K8S_DNS_EGRESS`,
  `OAX_K8S_AUTOMOUNT_SA_TOKEN`, `OAX_K8S_DEFAULT_DENY_POLICY`; an enabled runner now requires an
  `https://` `OAX_NODE_CONTROL_URL`, a digest-pinned `OAX_K8S_IMAGE` and a control plane selector or CIDR
  (**behaviour change** for configurations that enabled the runner before it was wired). The kind
  end-to-end test stays opt-in. Docs: `docs/kubernetes-job-runner.md`, `docs/runners.md`.
  `OAX_K8S_CONTROL_PLANE_PORTS` must list at least one port (an empty list would have rendered
  `ports: []`, which a NetworkPolicy reads as every port). `OAX_K8S_CONTROL_PLANE_CIDRS` are
  checked at start-up: no broader than `/24` (IPv4) or `/64` (IPv6), never inside an always-denied
  range, and always-denied ranges plus `OAX_K8S_DENY_CIDRS` inside them are excluded.
- **Seed endpoint, pull-request delivery and bug-fix agent (DOG-3c/DOG-4, ADR 0008 Amendment 5, ADR
  0010 Amendment 3)**: `GET /v1/worker/runs/{id}/workspace` (step-scoped, once per session, SHA-256
  header, digests-only audit `workspace.prepared`/`workspace.fetched`, migration 0014); run node
  unpacks the seed with its own checks (`apps/worker/src/seed-unpack.ts`), writes the workspace
  server configuration and attaches the node-computed patch to the step result; `PullRequestDelivery`
  turns it into a pushed `oax/bug-fix/*` branch and a draft pull request from operator targets
  (`OAX_PR_TARGETS`, `OAX_PR_DRY_RUN`), with open-PR limit before the node starts, test-green
  requirement (consistent full-suite claims), fail-closed secret scan with the exact tokens in use
  before the push, neutralized mentions/issue references/closing keywords in the pull request text
  and `pull_request.*` audit entries; example
  agent `examples/agents/bug-fix-agent.md` and `docs/bug-fix-agent.md`.
- **Git delivery in the worker (DOG-3a/3b, ADR 0010 Amendment 2)**: `apps/worker/src/git/` with a
  hardened minimal Git engine over https (child process with allowlisted environment, forced `-c`
  options, one-target loopback relay that dials through the outbound dispatcher, shallow fetch of
  one commit, tree snapshot and deterministic seed archive without checkout), worker-side patch
  re-validation, `git apply --check`/`--cached` in a temporary index, commit with the platform
  identity and create-only branch push; a credential scan of patch, message and pull request text
  that blocks delivery; and a minimal `GitHubExtension` that can only count open pull requests
  under a branch prefix and open a **draft** pull request on the one configured repository (limit
  of open pull requests, base and head rules, body cap, no merge, review, label or workflow call;
  a test greps the sources). Audit entries `git.clone`, `git.apply`, `git.push`, `git.refused`,
  `git.pr_open` with digests only. New `OutboundDispatcher.dial()` (raw pinned stream or `CONNECT`
  through the selected proxy) for such relays. Consuming `pull-request` outputs (DOG-3c) and the
  seed endpoint (DOG-4) are separate tasks.
- **Workspace tools for harness steps (DOG-2, ADR 0008 Amendment 2)**: new package
  `@openagentix/workspace` with the MCP server `workspace` (`list_files`, `read_file`, `search`,
  `diff`, `edit_file`, `write_file`, `run_tests`; stdio binary `oax-workspace`). Path-confined without
  following symbolic links, forbidden `.git`/`.github`/CI/secret-like paths, size, output, call and
  time limits, a fixed test command without shell and with a scrubbed environment, process-group
  kill and a memory watchdog. The node computes the final patch itself
  (`{ patch, patchSha256, changedFiles, lastTestRun, fullSuitePassed, treeMatchesLastRun,
testedFinalTree }`, refused as a whole for
  changes outside `src/` and `test/`, links, mode changes, binary files); `workspaceToolGrants()`
  gives the matching gate grants. Docs: `docs/workspace-tools.md`. Seed endpoint, image and output
  delivery are separate tasks (DOG-1, DOG-3c).
  Review hardening: after every test run all processes it started (group, descendants, orphans of
  the same UID from `detached`/`setsid`/double fork) are killed and verified, the call returns at
  the latest after the timeout plus a grace period even if a child holds the pipes, and the
  memory watchdog counts all of them; `testedFinalTree` requires a passing **full-suite** run on
  exactly the final tree (single test files no longer count); extended deny list (`.envrc`,
  `.pgpass`, `*.tfvars`, `*.tfstate`, `.vault-token`, `.dev.vars`, `*.gpg`, `service-account*.json`,
  `id_*`, `.npmrc*`, ...); files with several hard links are refused; directories count toward the
  tree limit; tree walk and diff have a time cap (`maxFinalizeMs`, code `timeout`); refused
  paths and arguments count as denied; patch headers carry the real file mode; absolute paths are
  removed from test output; the result file is written with `O_NOFOLLOW`; startup warning when
  `kernel.yama.ptrace_scope` is 0. Documented trust boundary: test code runs as the node's UID
  (ADR 0008 Amendment 3).
- **Run-node image with Claude Code and harness runtime settings (DOG-1)**: Dockerfile target
  `run-node-claude-code` with the Claude Code binary pinned to 2.1.295 and verified against the
  registry SHA-512 at build time (no runtime download, no package manager, non-root, read-only root
  compatible), `scripts/build-harness-image.sh` (build, push, digest). New settings
  `OAX_CONTAINER_HARNESS_IMAGES` (harness -> digest-pinned image, `harness_image_unknown` fails
  closed), `OAX_CONTAINER_TMP_MB`, `OAX_CONTAINER_HARNESS_MEMORY_MB` (2048) and
  `OAX_CONTAINER_HARNESS_TMP_MB` (256), and `OAX_HARNESS_EGRESS_ALLOWED` (default off): a harness step
  must publish with `runtime.egress: []` and the container runner refuses declared hosts at start
  ("control node only" is enforced, not assumed). Verified in a hardened container on an internal
  network; ADR 0008 amendment 4 and ADR 0009 amendment DOG-1. DOG-1b (subscription token) is not
  built by owner decision. Review fixes: the image has no `org.opencontainers.image.source` label
  (a linked GHCR package would follow the public repository) and `scripts/build-harness-image.sh`
  refuses to push unless the package is private (verified with `gh api` before and after the push);
  `scripts/test-harness-image.sh` is an automated image smoke test (pinned version, no managed
  settings, no package manager, no setuid/setgid files, uid 10001, minimal writable paths, `noexec`
  `/tmp`, fake egress proxy answering 407, no DNS and no route out) that runs in CI and before every
  push; the base image is pinned by digest at build time and an unavailable pinned `git` version
  prints the versions to use; new `OAX_CONTAINER_MEMORY_MB` (512) separates the memory of ordinary
  nodes from the ceiling `OAX_CONTAINER_MAX_MEMORY_MB`; `/tmp` must be at most half of the node memory
  (also checked by the runner schema) and integer settings have an upper bound; publish refuses a
  harness step with a toolbox and an ordinary step on a harness image, and the runner refuses an
  ordinary step on a harness image unless it is also the default or a toolbox image; documented
  Docker >= 26 / Podman DNS caveats, the exfiltration risk of `OAX_HARNESS_EGRESS_ALLOWED` and the
  trust anchor of the SHA-512 pin.
- **Tenant tree data model (W13-1 first slice, ADR 0013)**: migration `0013_tenant_hierarchy.sql`
  (PostgreSQL and PGlite) adds `parent_id`, `root_id`, a materialized `path` with prefix index and
  `depth` (technical maximum 32) to `tenants`; slugs stay globally unique (`tenants_slug_unique` is kept, the
  slug is the secret namespace until W13-7) with an additional sibling index, every existing tenant becomes a root and nothing is nested automatically. A guard
  trigger refuses inconsistent placements and cycles and freezes the placement until moves exist; a
  down script is documented. New `placeNode` and path helpers in `@openagentix/core`, a `TenantTree`
  repository (ancestors, descendants, subtree by one index lookup, slug paths) and
  `TenantsService.createChild` with `OAX_TENANT_MAX_DEPTH` (default 32) and
  `OAX_TENANT_MAX_NODES_PER_ROOT` (default 1000). No API change and no behaviour change for flat
  installs; sub-tenants are not creatable over HTTP yet. Tenant creation (slug check, node limit,
  insert, audit entry) runs in one transaction under advisory locks, so parallel creations cannot
  duplicate a slug or exceed the node limit. The down script runs in a transaction; data-only
  restores need `pg_restore --disable-triggers` (see `docs/tenancy.md`). CI runs the PostgreSQL
  tests against a service container and checks that schema, snapshots and migrations are in sync.
  ADR 0013 is accepted.
- **Code quality reviewer example agent (NEW-51)**: `examples/agents/code-quality-reviewer.md`
  reviews a PR diff or repository path against the code quality guidelines (rule catalogue `QG-*` with
  severities, structured findings with `file:line`, Definition of done) and drafts a PR comment;
  read-only tools, one approved comment at most, no merge, 0.20 USD run budget. Guide with showcase
  setup (S-13) and golden-PR evaluation in `docs/examples-quality-agent.md`; a test validates every
  file in `examples/agents/`.
- **Outbound dispatcher factory with DNS pinning (W10-1-2 first slice, ADR 0011 amendment 3)**:
  `createOutboundDispatcher` in `@openagentix/providers` asks `resolveRoute` for every request and builds
  the undici dispatcher: direct with a pinned DNS lookup, or through the selected HTTP(S) proxy
  (CONNECT, `Proxy-Authorization` from the secret reference, proxy CA bundle); trust bundles
  (`system+extra` / `extra-only`) and client certificates come from the network configuration.
  Deny and veto results are `egress_denied` (with the resolver code), redirects are never followed,
  connect/header/body timeouts and a response size limit always apply, and every decision is exposed
  to `onRoute` without secrets. `createGuardedFetch` (OpenAI-compatible, Ollama, Anthropic, stream
  transports) and the Bedrock client now use the factory; providers, the registry and the stream
  factory accept an optional `outbound` (dispatcher, purpose, scope). A boundary test and ESLint
  rules fail when a new direct `fetch(`, `undici` or `node:http(s)` client appears outside the
  factory (exceptions are listed). New `RouteScope.allowPlainHttp` (platform only) keeps in-cluster
  `http://` model servers working until they are described by the network configuration.
- **Outbound network configuration and route resolver (W10-1-1, ADR 0011)**:
  `OAX_NETWORK_CONFIG_FILE` (YAML/JSON) or `OAX_NETWORK_CONFIG` (inline JSON) defines named proxies,
  trust bundles, client certificates, ordered routes and the proxies tenants may select. The pure
  `resolveRoute(url, purpose, scope, net)` in `@openagentix/core` decides direct, proxy or deny
  (precedence: connection selection, legacy `proxyUrl`, routes, `HTTP(S)_PROXY`/`NO_PROXY`, direct)
  and never touches the network. The api validates the file at start-up (including the air-gapped
  allowlist for proxy hosts and routes). The configuration is file/Helm only; there is no write API.
  Dispatchers and client migration follow in W10-1-2 and later.
- **Harness adapters through the model proxy (W1-3b-7, PLAT-04)**: `agents[].runtime.harness:
claude-code | opencode` runs a step in a run node with the harness as executor. The harness reaches
  its model only through `/v1/model-proxy/anthropic|openai` with the step's model token and never
  holds a provider key or OAuth token. `POST /v1/worker/runs/{id}/model-token` accepts `harness` and
  answers with the pass-through surface. New `OAX_HARNESSES_ENABLED` (default empty, requires the model
  proxy). Cost is measured by the proxy; the harness report is stored in the `output` step. Publish
  checks: isolating runner, no `simulation`, enabled harness. Hardening: `assertProxyInvocation`
  guard, default 30-minute time limit, process-group kill. See ADR 0009 amendment W1-3b-7.
- Run node environment variables `OAX_CLAUDE_BIN`, `OAX_OPENCODE_BIN`, `OAX_OPENCODE_SHA256`
  (the images with pinned binaries are PLAT-05).

### Security

- **Telemetry no longer exports error messages or stacks.** `withSpan` used to record the raw
  exception (message and stack) and the message as the span status, so provider response bodies,
  tool output and secrets inside an error could reach the collector. A failed span now carries the
  error code (`error.type` and status description, or `_OTHER`) and one `exception` event with the
  class name only; `OAX_OTEL_EXCEPTION_DETAIL=guarded` opts in to a guarded, 256-character message
  (the stack is never recorded). The exporter uses no resource detectors (no metadata-endpoint
  calls) and only static resource attributes.
- **Demo: unlisted seed accounts no longer share the published password**: `demo-owner@example.org`
  (platform admin) and `admin@acme.example.org` (Acme Labs admin) only build the data set; they get
  a random password per seed, so the shared demo password opens only the accounts on the sign-in
  page.
- **Demo: scenario limits hold under concurrent requests**: `POST /v1/demo/scenarios/{id}/run`
  checked its limits before inserting the run, so a burst of parallel requests passed all of them
  (per-visitor window, daily cap, one live run and the daily budget in `claude-code` mode). Starts
  are now checked and queued one at a time (per API process; the demo runs one replica).
- **Demo: failed sign-ins no longer store what a visitor typed**: in demo mode a failed sign-in for
  a name that is no account is audited as `(unknown account)` instead of the typed name, because
  the published platform-admin accounts read the audit log of every tenant (a visitor's real
  address typed by mistake was visible to every other visitor). Outside demo mode nothing changes.
- **Invisible-Unicode filter for model input** (ADR 0008 Amendment 6): zero-width, bidi, tag-block,
  variation-selector runs, control and other invisible format characters are removed from prompts,
  tool results, tool error messages and tool descriptions/schemas before they enter the model
  context or a stored step output. Choke points: `ToolGateway.call`, `ToolGateway.exposedTools` and
  the executors. ZWJ/ZWNJ are kept only between non-ASCII letters or emoji. Audited as an `input_guard` control step with
  counts and class names only (a run node may report exactly that step). On by default;
  `OAX_STRIP_INVISIBLE_UNICODE=false` switches it off for diagnostics. Docs:
  `docs/security-input-hardening.md`.
- **Secret redaction for model input** (ADR 0008 Amendment 6): known secret values (resolved secret
  references, brokered credentials, run, gate and model tokens; also inside larger base64 blobs) and
  common token shapes are replaced
  by `[redacted:<kind>]` in prompts and in every tool result before it enters the model context or a
  stored step output; the counts are part of the `input_guard` audit entry. On by default;
  `OAX_REDACT_MODEL_CONTEXT=false` switches it off for diagnostics. The token patterns moved from
  `apps/worker` to `@openagentix/core` (`SECRET_PATTERNS`); `scanForSecrets` is unchanged.
- Network configuration refuses plain `http://` proxies in production (`proxy_plain_http`), proxy
  URLs with credentials (use `authSecret` references), any key that would disable TLS verification
  and `NODE_TLS_REJECT_UNAUTHORIZED=0` (`tls_insecure`). Cloud metadata addresses and names are
  never routable, tenant destinations must be public, loopback never goes through a proxy, and
  proxies that inspect TLS cap the data classification.
- Hardening of the route resolver (security review): `OAX_NETWORK_PRIVATE_ALLOW` follows the same
  rules as the file and can no longer open loopback or the internet; `ldap(s)` hosts are
  canonicalised (`0xa9fea9fe`, `2852039166`, octal spellings) so the metadata and tenant checks
  apply; tenants may select only `tenantSelectableCertificates` and never override a route's client
  certificate; tenant `proxyUrl` hosts must be public (metadata and loopback refused, also
  grandfathered); `deny` routes veto regardless of order; LDAP is never sent through an HTTP proxy;
  plain `ldap://` is refused for `identity` and `mcp` is TLS-only for tenant destinations; 6to4,
  Teredo, site-local and local-use NAT64 addresses, `169.254.170.23` and `192.0.0.192` are
  classified; the config file is read from a regular file only, bounded through one descriptor;
  network configuration warnings are logged at start-up; the digest covers the environment proxies.
- **Harness review fixes (W1-3b-7)**: OpenCode substitutes `{env:...}` / `{file:...}` in the raw
  text of its config, so author strings could pull the model token or the run token file into the
  prompt. Such sequences are now refused in `provider`, `model` and the instructions of a harness
  step at validation, and escaped (`\u007b`) in every string written to the generated
  `opencode.json` (proxy and BYOK variants). The run token file is removed once read (best effort).
  Tokens are redacted in the recorded `call.args` of gate calls and in harness errors; stderr is
  redacted before it is truncated; a malformed model token response no longer surfaces a ZodError.
  The harness environment is an allowlist behind the proxy (loader, certificate and OpenCode/Claude
  config variables are refused for every harness), `ANTHROPIC_BASE_URL` must equal the proxy URL and
  the check runs on the environment actually passed to `spawn`. A harness run no longer hangs on a
  grandchild that keeps stdout open (`exit` is handled, the process group is always signalled).
  Model tokens carry a `surface` claim (`native` | `harness`) plus the harness kind: the native
  `/model` route refuses a harness token and the pass-through surfaces refuse a native one.

- Hardening of the dispatcher factory (security review of PR #133): a legacy `proxyUrl` of a platform
  connection is no longer pinned (a private proxy host works again); only tenant-chosen proxies are.
  Node agents (Bedrock) behind a proxy use a dedicated CONNECT agent: the proxy hop gets its own CA
  and never the client certificate, the destination gets the trust bundles and the client
  certificate, also in `extra-only` mode. `rejectUnauthorized: true` is set on every TLS option set
  and the factory refuses to run with `NODE_TLS_REJECT_UNAUTHORIZED=0`. `proxyUrlGrandfathered`
  comes from the connection metadata only, never from "a proxyUrl is set". Policy and configuration
  errors (`egress_denied`, `network_secret_unavailable`, `client_certificate_unknown`,
  `network_config_invalid`, `tls_insecure`), also behind undici's `fetch failed`, are never retried
  or wrapped into a retryable provider error. Tenant destinations behind a proxy are resolved once
  and checked before sending. The dispatcher cache is bounded (LRU, 64) and keyed by a digest of
  proxy credentials; invalid percent-encoding in proxy credentials fails with
  `network_config_invalid`; the size limit has its own code `response_too_large`; plain `http://`
  Bedrock endpoints now also go through the proxy.

### Changed

- **Telemetry**: the worker's `oax.run` span carries `oax.run.id` (was `oax.run_id`) and
  `oax.tenant.id`. The default OTLP protocol is now `http/protobuf` (was JSON); set
  `OTEL_EXPORTER_OTLP_PROTOCOL=http/json` to keep the old wire format. **Breaking:**
  `OTEL_EXPORTER_OTLP_ENDPOINT` with `http://` to a non-loopback host (for example an in-cluster
  collector such as `http://otel-collector.observability.svc:4318`, as in the Helm EKS example) now
  fails start-up unless `OAX_OTEL_INSECURE=true` is set (Helm: add it to `config.extraEnv`
  until the chart has its own value), and an endpoint with credentials, a query or
  a fragment is refused. **Breaking** as well for installs that relied on the
  standard `OTEL_EXPORTER_OTLP_HEADERS`, `_CERTIFICATE`, `_CLIENT_CERTIFICATE` or `_CLIENT_KEY`
  variables (also the `_TRACES_` variants), `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`,
  `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL`, `OTEL_TRACES_SAMPLER` or `OTEL_TRACES_SAMPLER_ARG`: start-up
  now fails with a message naming the replacement (`OAX_OTEL_HEADERS_SECRET`, the network
  configuration, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OAX_OTEL_SAMPLE_RATIO`). `OTEL_SDK_DISABLED=true`
  or an `OTEL_TRACES_EXPORTER` other than `otlp` next to an endpoint fails start-up as well (they
  are not read; unset the endpoint to turn the export off). A process in which another
  OpenTelemetry SDK is already registered (auto-instrumentation through `NODE_OPTIONS` or an
  operator injection) now fails start-up.
- **UI**: German glossary follows the multi-tenant UX design: "Use Case" (was "Anwendungsfall") and
  "Owner-Team" (was "Verantwortliches Team"). The browser tab title now reads
  `Page · Tenant · open-agentix`.
- Outbound routing of existing installs (dispatcher factory): loopback destinations are always
  direct (never sent to `HTTP(S)_PROXY`), cloud metadata addresses are denied, and an invalid
  `HTTPS_PROXY`/`HTTP_PROXY` value now fails with `network_config_invalid` instead of being ignored.
- Clients without their own network configuration share one factory per proxy environment.
- The response size limit error code is `response_too_large` (was `egress_denied`).
- UI wording: token counts read "Input / Output" in both languages (German no longer "rein / raus"),
  the "Operate" navigation group is now "Operations" (German "Betrieb", was "Betreiben"), and the
  German translation keeps technical terms (Run, Policy, Tenant, Tool, Secret, Input, Output) and
  uses the informal "du" form throughout.

### Breaking

- **Network start-up checks (W10-1-1)**: the api now aborts start-up (`tls_insecure`) when
  `NODE_TLS_REJECT_UNAUTHORIZED=0` is set, air-gapped or not; add the CA to a trust bundle or
  `NODE_EXTRA_CA_CERTS` instead. `HTTPS_PROXY`/`HTTP_PROXY` values that are not an `http://` or
  `https://` URL abort start-up (`network_config_invalid`); a bare `host:port` is still accepted
  (read as `http://host:port`, with a warning), `socks5://` and other schemes are refused.
  `OAX_NETWORK_PRIVATE_ALLOW` and `privateAllow` now accept only IPs and CIDR ranges with a prefix
  of at least /8 that do not cover loopback, link-local, unspecified or multicast space; the
  allowlist grammar rejects `/0`, empty and non-numeric prefixes (`10.0.0.0/`); the deny code of a
  `deny` route is `egress_denied` (was `denied_by_route`).
- **Model proxy cutover (W1-3b-4)**: isolated run node steps now call models only through the
  model proxy. With `OAX_MODEL_PROXY_ENABLED=false` (the default) they fail with
  `model_proxy_unavailable`, the simulated provider included. Old `oax run-node` images report
  `model_call` steps themselves and now get `400 step_kind_refused`: roll out control node and node
  images together. As soon as any cost limit applies (run, step, team or monthly), a model without
  a price is rejected with `422 model_unpriced`.

### Security

- Price lookups resolve the fallback keys (catalog provider, adapter kind) against the platform
  table only; a tenant connection named like a catalog provider can no longer zero the price of
  another connection. Tenant overrides apply only under the connection name the agent uses.
- In-process reservations are settled only by the in-process call of the same agent; reservations
  of a proxied session are refused.

### Fixed

- **Secret scan: linear JWT pattern.** The JWT token shape restarted at every `eyJ` inside a run
  of base64url characters (128 KiB of `eyJ-` took about 9 s); it is shared by the pull-request
  secret scan and the model-context guard and is now linear.
- **UI**: a run or agent link that no longer resolves shows a friendly page instead of the raw
  "not found" error. In the demo build it says the demo is reset daily and links back to the list
  (UI-NF-01).
- **UI**: the owner team name on the agents list (and agent detail, runs, costs) is readable
  without `users:read`: `GET /v1/teams` only needs a signed-in user, the console asked for the
  permission needlessly. Without a name it falls back to "Team <id>" instead of "–".
- In-process model errors release their reservation only for failures that provably did no work
  (egress refusal, DNS or refused connection, 4xx other than 408, 409 and 429); everything else
  expires at the reserved amount like the proxy does.
- The in-process provider call is bounded by the reservation deadline, and a late report for an
  already expired reservation is recorded as a `model.late_settlement` correction in the audit log
  instead of failing the run.
- A price lookup that fails during reservation or settlement is logged as a warning.

### Added

- **Model proxy pass-through surfaces (W1-3b-6)**: `POST /v1/model-proxy/anthropic/v1/messages`,
  `POST /v1/model-proxy/openai/v1/chat/completions` and the two `GET .../v1/models` routes speak the
  Anthropic and OpenAI protocols for harnesses, with JSON and Server-Sent Events. They open with the
  model token only (`x-api-key` or `Authorization: Bearer`), run through the same admission,
  reservation, settlement, cap, SSRF-pinning and revocation chain as the native route, and stop a
  stream mid-way (output over the reserved bound, revoked session, cancelled run, deadline, client
  disconnect) with the protocol's own error event. Requests are parsed with a strict allowlist and
  the upstream body is rebuilt; every relayed event is rebuilt from allowlisted fields; client
  credentials and headers are never forwarded (new `OAX_MODEL_PROXY_ANTHROPIC_BETAS` allowlist for
  `anthropic-beta`). `count_tokens` and `GET models/{id}` are not served yet. Requests with
  `cache_control` are reserved at the cache-write rate and `ttl: "1h"` is refused; client-visible
  events carry the step's model, an own id and capped usage; oversized upstream strings end the
  stream with an error instead of being blanked; a thinking budget under 1024 after the output
  clamp is omitted; the token is checked before the body is validated.
- **Run node and executor on the model proxy (W1-3b-4)**: `oax run-node` sends every model call of
  its step through the control node's model proxy (`ModelProxyProvider`, a metered provider, the
  simulated provider included; `ModelProxyUnavailableProvider` is gone), the executor records no
  cost or `model_call` step for metered providers, and refusals of the proxy keep their code in the
  run's failure. In-process steps now reserve their worst case before each call
  (`ControlPlane.reserveModelCall`, new `POST /v1/worker/runs/{id}/model-reservations` for
  orchestrator tokens) and the control node settles the reservation from the usage (`reservationId`
  on the `model_call` step), so run, step and monthly budgets hold across concurrent calls. The
  dispatcher takes the cost and tokens of an isolated step from the run's ledger counters, so
  isolated steps count against `maxCostUsd`, `maxTokens` and the monthly budgets. Reservation and
  settlement use the run's prices including BYOK connection overrides and the connection's catalog
  provider. ADR 0009 amendment W1-3b-4.

- **Model proxy: native endpoint and model token (W1-3b-3, opt-in `OAX_MODEL_PROXY_ENABLED`)**: the
  control node serves `POST /v1/worker/runs/{id}/model-token` (a step-scoped, session-bound,
  once-per-step model token `oaxmt.`, stored as `run_node_sessions.model_token_jti`) and
  `POST /v1/worker/runs/{id}/model` (JSON, or Server-Sent Events with `Accept: text/event-stream`)
  with the pre-call chain of ADR 0009: token and session binding, model allowlist of the published
  step (provider and model cannot be chosen by the caller), data classification, air-gapped egress,
  BYOK key resolution on the control node (the key never leaves it and is scrubbed from provider
  errors), strict re-serialised request validation (no server tools, `mcp_servers`, URL sources,
  file ids, duplicate or prototype keys), a worst-case budget reservation, and settlement from the
  usage the control node measured. Streaming goes through the upstream transports of W1-3b-5 with a
  hard stop on revoked sessions, cancelled runs, deadlines, client disconnects and output beyond the
  reservation (bound + 10 %). Stable error codes, `model_token.issued` / `model.denied` /
  `model.aborted` audit entries, `oax_model_proxy_*` metrics and the `OAX_MODEL_PROXY_*`
  configuration block (limits are bound to the accounting service and the stream transports).
  New route access kind `model-token`. `ModelAccountingService.settle` now scrubs step payloads
  before it opens its transaction. Not yet wired to the run node (W1-3b-4); the Anthropic and OpenAI
  pass-through surfaces follow (W1-3b-6). Provider calls of the proxy never retry (a retry would be a
  second billed call), the HTTP timeout follows the call deadline, everything that may have been
  billed is charged, JSON answers use the stream limits, reported usage is capped by the
  reservation, and tenant-controlled endpoints cannot reach private or metadata addresses
  (`OAX_MODEL_PROXY_PRIVATE_ALLOW`); this also covers NAT64, 6to4 and IPv4-compatible forms, refuses
  names that cannot be resolved, validates and pins the address at connect time (also for custom
  Bedrock endpoints, whose responses are size-bounded), refuses calls of a run or step whose time is
  exhausted and caps estimate-mode usage at the input upper bound. `docs/runners.md`, `docs/configuration.md`.
- **Streaming upstream transports for the model proxy (W1-3b-5)**: `@openagentix/providers` gets a
  streaming API next to `complete`: `AnthropicStreamTransport`, `BedrockStreamTransport`
  (`InvokeModelWithResponseStream`) and `OpenAIStreamTransport` (OpenAI, Azure, OpenRouter, vLLM,
  LM Studio, Ollama `/v1`, compatible; forces `include_usage`). Robust SSE parser (partial frames,
  split UTF-8, line/event/total size limits), pull-based events with backpressure, abort via
  `AbortSignal` that closes the upstream socket, a `shouldStop` hook for the mid-stream hard stop,
  time-to-first-event, between-event idle and deadline timeouts, retries only before the first byte,
  and a usage meter (provider usage incl. cache tokens, estimate and floor, `usageReported` flag for
  the estimator fallback). No bodies in logs, secrets scrubbed from errors. Not yet wired to a route
  (W1-3b-6). `docs/providers.md`.
- **Run node, per-step credential broker and container runner (W1-3a, opt-in)**: steps whose effective
  runner is `container` (pipeline `runtime.runner` or per-step `runtime.runner`) run in their own
  short-lived container, started by the worker through a socket proxy or rootless Podman: digest-pinned
  image, numeric non-root user, read-only root filesystem, all capabilities dropped,
  `no-new-privileges`, CPU/memory/PID limits, tmpfs, an `internal` network (verified before every
  start), no engine socket inside, never started through the raw Docker socket unless explicitly
  allowed. The step-scoped run token (claims `sid`, `steps`) reaches the node through its stdin, never
  through the environment. The new run node (`apps/worker/src/run-node.ts`, entry `run-node-cli.js`, image target
  `run-node`) talks to the control node only and never to PostgreSQL. The credential broker
  (`POST /v1/worker/runs/{id}/credentials`) hands out exactly the step's secrets once per step and
  session, only for references the tenant allows (`tenants.secret_refs`, empty = nothing, migration
  `0009`; `PATCH /v1/tenants/{id}` `secretRefs`), audited as `runnode.started`, `credential.issued`,
  `credential.denied`, `credential.revoked`, `runnode.stopped`, `runner.unsafe_socket` without values.
  A revoked or expired session kills its token immediately (also when another worker takes the run
  over); node-reported cost and tokens are dropped, nodes may only report model/tool/output/error steps (marked `node:<id>`) and receive the remaining budget; a node token can never complete a run or
  act for another step. A separate egress proxy service (`CONNECT`, signed per-node grants, operator ceiling
  `OAX_CONTAINER_EGRESS_ALLOW`, private/metadata/loopback ranges closed, air-gapped policy on top)
  enforces `runtime.egress`. New `GET /v1/worker/runs/{id}/handover`,
  `POST .../handover/result`; Compose profile `container-runner`; `docs/runners.md`. **Not yet**: run
  nodes cannot call models except the keyless `simulated` provider until the model proxy (W1-3b).
- **Kubernetes Job runner (W1-4)**: `KubernetesJobRunner` implements the isolating-runner contract
  of ADR 0008: one suspended Job per step plus an owner-referenced deny-by-default NetworkPolicy
  (DNS, control node and egress CIDR allowlist) and a Secret holding only the run token, then
  unsuspend; everything is deleted on stop. Hardened Pods (non-root, read-only rootfs, drop ALL,
  seccomp RuntimeDefault, no ServiceAccount token, resource limits, `activeDeadlineSeconds`,
  `ttlSecondsAfterFinished`, no secrets in env), digest-pinned and allowlisted images only, minimal
  namespaced RBAC (`docs/examples/kubernetes-job-runner-rbac.yaml`), in-cluster API client without
  extra dependencies. Security-reviewed: operator egress is an upper bound (steps can only narrow,
  min prefix /8 and /32, IMDS/link-local/loopback and `OAX_K8S_DENY_CIDRS` excluded, no step egress
  when air-gapped), Foreground Job deletion with the NetworkPolicy removed last, a static
  default-deny policy, uid-tracked cleanup, UUID-only node ids, clamped resources with LimitRange
  and ResourceQuota, a dedicated step ServiceAccount (`openagentix-run-node`), fail-closed toolbox
  allowlist and an explicit admission-signature acknowledgement. The `kubernetes-job` `StubRunner` is gone. `docs/kubernetes-job-runner.md`.
- **Agent Check and Agent Plan v1 (advisory)**: strict `AgentPlan` schema, deterministic
  least-privilege lint `LP001`-`LP008` with a fixed JSON output, optional model-assisted notes that
  can only add `info`/`warning` findings (untrusted, schema-validated, costed and budget-checked),
  and a deterministic plan -> `agents.md` draft generator. `POST /v1/plans/check` and
  `POST /v1/plans/generate` (audited as `plan.checked`/`plan.generated`, rate limit
  `OAX_RATE_LIMIT_PLAN_MAX`), `oax plan check|generate`, an "Agent plans" page (en, de). Nothing is
  stored or published automatically. `docs/agent-check.md`.
- **agents.md data flow fields (parsed and validated, no runtime effect yet)**: `schemas`,
- **Guided demo tour**: in demo mode the UI offers an 8-step modal tour (welcome, scenarios, run
  view, audit chain, costs, agents/tenants/roles, connections and policies, links) with spotlight,
  progress dots, a "Don't show this again" checkbox (localStorage with a session/memory fallback),
  a "Take the tour" entry in the sidebar and a hint box with the shared fake credentials on the
  sign-in page (`VITE_OAX_DEMO=true` build argument). English and German, own lazy-loaded component,
  no third-party code or requests, no API change. `docs/demo.md` ("Guided tour").
- **Named read/write tool profiles per MCP connection**: an `mcp` connection declares
  `tools: { <name>: { access: read | write } }` and `profiles: { <name>: [tool, ...] }` (unknown tools
  in a profile are refused when it is saved). `agents[].tools[].profile` grants such a profile; it is
  expanded into concrete grants when a version is published and stored in the immutable version
  (`expansion`, `toolAccess`, `expansionDigest`), so later profile edits never widen a published
  version. A step with `access: read-only` can never receive a write tool: refused at publish and
  denied by the policy gate at run time (`profile_write_denied`). Expansion and refusals are audited
  (`agent.profiles.expanded`, `agent.publish.denied`). Connections page and agent overview show
  classes, profiles and where a grant came from. `docs/mcp.md`.
- **Typed handovers and conditional steps (W1-1)**: `output.schema` / `input.schema` are validated at
  runtime (ajv 8, strict, JSON Schema subset, size and depth limits) with `onInvalid: fail|retry`,
  `input.from` gives a step only the JSON it names, and `when` is evaluated by a strictly typed,
  non-`eval` evaluator (false skips the step, an error fails the run). New run steps `condition` and
  `handover` (status `skipped`), audit entries `step.skipped`, `condition.error`, `handover.invalid`,
  `handover.retry` (never with the offending values), error codes `handover_invalid`,
  `handover_missing`, `condition_error`. `examples/ticket-triage.agents.md`, `docs/pipelines.md`.
- **agents.md data flow fields (parsed and validated; `schemas`, `input`, `output` and `when` now run, see above)**: `schemas`,
  `agents[].input`/`output` (JSON Schema subset with size, depth and safe-regex limits), `when`
  (bounded expression grammar, parsed at publish), `access`, `tools[].profile`, `credentials`
  (secret references per step) and `runtime` per step. Existing files parse unchanged.
  [ADR 0008](docs/adr/0008-agents-md-data-flow-and-isolation-contract.md) fixes the contract for
  handovers, tool profiles, the credential broker, run nodes and Agent Plan v1;
  `docs/agents-md.md`.
- **Demo profile**: `docker-compose.demo.yml` is a standalone, working stack (api, worker, ui,
  postgres) with the simulated provider. Fixed demo scenarios (`GET /v1/demo/scenarios`,
  `POST /v1/demo/scenarios/{id}/run`), a dashboard card, per-visitor and daily limits and the optional
  `OAX_DEMO_LLM=claude-code` mode that runs scenarios through the Claude Code harness (no free-text
  prompts, no built-in or outbound tools, per-run and daily budget caps, token only as a read-only
  mounted file). `docs/demo.md`.
- **Claude Code harness**: the adapter now runs `claude -p` (stream-json, `--tools ""`, `dontAsk`,
  explicit allowlist, `--restricted`) in a temporary directory with a minimal environment. The policy
  gate is served as a loopback MCP bridge (`serveGateHttp`) so every tool call is policy-checked,
  approved, audited and costed; agent limits map to `--max-turns`/`--max-budget-usd` and are enforced
  by the platform. `oax run --harness claude-code`, opt-in real-run test (`OAX_TEST_CLAUDE=1`),
  `docs/harnesses.md`, `docs/verification/claude-code-harness.md`. Other harnesses stay documented stubs.
- **OpenCode harness**: `createHarness('opencode')` / `oax run --harness opencode` runs
  `opencode run --format json` non-interactively with a generated deny-by-default config whose only
  tool source is the loopback policy gate, a minimal environment inside the temporary work directory,
  the model taken from an existing model connection (BYOK secret references; the key reaches the CLI
  only through the child environment and is redacted everywhere), platform-side step, cost and time
  limits, an air-gapped egress check of the model endpoint and an optional binary checksum pin. Tested
  with a fake CLI; the opt-in real-run test (`OAX_TEST_OPENCODE=1`) and its verification note are
  pending a pinned binary. `docs/harnesses.md`. Hermes and OpenClaw stay documented stubs.
- **Air-gapped mode** (`OAX_AIRGAPPED`, `OAX_AIRGAPPED_ALLOW`): fail-closed start-up self-check,
  process-wide egress policy and network guard (TCP, DNS, UDP), vendored model catalog only,
  `airgapped` state on `/readyz`, tests proving no outbound traffic, and `docs/airgapped.md`.
- **Budgets with hard stop**: monthly budgets per tenant, use case and team, checked when a run is
  queued and before every step of a running run (also across runs of the same month). A reached
  budget blocks or stops the run (`blocked_by_policy` or `failed` with `control_budget_*`), writes
  `run.blocked` / `budget.blocked` audit entries and raises alerts at 50, 80 and 100 % as events
  (`io.openagentix.budget.alert`) plus `budget.alert` audit entries. New API: `GET /v1/budgets`,
  `PUT`/`DELETE /v1/budgets/use-cases/{useCase}`, worker route `GET /v1/worker/runs/{id}/budget`;
  costs page shows and manages the budgets; migration `0004` adds `use_case_budgets` and
  `budget_alerts`; `docs/budgets.md`.
- **Tenant isolation**: every request-facing query is filtered by the caller's tenant; other
  tenants' resources answer 404 (denied agent/run access is audited), names are unique per tenant,
  workers resolve tool servers per run and tenant, cross-tenant references are refused. Tenants API
  (`/v1/tenants`), platform operators (`users.platform_admin`, `X-OAX-Tenant`, `allTenants`),
  connection scopes (platform, tenant, team, agent), platform vs tenant policies, tenant partition
  key on audit entries, and `docs/tenancy.md` with isolation tests.

- **Every regular provider as a model connection** (BYOK): Claude API (Anthropic), AWS Bedrock
  (default chain or key references), OpenAI (GPT), Azure OpenAI, OpenRouter, vLLM, LM Studio, Ollama
  and any OpenAI-compatible server. Connections of kind `model` hold secret references scoped to
  platform, tenant, team or agent (most specific wins), resolve per run, can be tested
  (`POST /v1/connections/{id}/test`) and fail with the real reason when broken. Pasted API keys are
  refused; tenant connections must use the tenant's secret namespace.
- **Model catalog from a pinned models.dev snapshot** (726 models, MIT, provenance with SHA-256),
  local models in `local.json`, `GET /v1/models?provider=&q=`, `POST /v1/models/proposals` and price
  proposals when a connection is created (explicit prices stay as overrides), Bedrock inference
  profile pricing, import script with a field whitelist and a weekly reviewed refresh PR job
  (`.github/workflows/catalog-refresh.yml`). Docs: `docs/providers.md`.
- UI: model connections with provider presets, scope and catalog price proposals.
- **Model proxy foundations (W1-3b-1, ADR 0009)**: model token (`oaxmt.`, HMAC key derived from the
  run token secret with the label `openagentix/model-token/v1`, bound to run, session, node and
  step, expiring, constant-time verification; cannot verify as a run token and vice versa),
  strict wire schemas of the native model endpoint (`WorkerModelRequest`, `WorkerModelResponse`,
  `ModelTokenResponse`, error envelope and code table), pure token estimators
  (`estimateInputUpperBound`, `estimateOutputTokens`, `outputFloor`) and prompt cache prices in
  the cost model (`cacheReadPerMTok`, `cacheWritePerMTok`; fallback input and 1.25 x input). No
  endpoint or behaviour change yet.

- **Model call accounting (W1-3b-2)**: `ModelAccountingService` reserves the worst-case cost of a model
  call before it is made and settles the measured cost afterwards (ADR 0009 section 4). A reservation
  is checked against the run and step budgets (cost, tokens, model calls), the monthly tenant, use case
  and team budgets and the concurrency limits in one transaction under a per-tenant advisory lock, so
  concurrent calls cannot overshoot a limit. Settlement writes the `model_call` step, the ledger line,
  run counters, budget alerts and audit entries atomically and is idempotent; a missing or implausible
  usage report falls back to the estimate and a lower bound (`usage_source` `estimated` / `floor`), an
  overdue reservation is charged at the reserved amount (`model.reservation_expired`, worker reaper),
  and a model without a price is refused (`model_unpriced`) whenever a cost limit applies. Cache tokens
  are priced separately (cache read as input and cache write as 1.25 x input unless the price entry
  names them). Migration `0010` adds `model_reservations`, the ledger columns `usage_source`,
  `cache_read_tokens`, `cache_write_tokens`, `reservation_id`, `via` and `run_node_sessions.model_token_jti`;
  all money is integer micro-USD. **Not yet wired**: the model proxy and the executor call the service
  with W1-3b-3 and W1-3b-4, so the budgets documented in `docs/budgets.md` still check after a call until then.

### Changed

- A model call is refused before it is made when its worst case does not fit a run, step or monthly
  budget (it used to be checked only after the call); an in-process step without `maxTokensPerCall`
  is capped at 4096 output tokens when the control plane reserves. A run node can no longer report
  `model_call` steps (`400 step_kind_refused`); the proxy records them. **Breaking for custom
  workers** that post `model_call` steps from a node token.

- **UI navigation**: the governance group (policies, audit trail, users & teams, API tokens) is now
  labelled "Governance" in English (was "Govern") and German (was "Steuern"); the key
  `nav.groups.govern` is unchanged.
- **Breaking (pre-1.0)**: MCP connection secrets of in-process runs are resolved through the tenant
  allowlist `tenants.secret_refs` (empty by default, canonical comparison); set it for tenants whose
  connections use secrets. Tenant slugs that overlap in canonical form (`acme`, `acme-corp`) cannot
  be created together, and the tenant prefix check of connection secrets is canonical.
- A step whose effective runner is isolating is never executed inline by the worker: without an
  enabled runner the run fails with `runner_unavailable`. The `container` runner is no longer a stub;
  publishing also refuses per-step runners that are not enabled.
- The tenant limit `tenants.monthly_budget_micros`, stored but not enforced before, is now a hard
  stop. Runs refused at admission by a tenant or use case budget carry the error codes
  `tenant_budget_exceeded` and `use_case_budget_exceeded` (team budgets keep
  `team_budget_exceeded`).
- **Breaking (API/DB, pre-1.0)**: `Principal` carries `tenantId` and `platformAdmin`; migration
  `0003` makes names unique per tenant, adds `users.tenant_id`, `users.platform_admin` and
  `policies.scope`, and marks existing `admin` users as platform operators.

### Fixed

- `docker-compose.yml`: the `volumes:` section contained a copy of the `ui` service and a dangling
  `ollama:` key; it now declares `pgdata` and `ollama`.
- **Release workflow**: the api image is built for linux/amd64 only; the QEMU arm64 build exceeded the 60 minute job timeout and the api image was never published (worker and ui keep amd64 and arm64).

- **Costs page "request validation failed"**: `GET /v1/costs/summary` and `/v1/costs/export` now accept
  `from`/`to` as a date (`YYYY-MM-DD`) or a full ISO 8601 timestamp and round it down to the first
  day of its month (UTC); the UI sends plain `YYYY-MM-DD` dates (local calendar, no timezone shift on
  the first of the month). Affects "This month", "Last 30 days" and the dashboard spend tile.
- **Audit "Verify hash chain" showed head #0 with an all-zero hash for tenants**: the tenant-scoped
  result now reports the tenant's own latest entry (real sequence number and hash) instead of a
  placeholder; the UI no longer prints a head for an empty trail.
- **UI unknown routes**: signed-out visitors opening an unknown path are redirected to `/login` instead of seeing the "Page not found" page; signed-in users still get the not-found page.
- **Database password override**: `OAX_DATABASE_PASSWORD` / `PGPASSWORD` were ignored with pg 8.23 when the connection string contained no password (SCRAM error "client password must be a string"); the password is now injected into the connection string (URL-encoded).

## [0.1.0] - 2026-10-04

First release of the openagentix platform (control node, worker, packages).

### Added

- **core**: `agents.md` parser and validator (YAML front matter + markdown sections, pipelines of
  1..n agents, budgets, tool allowlists with argument constraints, approvals, data classification,
  runtime/toolbox); immutable published versions (SemVer, digest); deterministic policy engine
  (audit agent); control agent guardrails (budgets, timeout, rate, loops, error streaks, policy
  denials, forbidden actions, provider clearance, optional stricter reviewer); SHA-256 audit hash
  chain with Ed25519-signed checkpoints and verification; cost model in micro-USD with a
  configurable price table; secret redaction; RBAC roles and team-scoped permissions; secret
  references; signed run tokens; CloudEvents 1.0 envelope and run state machine.
- **providers**: one provider interface with adapters for OpenAI-compatible APIs (OpenAI, Azure,
  vLLM, LM Studio), Ollama, AWS Bedrock (Converse, VPC endpoint, HTTPS proxy, default credential
  chain/IRSA), Anthropic (official SDK) and a deterministic `simulated` provider; egress guard
  that only allows configured endpoints.
- **events**: HMAC-SHA256 webhooks (`oax-v1` and GitHub schemes) with timestamp and replay
  protection, mail-in normalisation, Kafka consumer source (SASL/TLS, CloudEvents binary and
  structured mode), cron source.
- **mcp**: MCP client gateway (official SDK, stdio / streamable HTTP / in-memory) with per-agent
  allowlists, policy gate, timeouts and result size limits; policy gate exposed as an MCP proxy for
  external harnesses; deterministic demo servers (`cve-db`, `tickets`).
- **runners**: runner contract and shared step executor; `in-process` and `local` runners;
  `oax` CLI (`run`, `validate`); HTTP control plane client for remote worker nodes; typed stubs for
  container, Kubernetes Job, AWS Lambda, GitHub Actions and GitLab CI runners; external harness
  adapters (Claude Code invocation builder; OpenCode, Hermes, OpenClaw stubs).
- **api**: Fastify 5 control node with zod schemas and a committed OpenAPI 3.1 document;
  PostgreSQL via Drizzle with migrations, hot-path indexes and append-only triggers; endpoints for
  agents, event sources and ingest, events, runs (steps, SSE stream, cancel), approvals,
  connections, policies (incl. dry-run), audit (list, verify, export, checkpoints), costs, users,
  teams, API tokens, settings and worker run-token endpoints; OIDC (PKCE), LDAP/AD with group to
  role mapping, local bootstrap admin, scoped hashed API tokens; per-route access declarations
  enforced at start-up and in tests; rate limiting, security headers, CORS, compression, ETags;
  Prometheus metrics, OpenTelemetry hooks, pino logs with run-id correlation; LRU/Valkey cache
  layer; keyset pagination and prepared statements on hot paths.
- **worker**: Postgres `FOR UPDATE SKIP LOCKED` queue with leases, heartbeats and retries,
  configurable concurrency, approval waits, cancellation, cron scheduler with cluster-wide
  de-duplication and Kafka sources.
- **Operations**: standalone database settings (`OAX_DATABASE_URL` or `PG*` variables, separate
  `OAX_DATABASE_PASSWORD`), migrations under a Postgres advisory lock with wait-for-DB backoff,
  `/readyz` reports schema status, migration job needs only DB settings; worker HTTP server with
  `/healthz`, `/readyz`, `/metrics`; explicit `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` support for
  providers, AWS SDK, OIDC and MCP over HTTP; env contract for the v0.2 Kubernetes Job runner and
  toolbox allowlist (feature-flagged off, enforced at publish); release workflow publishing signed
  multi-arch images with SBOM attestations.
- **API for the UI**: stream tokens for EventSource, documented SSE/NDJSON media types, standard
  401/403/404 responses and OIDC redirects in OpenAPI, `GET /v1/auth/methods`, OIDC expiry in the
  UI redirect, role permissions in settings, step kind/status enums, agent/pipeline/team names in
  runs, approvals and costs, run time filters and `GET /v1/stats/runs`, `runId` filter for
  approvals, parsed definition from validation, dry runs of drafts with the simulated provider,
  cron event sources, source deletion, user detail, team members, team update and deletion,
  agent search.
- **Concept v2 foundations**: data model with tenants (`tenant_id` on agents, runs, events,
  approvals, connections, policies, costs, audit partition key), agent-scoped role bindings
  (hidden agents return 404, denials audited), cost lines with tenant/use case/run/step and CSV/JSON
  export, deterministic change gate for schedule sources (HTTP/file probes, audited, no tokens),
  pinned model catalog snapshot (models.dev schema) with local overrides and `GET /v1/models`,
  versioned development guidelines (global -> tenant -> agent, stricter wins) enforced by the
  policy gate and a hardening review endpoint, opt-in `dark-factory` agent mode with a fixed
  "prototypes and proofs of concept only" notice.
- **Public demo**: deterministic demo seed (`pnpm seed:demo`, `OAX_DEMO_MODE=true`) with two
  tenants, users for all six roles, six agents, runs, approvals, costs and a verifiable audit chain;
  read-only API in demo mode; compose demo profile.
- Examples `cve-triage` and `ticket-updater` with an end-to-end integration test; Dockerfile
  (api/worker targets, non-root, read-only rootfs friendly), docker compose stack, demo script,
  toolbox catalog skeleton, ADRs 0001-0006, configuration contract, performance baseline, CI with
  coverage gate and SHA-pinned actions, Dependabot, community files.

### Added (web UI)

- Web UI of the control node (`apps/ui`): React 19, Vite, TanStack Router/Query, typed API client
  generated from `openapi.yaml` (`pnpm gen:api`).
- Sign-in with OIDC (redirect), LDAP and local accounts; session expiry handling.
- Dashboard: runs today, success/failure, costs this month vs. team budgets, pending approvals,
  active policies, recent audit events, runners and providers.
- Agents: list, overview with runtime/toolbox/tools, `agents.md` editor with live validation,
  optimistic draft saves, version history, diff between versions, publish with confirmation,
  test runs with an example event.
- Workflow wizard for business users ("when … / check, do … / reply as …") that creates a draft
  `agents.md` for review and shows who must approve.
- Events & sources (webhook URLs, HMAC secret references, Kafka topics, cron schedules, mail-in,
  recent events), runs (filters, keyset pagination, virtualised table), live run detail over SSE
  with audit-gate decisions, costs, tokens, approvals and cancel.
- Connections (secrets by reference only), policies (bundles, audit-gate tester, budgets), audit
  trail (search, hash-chain verification, NDJSON export, checkpoints), costs, users/teams/RBAC
  matrix, API tokens, settings (providers, runners, Bedrock VPC endpoint/proxy configuration).
- English and German, light/dark theme, responsive layout, axe checks in tests, coverage gate
  80 %, bundle budget (initial JS < 200 KB gzip) and a third-party request scan of `dist/`.

[Unreleased]: https://github.com/open-agentix/open-agentix/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/open-agentix/open-agentix/releases/tag/v0.1.0
