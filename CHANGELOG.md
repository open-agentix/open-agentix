# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-04

First MVP release of the openagentix platform (control node, worker, packages).

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
  "MVP/PoC only" notice.
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
