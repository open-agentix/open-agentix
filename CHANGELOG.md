# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
