#!/usr/bin/env node
// Benchmark of the control node hot paths with autocannon.
// Usage: pnpm build && node scripts/bench.mjs [--duration 10] [--connections 10] [--otel] [--write]
// --otel: run with the OpenTelemetry exporter on, against a local fake collector (ADR 0015
// section 13). With --write the result is stored as the `otel` row of docs/performance-baseline.json
// and the plain baseline is kept; compare the two rows for the overhead of tracing.
// Uses embedded PGlite unless OAX_DATABASE_URL points to PostgreSQL. No external network.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import autocannon from 'autocannon';
import { createControlNode, initTelemetry, loadConfig } from '../apps/api/dist/index.js';
import { signWebhook } from '../packages/events/dist/index.js';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : def;
};
const duration = arg('duration', 10);
const connections = arg('connections', 10);

const withOtel = process.argv.includes('--otel');
// Fake OTLP collector on loopback: accepts every export and counts the payload bytes.
const collector = { requests: 0, bytes: 0 };
let collectorServer = null;
let collectorUrl = null;
if (withOtel) {
  collectorServer = createServer((req, res) => {
    req.on('data', (chunk) => (collector.bytes += chunk.length));
    req.on('end', () => {
      collector.requests++;
      res.statusCode = 200;
      res.end();
    });
  });
  await new Promise((resolve) => collectorServer.listen(0, '127.0.0.1', resolve));
  collectorUrl = `http://127.0.0.1:${collectorServer.address().port}`;
}

process.env.OAX_SECRET_BENCH_HOOK = 'bench-secret';
const config = loadConfig({
  ...(collectorUrl ? { OTEL_EXPORTER_OTLP_ENDPOINT: collectorUrl } : {}),
  NODE_ENV: 'test',
  OAX_DATABASE_URL: process.env.OAX_DATABASE_URL ?? 'memory://',
  OAX_LOG_LEVEL: 'silent',
  OAX_RATE_LIMIT_MAX: '100000000',
  OAX_BOOTSTRAP_ADMIN_EMAIL: 'bench@example.com',
  OAX_BOOTSTRAP_ADMIN_PASSWORD: 'bench-password-123',
  OAX_RUN_TOKEN_SECRET: 'b'.repeat(40),
});
const telemetry = await initTelemetry(config.otel, {
  warn: (fields, message) =>
    console.warn(JSON.stringify({ level: 'warn', ...fields, msg: message })),
});
const node = await createControlNode(config);
telemetry.attachStats(node.ctx.metrics.otel);
const { app, services } = node;
const address = await app.listen({ host: '127.0.0.1', port: 0 });
const login = await app.inject({
  method: 'POST',
  url: '/v1/auth/login',
  payload: { username: 'bench@example.com', password: 'bench-password-123' },
});
const auth = { authorization: `Bearer ${login.json().token}` };

// Seed: one team, the cve-triage agent, a webhook source and 1000 runs.
await app.inject({
  method: 'POST',
  url: '/v1/teams',
  headers: auth,
  payload: { slug: 'team-security', name: 'Security' },
});
const source = readFileSync(new URL('../examples/cve-triage.agents.md', import.meta.url), 'utf8');
const agentId = (
  await app.inject({ method: 'POST', url: '/v1/agents', headers: auth, payload: { source } })
).json().id;
await app.inject({ method: 'POST', url: `/v1/agents/${agentId}/publish`, headers: auth });
const sourceId = (
  await app.inject({
    method: 'POST',
    url: '/v1/event-sources',
    headers: auth,
    payload: { name: 'bench', kind: 'webhook', secretRefs: ['bench-hook'], agentId },
  })
).json().id;
let lastRun = '';
for (let i = 0; i < 1000; i++) {
  lastRun = (
    await services.runs.enqueue({
      agentId,
      event: { specversion: '1.0', id: randomUUID(), source: '/bench', type: 'bench', data: { i } },
      triggeredBy: 'bench',
    })
  ).id;
}
const body = readFileSync(
  new URL('../examples/events/trivy-finding.json', import.meta.url),
  'utf8',
);

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function scenario(name, opts) {
  const latencies = [];
  const statuses = {};
  const { path, ...rest } = opts;
  const instance = autocannon({ url: `${address}${path ?? ''}`, duration, connections, ...rest });
  instance.on('response', (_c, status, _bytes, ms) => {
    latencies.push(ms);
    statuses[status] = (statuses[status] ?? 0) + 1;
  });
  const result = await instance;
  latencies.sort((a, b) => a - b);
  return {
    name,
    requests: result.requests.total,
    rps: Math.round(result.requests.average),
    p50: +percentile(latencies, 50).toFixed(2),
    p95: +percentile(latencies, 95).toFixed(2),
    p99: +percentile(latencies, 99).toFixed(2),
    non2xx: result.non2xx,
    statuses,
    errors: result.errors,
  };
}

// Sanity check: every scenario must answer 2xx before it is measured.
for (const path of ['/v1/runs?limit=50', `/v1/runs/${lastRun}`, '/v1/agents']) {
  const res = await fetch(`${address}${path}`, { headers: auth });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${await res.text()}`);
}

{
  const res = await fetch(`${address}/v1/ingest/webhook/${sourceId}`, {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      ...signWebhook('bench-secret', body, Math.floor(Date.now() / 1000), randomUUID()),
    },
  });
  if (res.status !== 202) throw new Error(`ingest -> HTTP ${res.status}: ${await res.text()}`);
}

const results = [];
results.push(await scenario('GET /v1/runs?limit=50', { path: '/v1/runs?limit=50', headers: auth }));
results.push(await scenario('GET /v1/runs/:id', { path: `/v1/runs/${lastRun}`, headers: auth }));
results.push(await scenario('GET /v1/agents', { path: '/v1/agents', headers: auth }));
results.push(
  await scenario('POST /v1/ingest/webhook/:id', {
    requests: [
      {
        method: 'POST',
        path: `/v1/ingest/webhook/${sourceId}`,
        setupRequest: (req) => ({
          ...req,
          body,
          headers: {
            'content-type': 'application/json',
            ...signWebhook('bench-secret', body, Math.floor(Date.now() / 1000), randomUUID()),
          },
        }),
      },
    ],
  }),
);

await app.close();
await node.ctx.database.close();
await telemetry.shutdown();
if (collectorServer) await new Promise((resolve) => collectorServer.close(resolve));

const meta = {
  date: new Date().toISOString(),
  node: process.version,
  database: node.ctx.database.kind,
  duration,
  connections,
  otel: withOtel,
};
console.log(`\n${JSON.stringify(meta)}\n`);
console.log('| Endpoint | req/s | p50 ms | p95 ms | p99 ms | non-2xx | errors |');
console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const r of results)
  console.log(
    `| \`${r.name}\` | ${r.rps} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.non2xx} | ${r.errors} |`,
  );
console.log(JSON.stringify(results.map((r) => [r.name, r.statuses])));
if (withOtel)
  console.log(`collector received ${collector.requests} exports, ${collector.bytes} bytes`);
if (process.argv.includes('--write')) {
  const file = new URL('../docs/performance-baseline.json', import.meta.url);
  const current = JSON.parse(readFileSync(file, 'utf8'));
  const next = withOtel
    ? { ...current, otel: { meta, results, collector } }
    : { meta, results, ...(current.otel ? { otel: current.otel } : {}) };
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
}
