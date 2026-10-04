# ADR 0001: Tech stack

- Status: Accepted
- Date: 2026-10-03

## Context

openagentix must be self-hostable by small shops (one docker compose file) and enterprises
(Kubernetes, EKS, air-gapped), be easy to contribute to, and have a strong typed contract between
backend, UI, Helm chart and agent definitions.

## Decision

- **TypeScript everywhere**, Node.js 22 LTS (20.19+ supported), ESM, `strict` + `noUncheckedIndexedAccess`.
- **pnpm workspaces** monorepo: `packages/{core,providers,events,mcp,runners}`, `apps/{api,worker,ui}`;
  exact dependency versions, committed lockfile, `onlyBuiltDependencies` allowlist for install scripts.
- **Fastify 5 + zod**: request/response schemas generate the **OpenAPI 3.1** document committed as
  `openapi.yaml`; a test fails when it is stale.
- **PostgreSQL 16 + Drizzle ORM** with SQL migrations (drizzle-kit) plus hand-written SQL for
  triggers. The run queue is a Postgres table claimed with `FOR UPDATE SKIP LOCKED` – no extra
  broker yet.
- **Tests**: vitest, **PGlite** (embedded Postgres in WASM) so the full suite runs without Docker;
  coverage gate >= 80 % for lines, branches, functions and statements.
- **Observability**: pino JSON logs with run-id correlation, prom-client `/metrics`,
  OpenTelemetry API with an optional OTLP exporter.
- **MCP** via the official `@modelcontextprotocol/sdk` (pinned).

## Consequences

- One language and one test runner for every package; the UI and Helm chart consume the OpenAPI
  document and `docs/configuration.md` as contracts.
- PGlite differs slightly from server Postgres (single connection, no roles); role grants and
  pooling are documented and exercised in compose/Helm, not in unit tests.
- Postgres as queue limits throughput to thousands of runs per minute, which is far above the needs of a first release;
  Kafka/NATS can be added behind the same `RunQueue` contract later.

## Alternatives considered

- Go/Rust backend: faster, but splits the stack and the agents.md parser between languages.
- NestJS/Express: heavier or slower than Fastify; no first-class schema-driven OpenAPI.
- Prisma: query engine binary and weaker SQL control (SKIP LOCKED, partial indexes, triggers).
- Redis/BullMQ queue: one more stateful service for small installs.
