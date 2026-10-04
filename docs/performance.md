# Performance

Speed is a product requirement. This document lists the design measures, the benchmark and the
current baseline.

## Targets (PostgreSQL 16, pooled connections)

| Path | p95 target |
| --- | --- |
| API reads (`GET /v1/runs`, `GET /v1/runs/{id}`, `GET /v1/agents`) | < 50 ms |
| Event ingest (`POST /v1/ingest/webhook/{id}`, excluding agent execution) | < 30 ms |

## Measures in the code

- **Indexes for every hot query** (runs by agent/status/team/time, partial queue and lease
  indexes, audit by run and time, events by source and time, pending approvals, cost ledger by
  team/agent/month). `apps/api/test/explain.test.ts` asserts with `EXPLAIN` that each hot query
  can use its index.
- **Keyset pagination** everywhere (`?limit=&cursor=`), never `OFFSET`.
- **Connection pooling** (`OAX_DB_POOL_MAX`) and **prepared statements** for the hottest reads
  (run by id, run steps, event source by id).
- **Cache-aside layer** (`apps/api/src/cache.ts`): in-memory LRU, optional Valkey/Redis
  (`OAX_CACHE_URL`) shared across replicas with explicit invalidation. Cached: immutable agent
  versions, latest version per agent, event sources, enabled policy bundles, teams, cost
  summaries (invalidated when runs finish), token -> principal for at most
  `min(OAX_AUTH_CACHE_TTL_SECONDS, token lifetime)`.
- **HTTP**: compression (br/gzip above 1 KB), weak ETags with `If-None-Match` -> `304`,
  SSE streaming of run steps instead of client polling.
- **Worker**: configurable concurrency (`OAX_WORKER_CONCURRENCY`), `SKIP LOCKED` claims without
  lock contention between replicas, leases instead of long transactions.

## Benchmark

```bash
pnpm build
node scripts/bench.mjs --duration 10 --connections 10          # embedded PGlite
OAX_DATABASE_URL=postgres://… node scripts/bench.mjs --write   # against PostgreSQL
```

The script starts the control node in-process, seeds the `cve-triage` agent, a webhook source and
1 000 runs, checks that every scenario answers 2xx, then runs autocannon per endpoint and reports
p50/p95/p99 from every response. `--write` stores the result in
[`performance-baseline.json`](performance-baseline.json).

## Baseline (2026-10-03)

Environment: Node.js 20.19.2, **embedded PGlite** (WASM, one connection, in memory), shared homelab
host (8 cores, other workloads running), 10 s per scenario. Only PGlite was available for this
run; the PostgreSQL baseline is measured in the compose stack (see "Gaps").

1 connection (latency floor):

| Endpoint | req/s | p50 ms | p95 ms | p99 ms |
| --- | ---: | ---: | ---: | ---: |
| `GET /v1/runs?limit=50` | 161 | 5.79 | 8.71 | 10.33 |
| `GET /v1/runs/:id` | 503 | 1.69 | 3.42 | 4.21 |
| `GET /v1/agents` | 627 | 1.43 | 2.51 | 3.14 |
| `POST /v1/ingest/webhook/:id` | 117 | 7.80 | 13.20 | 16.41 |

10 connections (throughput; all requests queue on PGlite's single connection):

| Endpoint | req/s | p50 ms | p95 ms | p99 ms |
| --- | ---: | ---: | ---: | ---: |
| `GET /v1/runs?limit=50` | 107 | 84.59 | 196.81 | 247.22 |
| `GET /v1/runs/:id` | 471 | 20.60 | 29.81 | 35.87 |
| `GET /v1/agents` | 564 | 16.39 | 27.88 | 31.97 |
| `POST /v1/ingest/webhook/:id` | 108 | 94.52 | 110.15 | 123.53 |

Reading the numbers:

- Unloaded, every path meets its target (reads p95 2.5–8.7 ms, ingest p95 13.2 ms).
- Under concurrency, PGlite serialises all queries on one WASM connection, so latency grows with
  the queue; this is a property of the embedded test database, not of the API. With PostgreSQL
  and a pool the requests run in parallel.
- Ingest is the most expensive path: replay protection insert, event insert, run insert, team
  budget check and a serialised audit append (advisory lock) per webhook.

## Gaps and next steps

- Measure the PostgreSQL baseline in CI (service container) and in the compose stack and record it here.
- Batch audit appends for ingest (one transaction for replay guard, event, run and audit entry).
- Cache the team budget check (budget row + month-to-date spend) for a few seconds.
- `GET /v1/runs?limit=50` serialises 50 full run objects; a lighter list projection
  (without outputs) is planned for v0.2.
