import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { toolsDigest, grantedTools, type PinnedTool } from '@openagentix/core';
import { handleMockMcpHttp, type MockTool } from '@openagentix/mcp';
import type { OutboundDispatcher } from '@openagentix/providers';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runs } from '../src/db/schema.js';
import { testNode, type TestNode } from './helpers.js';

/**
 * ADR 0016 section 5 for run nodes: the handover carries the pins of the step's HTTP servers (digests
 * only), and a node that finds the tools changed reports the list to the control node, which
 * recomputes everything, audits names and digests, and keeps a pending snapshot. The node is
 * untrusted: it cannot report for a server or step it holds no pin for, and cannot make the
 * control node record an accepted digest as a change.
 */
const IMAGE = `ghcr.io/open-agentix/open-agentix-worker@sha256:${'a'.repeat(64)}`;
const ENV = {
  OAX_RUNNERS_ENABLED: 'in-process,container',
  OAX_CONTAINER_RUNNER_ENABLED: 'true',
  OAX_CONTAINER_ENGINE_URL: 'http://socket-proxy:2375',
  OAX_CONTAINER_IMAGE: IMAGE,
  OAX_CONTAINER_NETWORK: 'oax-nodes',
  OAX_NODE_CONTROL_URL: 'http://api:8080',
  OAX_CONTAINER_EGRESS_PROXY_URL: 'http://egress-proxy:3128',
  OAX_CONTAINER_EGRESS_GRANT_SECRET: 'g'.repeat(40),
  OAX_CONTAINER_EGRESS_ALLOW: 'jira.example.org',
};
const SOURCE = `---
apiVersion: openagentix.io/v1alpha1
kind: AgentPipeline
name: node-pin-agent
version: 1.0.0
owner: team-ops
runtime:
  runner: container
  egress: [jira.example.org]
agents:
  - id: research
    provider: simulated
    model: sim-1
    instructions: Research.
    tools:
      - { server: jira, tool: get_issue }
  - id: plain
    provider: simulated
    model: sim-1
    instructions: Plain.
---
`;

let n: TestNode;
let http: Server;
let port = 0;
let tools: MockTool[] = [];
let agentId = '';
let connectionId = '';
const tool = (name: string, extra: Partial<MockTool> = {}): MockTool => ({
  name,
  description: `does ${name}`,
  inputSchema: { type: 'object' },
  handler: () => 'x',
  ...extra,
});
const wire = (list: MockTool[]): PinnedTool[] =>
  list.map((t) => ({
    name: t.name,
    description: t.description!,
    inputSchema: t.inputSchema!,
    ...(t.annotations ? { annotations: t.annotations } : {}),
  }));
const local = {
  fetch: (url: string | URL, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${port}${new URL(String(url)).pathname}`, init),
  close: async () => undefined,
} as unknown as OutboundDispatcher;

async function newRun(): Promise<string> {
  const runId = (
    await n.req({ method: 'POST', url: `/v1/agents/${agentId}/runs`, payload: { data: {} } })
  ).json().id as string;
  await n.ctx.db
    .update(runs)
    .set({
      status: 'running',
      lockedBy: 'w1',
      startedAt: new Date(),
      leaseUntil: new Date(Date.now() + 60_000),
    })
    .where(eq(runs.id, runId));
  return runId;
}
const session = (runId: string, agent = 'research') =>
  n.services.runNodes.createSession(runId, 'w1', {
    agentId: agent,
    input: {},
    timeoutSeconds: 30,
    runner: 'container',
    image: IMAGE,
  });
const handover = async (runId: string, token: string, agent = 'research') =>
  n.req({
    method: 'GET',
    url: `/v1/worker/runs/${runId}/handover?agentId=${agent}`,
    token,
  });
const report = (runId: string, token: string, body: Record<string, unknown>) =>
  n.req({
    method: 'POST',
    url: `/v1/worker/runs/${runId}/mcp-tools-changed`,
    token,
    payload: body,
  });
const audit = async (action: string) =>
  (await n.req({ method: 'GET', url: `/v1/audit?action=${action}&limit=200` })).json().items as {
    actor: string;
    runId: string | null;
    payload: Record<string, unknown>;
  }[];
const snapshots = async () =>
  (await n.req({ method: 'GET', url: `/v1/connections/${connectionId}/tool-snapshots` })).json()
    .items as { digest: string; status: string; source: string }[];

beforeAll(async () => {
  http = createServer((req, res) => void handleMockMcpHttp(req, res, 'srv', tools));
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  port = (http.address() as AddressInfo).port;
  n = await testNode(ENV, { mcpOutbound: local, mcpProbeLimit: 10_000 });
  await n.req({ method: 'POST', url: '/v1/teams', payload: { slug: 'team-ops', name: 'Ops' } });
  tools = [tool('get_issue'), tool('other')];
  const c = await n.req({
    method: 'POST',
    url: '/v1/connections',
    payload: {
      name: 'jira',
      scope: 'platform',
      config: { transport: 'streamable-http', url: 'http://jira.example.org/mcp' },
    },
  });
  expect(c.statusCode, c.body).toBe(201);
  connectionId = c.json().id;
  const r = await n.req({ method: 'POST', url: `/v1/connections/${connectionId}/tools/refresh` });
  const digest = r.json().snapshot.digest as string;
  expect(
    (
      await n.req({
        method: 'POST',
        url: `/v1/connections/${connectionId}/tool-snapshots/${digest}/approve`,
        payload: { scope: 'new-versions' },
      })
    ).statusCode,
  ).toBe(200);
  const created = await n.req({ method: 'POST', url: '/v1/agents', payload: { source: SOURCE } });
  expect(created.statusCode, created.body).toBe(201);
  agentId = created.json().id;
  const pub = await n.req({ method: 'POST', url: `/v1/agents/${agentId}/publish` });
  expect(pub.statusCode, pub.body).toBe(201);
});
afterAll(async () => {
  await n.close();
  await new Promise((r) => http.close(r));
});

describe('handover', () => {
  it("carries the pin of the step's servers, digests only", async () => {
    const runId = await newRun();
    const s = await session(runId);
    const res = await handover(runId, s.token);
    expect(res.statusCode, res.body).toBe(200);
    const expected = toolsDigest(grantedTools(wire(tools), ['get_issue']));
    expect(res.json().toolPins).toEqual({ jira: { granted: ['get_issue'], accepted: [expected] } });
    expect(res.body).not.toContain('does get_issue');
  });

  it('has no pins for a step without tools', async () => {
    const runId = await newRun();
    const s = await session(runId, 'plain');
    expect((await handover(runId, s.token, 'plain')).json().toolPins).toBeUndefined();
  });
});

describe('POST /v1/worker/runs/{id}/mcp-tools-changed', () => {
  const changed = () => [tool('get_issue', { description: 'now sends your mail' }), tool('other')];

  it("records the change from the node's list: digest recomputed, names only, pending snapshot", async () => {
    const runId = await newRun();
    const s = await session(runId);
    const list = wire(changed());
    const res = await report(runId, s.token, {
      agentId: 'research',
      server: 'jira',
      // a lying digest is ignored when the list is there
      liveDigest: 'a'.repeat(64),
      tools: list,
    });
    expect(res.statusCode, res.body).toBe(204);
    const entry = (await audit('mcp.tools.changed')).find((e) => e.runId === runId);
    expect(entry?.actor).toBe(`node:${s.nodeId}`);
    expect(entry?.payload).toMatchObject({
      connection: 'jira',
      tools: ['get_issue'],
      newDigest: toolsDigest(grantedTools(list, ['get_issue'])),
      pendingSnapshot: true,
    });
    expect(JSON.stringify(entry)).not.toContain('sends your mail');
    expect(
      (await snapshots()).filter((x) => x.source === 'run' && x.status === 'pending'),
    ).toHaveLength(1);
    // the same report again is the same event
    expect(
      (
        await report(runId, s.token, {
          agentId: 'research',
          server: 'jira',
          liveDigest: 'a'.repeat(64),
          tools: list,
        })
      ).statusCode,
    ).toBe(204);
    expect((await audit('mcp.tools.changed')).filter((e) => e.runId === runId)).toHaveLength(1);
  });

  it('records a change that was too large to send by its digest alone', async () => {
    const runId = await newRun();
    const s = await session(runId);
    const res = await report(runId, s.token, {
      agentId: 'research',
      server: 'jira',
      liveDigest: 'invalid',
    });
    expect(res.statusCode).toBe(204);
    const entry = (await audit('mcp.tools.changed')).find((e) => e.runId === runId);
    expect(entry?.payload).toMatchObject({ newDigest: 'invalid', pendingSnapshot: false });
  });

  it('ignores a report of an accepted digest: nothing changed, nothing recorded', async () => {
    const runId = await newRun();
    const s = await session(runId);
    const before = (await audit('mcp.tools.changed')).length;
    const res = await report(runId, s.token, {
      agentId: 'research',
      server: 'jira',
      liveDigest: 'b'.repeat(64),
      tools: wire(tools),
    });
    expect(res.statusCode).toBe(204);
    expect((await audit('mcp.tools.changed')).length).toBe(before);
  });

  it('refuses a server the step holds no pin for, another step, a foreign run and a bad token', async () => {
    const runId = await newRun();
    const s = await session(runId);
    const body = { agentId: 'research', server: 'ghost', liveDigest: 'a'.repeat(64), tools: [] };
    expect((await report(runId, s.token, body)).statusCode).toBe(403);
    const other = await session(await newRun(), 'plain');
    // the token of the `plain` step may not report for `research`
    expect(
      (await report(runId, other.token, { ...body, server: 'jira' })).statusCode,
    ).toBeGreaterThanOrEqual(401);
    expect((await report(runId, 'not-a-token', { ...body, server: 'jira' })).statusCode).toBe(401);
    // a step without a grant on the server
    const plain = await session(runId, 'plain');
    expect(
      (await report(runId, plain.token, { ...body, agentId: 'plain', server: 'jira' })).statusCode,
    ).toBe(403);
  });

  it('bounds and checks the list it is given', async () => {
    const runId = await newRun();
    const s = await session(runId);
    const base = { agentId: 'research', server: 'jira', liveDigest: 'a'.repeat(64) };
    const many = Array.from({ length: 501 }, (_, i) => ({ name: `t${i}`, inputSchema: {} }));
    expect((await report(runId, s.token, { ...base, tools: many })).statusCode).toBe(400);
    const bad = await report(runId, s.token, { ...base, tools: [{ nope: 1 }] });
    expect(bad.statusCode).toBe(422);
  });

  it('never stores a list with a credential in it', async () => {
    const runId = await newRun();
    const s = await session(runId);
    const leaky = [
      { name: 'get_issue', description: `key ghp_${'a1B2c3D4e5'.repeat(4)}`, inputSchema: {} },
    ];
    const before = (await snapshots()).length;
    expect(
      (
        await report(runId, s.token, {
          agentId: 'research',
          server: 'jira',
          liveDigest: 'a'.repeat(64),
          tools: leaky,
        })
      ).statusCode,
    ).toBe(204);
    expect((await snapshots()).length).toBe(before);
    const entry = (await audit('mcp.tools.changed')).find((e) => e.runId === runId);
    expect(entry?.payload.pendingSnapshot).toBe(false);
    expect(JSON.stringify(entry)).not.toContain('ghp_');
  });
});

describe('after an existing-versions approval', () => {
  it('lists the accepted digests in the next handover', async () => {
    tools = [tool('get_issue', { description: 'reworded' }), tool('other')];
    const r = await n.req({ method: 'POST', url: `/v1/connections/${connectionId}/tools/refresh` });
    const digest = r.json().snapshot.digest as string;
    const a = await n.req({
      method: 'POST',
      url: `/v1/connections/${connectionId}/tool-snapshots/${digest}/approve`,
      payload: { scope: 'existing-versions' },
    });
    expect(a.statusCode, a.body).toBe(200);
    const runId = await newRun();
    const s = await session(runId);
    const pins = (await handover(runId, s.token)).json().toolPins.jira;
    expect(pins.granted).toEqual(['get_issue']);
    expect(pins.accepted).toHaveLength(2);
    expect(pins.accepted).toContain(toolsDigest(grantedTools(wire(tools), ['get_issue'])));
  });
});

describe('a list that a run reported', () => {
  it('cannot be approved until an admin fetched exactly that list', async () => {
    const reported = [tool('get_issue', { description: 'reported by a node' }), tool('other')];
    const runId = await newRun();
    const s = await session(runId);
    expect(
      (
        await report(runId, s.token, {
          agentId: 'research',
          server: 'jira',
          liveDigest: 'a'.repeat(64),
          tools: wire(reported),
        })
      ).statusCode,
    ).toBe(204);
    const pending = (await snapshots()).find((x) => x.source === 'run' && x.status === 'pending')!;
    const approve = () =>
      n.req({
        method: 'POST',
        url: `/v1/connections/${connectionId}/tool-snapshots/${pending.digest}/approve`,
        payload: { scope: 'new-versions' },
      });
    const refused = await approve();
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('mcp_snapshot_unconfirmed');
    // the server does not return that list: fetching does not confirm it, it stays unapproved
    tools = [tool('get_issue', { description: 'what the server really says' }), tool('other')];
    await n.req({ method: 'POST', url: `/v1/connections/${connectionId}/tools/refresh` });
    expect((await approve()).statusCode).toBe(409);
    // the server returns exactly the reported list: the fetch confirms it and approval works
    tools = reported;
    const fetched = await n.req({
      method: 'POST',
      url: `/v1/connections/${connectionId}/tools/refresh`,
    });
    expect(fetched.json()).toMatchObject({ created: false, snapshot: { digest: pending.digest } });
    expect((await approve()).statusCode).toBe(200);
    expect((await snapshots()).find((x) => x.digest === pending.digest)?.source).toBe('refresh');
  });
});
