import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testNode, type TestNode } from '../../api/test/helpers.js';
import { Worker, createWorkerHttpServer } from '../src/index.js';

let n: TestNode;
let base: string;
let server: ReturnType<typeof createWorkerHttpServer>;
const probe = { id: 'w-http', running: true, activeRuns: 0 };

beforeAll(async () => {
  n = await testNode({ OAX_METRICS_TOKEN: 'm-token' });
  server = createWorkerHttpServer(n.ctx, probe);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await n.close();
});

describe('worker HTTP server', () => {
  it('serves liveness and readiness', async () => {
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({
      status: 'ok',
      workerId: 'w-http',
    });
    const ready = await fetch(`${base}/readyz?x=1`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      checks: { database: true, schema: true, loop: true },
    });
    probe.running = false;
    expect((await fetch(`${base}/readyz`)).status).toBe(503);
    probe.running = true;
  });

  it('protects and serves metrics', async () => {
    expect((await fetch(`${base}/metrics`)).status).toBe(401);
    const w = new Worker(n.ctx, { workerId: 'w-metrics' });
    await w.tick();
    const res = await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer m-token' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('oax_worker_active_runs{worker="w-metrics"} 0');
    expect(w.running).toBe(false);
  });

  it('rejects other methods and paths and reports internal errors', async () => {
    expect((await fetch(`${base}/healthz`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    const registry = n.ctx.metrics.registry;
    const original = registry.metrics.bind(registry);
    registry.metrics = async () => {
      throw new Error('boom');
    };
    expect(
      (await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer m-token' } })).status,
    ).toBe(500);
    registry.metrics = original;
  });
});
