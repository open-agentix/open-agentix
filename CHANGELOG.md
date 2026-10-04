# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Named read/write tool profiles per MCP connection**: an `mcp` connection declares
  `tools: { <name>: { access: read | write } }` and `profiles: { <name>: [tool, ...] }` (unknown tools
  in a profile are refused when it is saved). `agents[].tools[].profile` grants such a profile; it is
  expanded into concrete grants when a version is published and stored in the immutable version
  (`expansion`, `toolAccess`, `expansionDigest`), so later profile edits never widen a published
  version. A step with `access: read-only` can never receive a write tool: refused at publish and
  denied by the policy gate at run time (`profile_write_denied`). Expansion and refusals are audited
  (`agent.profiles.expanded`, `agent.publish.denied`). Connections page and agent overview show
  classes, profiles and where a grant came from. `docs/mcp.md`.
- **agents.md data flow fields (parsed and validated, no runtime effect yet)**: `schemas`,
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

### Changed

- The tenant limit `tenants.monthly_budget_micros`, stored but not enforced before, is now a hard
  stop. Runs refused at admission by a tenant or use case budget carry the error codes
  `tenant_budget_exceeded` and `use_case_budget_exceeded` (team budgets keep
  `team_budget_exceeded`).
- **Breaking (API/DB, pre-1.0)**: `Principal` carries `tenantId` and `platformAdmin`; migration
  `0003` makes names unique per tenant, adds `users.tenant_id`, `users.platform_admin` and
  `policies.scope`, and marks existing `admin` users as platform operators.

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
