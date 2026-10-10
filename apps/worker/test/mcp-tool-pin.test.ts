import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { schema } from '@openagentix/api';
import { handleMockMcpHttp, type MockTool } from '@openagentix/mcp';
import type { OutboundDispatcher } from '@openagentix/providers';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testNode, type TestNode } from '../../api/test/helpers.js';
import { Worker } from '../src/index.js';

/**
 * ADR 0016 section 5, run time: a version that pinned the tools of an HTTP MCP server runs while
 * the server answers with the pinned definitions, fails closed with `mcp_tools_changed` when a
 * granted tool changed (audit with names and digests only, pending snapshot, metric), runs again
 * after an `existing-versions` approval, and versions without a pin run with a warning.
 */
let n: TestNode;
let worker: Worker;
let http: Server;
let port = 0;
let tools: MockTool[] = [];

const tool = (name: string, extra: Partial<MockTool> = {}): MockTool => ({
  name,
  description: `does ${name}`,
  inputSchema: { type: 'object', properties: {} },
  handler: () => `result of ${name}`,
  ...extra,
});

const local = {
  fetch: (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, init);
  },
  close: async () => undefined,
} as unknown as OutboundDispatcher;

const source = (name: string, tool: string) => `---
apiVersion: openagentix.io/v1alpha1
kind: Agent
name: ${name}
version: 1.0.0
owner: team-ops
agents:
  - id: a
    provider: simulated
    model: sim-1
    instructions: Work.
    tools:
      - { server: jira, tool: ${tool} }
    simulation:
      responses:
        - toolCalls:
            - { server: jira, tool: ${tool}, args: {} }
        - text: done
---
Work.
`;

const waitFor = async <T>(fn: () => Promise<T | undefined>): Promise<T> => {
  const end = Date.now() + 15_000;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
};
const run = async (agentId: string) => {
  const runId = (
    await n.req({ method: 'POST', url: `/v1/agents/${agentId}/runs`, payload: { data: {} } })
  ).json().id as string;
  return waitFor(async () => {
    const r = (await n.req({ method: 'GET', url: `/v1/runs/${runId}` })).json();
    return ['succeeded', 'failed', 'blocked_by_policy'].includes(r.status) ? r : undefined;
  });
};
const audit = async (action: string) =>
  (await n.req({ method: 'GET', url: `/v1/audit?action=${action}&limit=200` })).json().items as {
    target: string;
    runId: string | null;
    payload: Record<string, unknown>;
  }[];
let connectionId = '';
const snapshots = async () =>
  (await n.req({ method: 'GET', url: `/v1/connections/${connectionId}/tool-snapshots` })).json()
    .items as { digest: string; status: string; source: string }[];
async function approveCurrent(scope: 'new-versions' | 'existing-versions') {
  const r = await n.req({ method: 'POST', url: `/v1/connections/${connectionId}/tools/refresh` });
  expect(r.statusCode, r.body).toBe(200);
  const digest = r.json().snapshot.digest as string;
  const a = await n.req({
    method: 'POST',
    url: `/v1/connections/${connectionId}/tool-snapshots/${digest}/approve`,
    payload: { scope },
  });
  expect(a.statusCode, a.body).toBe(200);
  return digest;
}
async function publishAgent(name: string, toolName: string): Promise<string> {
  const created = await n.req({
    method: 'POST',
    url: '/v1/agents',
    payload: { source: source(name, toolName) },
  });
  expect(created.statusCode, created.body).toBe(201);
  const pub = await n.req({ method: 'POST', url: `/v1/agents/${created.json().id}/publish` });
  expect(pub.statusCode, pub.body).toBe(201);
  return created.json().id as string;
}

beforeAll(async () => {
  http = createServer((req, res) => void handleMockMcpHttp(req, res, 'srv', tools));
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  port = (http.address() as AddressInfo).port;
  n = await testNode({ OAX_WORKER_POLL_MS: '20' }, { mcpOutbound: local, mcpProbeLimit: 10_000 });
  await n.req({ method: 'POST', url: '/v1/teams', payload: { slug: 'team-ops', name: 'Ops' } });
  tools = [tool('get_issue'), tool('other')];
  const c = await n.req({
    method: 'POST',
    url: '/v1/connections',
    payload: {
      name: 'jira',
      scope: 'platform',
      config: { transport: 'streamable-http', url: `http://127.0.0.1:${port}/mcp` },
    },
  });
  expect(c.statusCode, c.body).toBe(201);
  connectionId = c.json().id;
  worker = new Worker(n.ctx, { workerId: 'w-pin', mcpOutbound: local });
  worker.start();
});
afterAll(async () => {
  await worker.stop(true);
  await n.close();
  await new Promise((r) => http.close(r));
});

describe('a pinned version', () => {
  let agent = '';
  let pinned = '';
  const CANARY = 'RUG-PULL-CANARY-INSTRUCTION';

  it('runs while the server answers with the pinned definitions', async () => {
    pinned = await approveCurrent('new-versions');
    agent = await publishAgent('pinned-agent', 'get_issue');
    const r = await run(agent);
    expect(r).toMatchObject({ status: 'succeeded', toolCalls: 1 });
    expect((await audit('mcp.tools.changed')).length).toBe(0);
    expect((await audit('mcp.tools.unpinned')).length).toBe(0);
  });

  it('ignores a change to a tool it does not hold', async () => {
    tools = [tool('get_issue'), tool('other', { description: `${CANARY} (not granted)` })];
    expect((await run(agent)).status).toBe('succeeded');
    expect((await audit('mcp.tools.changed')).length).toBe(0);
  });

  it('fails closed on a changed granted tool: no tool is exposed, nothing is called', async () => {
    let calls = 0;
    tools = [
      tool('get_issue', {
        description: `does get_issue. ${CANARY}`,
        handler: () => {
          calls++;
          return 'must not run';
        },
      }),
      tool('other'),
    ];
    const r = await run(agent);
    expect(r.status).toBe('failed');
    expect(r.errorCode).toBe('mcp_tools_changed');
    expect(r.toolCalls).toBe(0);
    expect(calls).toBe(0);
    // the error text names the server, not the changed text
    expect(r.errorMessage).toContain('jira');
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });

  it('audits names and digests only, keeps the live list as a pending snapshot and counts it', async () => {
    const entry = (await audit('mcp.tools.changed')).find((e) => e.target === connectionId);
    expect(entry).toBeDefined();
    expect(entry!.payload).toMatchObject({
      connection: 'jira',
      tools: ['get_issue'],
      pendingSnapshot: true,
    });
    expect(entry!.payload.oldDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(entry!.payload.newDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(entry!.payload.oldDigest).not.toBe(entry!.payload.newDigest);
    expect(JSON.stringify(entry)).not.toContain(CANARY);
    const pending = (await snapshots()).filter((s) => s.status === 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ source: 'run' });
    const metric = await n.ctx.metrics.registry.getSingleMetricAsString(
      'oax_mcp_tools_changed_total',
    );
    expect(metric).toMatch(/oax_mcp_tools_changed_total 1/);
    expect(metric).not.toContain('jira');
  });

  it('stays blocked until an admin approves, and the version keeps its pin', async () => {
    expect((await run(agent)).errorCode).toBe('mcp_tools_changed');
    const v = (await n.req({ method: 'GET', url: `/v1/agents/${agent}/versions/1.0.0` })).json();
    expect(v.toolPins.jira.snapshotDigest).toBe(pinned);
  });

  it('runs again after an existing-versions approval, without a new version', async () => {
    await approveCurrent('existing-versions');
    const r = await run(agent);
    expect(r).toMatchObject({ status: 'succeeded', toolCalls: 1 });
  });

  it('fails closed again on the next change (the acceptance is for one snapshot only)', async () => {
    tools = [tool('get_issue', { description: 'changed yet again' }), tool('other')];
    expect((await run(agent)).errorCode).toBe('mcp_tools_changed');
  });
});

describe('a version without a pin', () => {
  it('runs with a warning in the audit log and fails when pins are required', async () => {
    tools = [tool('get_issue'), tool('other')];
    await approveCurrent('new-versions');
    const agent = await publishAgent('legacy-agent', 'get_issue');
    // A version published before ADR 0016 S3 has no toolPins (versions are append-only, so the
    // legacy shape is inserted as a second version of the agent).
    const [version] = await n.ctx.db
      .select()
      .from(schema.agentVersions)
      .where(eq(schema.agentVersions.agentId, agent));
    const { toolPins: _pins, ...rest } = version!.definition as Record<string, unknown>;
    void _pins;
    const legacyId = randomUUID();
    await n.ctx.db.insert(schema.agentVersions).values({
      ...version!,
      id: legacyId,
      version: '1.0.1',
      definition: { ...rest, version: '1.0.1' },
    });
    await n.ctx.db
      .update(schema.agents)
      .set({ latestVersionId: legacyId, latestVersion: '1.0.1' })
      .where(eq(schema.agents.id, agent));
    await n.ctx.cache.del(`agent-latest:${agent}`);

    const ok = await run(agent);
    expect(ok.status).toBe('succeeded');
    const warned = (await audit('mcp.tools.unpinned')).find((e) => e.runId === ok.id);
    expect(warned?.payload).toMatchObject({ connection: 'jira', required: false });

    n.ctx.config.mcp.requireToolPin = true;
    try {
      const refused = await run(agent);
      expect(refused.status).toBe('failed');
      expect(refused.errorCode).toBe('mcp_tools_unpinned');
      expect(refused.toolCalls).toBe(0);
    } finally {
      n.ctx.config.mcp.requireToolPin = false;
    }
  });
});
