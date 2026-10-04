import net from 'node:net';
import { getEgressPolicy } from '@openagentix/core';
import { demoServerFactories, inMemoryServers, type Ticket } from '@openagentix/mcp';
import { signWebhook } from '@openagentix/events';
import { createContext, deactivateAirgap, loadConfig } from '@openagentix/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CVE_TRIAGE, TRIVY_EVENT } from '../../api/test/fixtures.js';
import { testNode, type TestNode } from '../../api/test/helpers.js';
import { Worker, createWorkerHttpServer } from '../src/index.js';

/**
 * PROOF that an air-gapped deployment makes no outbound connection: a complete agent run
 * (webhook -> queue -> worker -> simulated provider -> policy gate -> MCP tools -> audit/costs)
 * with an EMPTY allowlist while the network guard refuses every non-loopback TCP connect, DNS
 * lookup and UDP send and records each attempt. The run must succeed and nothing may be recorded.
 */
let n: TestNode;
let worker: Worker;
const tickets = new Map<string, Ticket>();

const waitFor = async <T>(fn: () => Promise<T | undefined>, ms = 10_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

beforeAll(async () => {
  n = await testNode({ OAX_AIRGAPPED: 'true', OAX_WORKER_POLL_MS: '20' });
  for (const name of ['cve-db', 'tickets'])
    await n.req({
      method: 'POST',
      url: '/v1/connections',
      payload: { name, config: { transport: 'in-memory' } },
    });
  const agent = (
    await n.req({ method: 'POST', url: '/v1/agents', payload: { source: CVE_TRIAGE } })
  ).json();
  await n.req({ method: 'POST', url: `/v1/agents/${agent.id}/publish` });
  await n.req({
    method: 'POST',
    url: '/v1/event-sources',
    payload: { name: 'trivy', kind: 'webhook', secretRefs: ['trivy-hook'], agentId: agent.id },
  });
  worker = new Worker(n.ctx, {
    workerId: 'airgap',
    inMemoryMcp: inMemoryServers(demoServerFactories(tickets)),
  });
  worker.start();
});

afterAll(async () => {
  await worker.stop(true);
  await n.close();
  deactivateAirgap();
});

describe('air-gapped end to end', () => {
  it('runs a full agent run with zero outbound attempts', async () => {
    expect(getEgressPolicy().airgapped).toBe(true);
    const sources = (await n.req({ method: 'GET', url: '/v1/event-sources' })).json().items as {
      id: string;
    }[];
    const body = JSON.stringify(TRIVY_EVENT);
    const res = await n.req({
      method: 'POST',
      url: `/v1/ingest/webhook/${sources[0]!.id}`,
      token: null,
      payload: body,
      headers: {
        'content-type': 'application/json',
        ...signWebhook('hook-secret-1', body, Math.floor(Date.now() / 1000), 'airgap-1'),
      },
    });
    expect(res.statusCode).toBe(202);
    const run = await waitFor(async () => {
      const r = (await n.req({ method: 'GET', url: `/v1/runs/${res.json().runId}` })).json();
      return ['succeeded', 'failed', 'blocked_by_policy'].includes(r.status) ? r : undefined;
    });
    expect(run).toMatchObject({ status: 'succeeded', toolCalls: 2 });
    expect(tickets.get('SEC-42')?.comments.length).toBe(1);
    expect(
      (await n.req({ method: 'POST', url: '/v1/audit/verify', payload: {} })).json().valid,
    ).toBe(true);

    // Not a single refused attempt happened during the whole run.
    expect(getEgressPolicy().recorded()).toEqual([]);
    expect(getEgressPolicy().status().blocked).toBe(0);
  });

  it('the guard is live: any real egress attempt throws and is recorded', async () => {
    await expect(fetch('https://api.anthropic.com/v1/messages')).rejects.toThrow();
    const err = await new Promise<Error>((resolve) => {
      net.connect({ host: '198.51.100.20', port: 5432 }).once('error', resolve);
    });
    expect(err).toMatchObject({ code: 'egress_denied' });
    expect(
      getEgressPolicy()
        .recorded()
        .map((v) => v.host),
    ).toEqual(expect.arrayContaining(['api.anthropic.com', '198.51.100.20']));
  });

  it('worker /readyz reports the air-gapped state', async () => {
    const srv = createWorkerHttpServer(n.ctx, worker);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as net.AddressInfo).port;
    const body = (await (await fetch(`http://127.0.0.1:${port}/readyz`)).json()) as {
      airgapped: { enabled: boolean; blockedAttempts: number };
    };
    srv.close();
    expect(body.airgapped.enabled).toBe(true);
    expect(body.airgapped.blockedAttempts).toBeGreaterThanOrEqual(2);
  });

  it('refuses to start when a stored MCP connection is not allowlisted', async () => {
    await n.req({
      method: 'POST',
      url: '/v1/connections',
      payload: {
        name: 'ok',
        config: { transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp' },
      },
    });
    // simulate a connection that was stored before air-gapped mode was switched on
    await n.ctx.database.db.execute(
      `insert into connections (id, tenant_id, scope, name, kind, config)
       select gen_random_uuid(), tenant_id, 'tenant', 'legacy', 'mcp',
              '{"transport":"streamable-http","url":"https://tools.vendor.example/mcp"}'::jsonb
       from connections limit 1` as never,
    );
    const config = loadConfig({
      NODE_ENV: 'test',
      OAX_DATABASE_URL: 'memory://',
      OAX_LOG_LEVEL: 'silent',
      OAX_AIRGAPPED: 'true',
    });
    await expect(createContext(config, { database: n.ctx.database })).rejects.toThrow(
      /MCP connection "legacy": tools.vendor.example/,
    );
  });
});
