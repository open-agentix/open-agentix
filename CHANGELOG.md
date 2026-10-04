# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-03

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
- Examples `cve-triage` and `ticket-updater` with an end-to-end integration test; Dockerfile
  (api/worker targets, non-root, read-only rootfs friendly), docker compose stack, demo script,
  toolbox catalog skeleton, ADRs 0001-0006, configuration contract, performance baseline, CI with
  coverage gate and SHA-pinned actions, Dependabot, community files.

[Unreleased]: https://github.com/open-agentix/open-agentix/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/open-agentix/open-agentix/releases/tag/v0.1.0
