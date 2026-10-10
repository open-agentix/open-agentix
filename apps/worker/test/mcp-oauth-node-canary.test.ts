import { randomBytes } from 'node:crypto';
import { StaticSecretResolver } from '@openagentix/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContainerRunner } from '@openagentix/runners';
import { runs } from '../../api/src/db/schema.js';
import { processSecrets } from '../../api/src/mcp-oauth/index.js';
import { testNode, type TestNode } from '../../api/test/helpers.js';
import { FakeAs, FakeMcp, World } from '../../api/test/oauth-world.js';
import { mergeCredentials } from '../src/run-node.js';

/**
 * Token leak canary, run-node side (ADR 0016 section 10, slices S5 and S6). The step uses an HTTP
 * connection with OAuth: the control node's relay obtains a REAL token from a fake authorization
 * server (discovery, client credentials, resource indicator), attaches it to the upstream request
 * and answers the node. The token flows through the control node, so this test is not green by
 * construction: it first proves that the token reached the MCP server and was echoed back, then
 * that none of it (access token, client secret, client key) is in anything a run node is given or
 * can ask for: session, handover, credentials, relay answers, steps, audit, run views, the merged
 * child environment and the container create options.
 */
const IMAGE = `ghcr.io/open-agentix/open-agentix-worker@sha256:${'a'.repeat(64)}`;
const CLIENT_SECRET = 'NODE-CANARY-CLIENT-SECRET-7Zp2Qx9Lm4Wv8Kc';
const SOURCE = `---
apiVersion: openagentix.io/v1alpha1
kind: AgentPipeline
name: canary-agent
version: 1.0.0
owner: team-ops
runtime:
  runner: container
  egress: [jira.example.org]
budget: { maxTokens: 1000, maxCostUsd: 1, maxSteps: 50, maxToolCalls: 10, timeoutSeconds: 100 }
agents:
  - id: research
    provider: simulated
    model: sim-1
    instructions: Research.
    tools:
      - { server: jira, tool: get_issue }
      - { server: jira, tool: echo_auth }
      - { server: ops, tool: get_issue }
---
`;

let n: TestNode;
let agentId: string;
let world: World;
let as: FakeAs;
let mcp: FakeMcp;

beforeAll(async () => {
  world = new World();
  as = new FakeAs(world);
  mcp = new FakeMcp(world, as, 'jira.example.org', [
    {
      name: 'get_issue',
      description: 'gets an issue',
      inputSchema: { type: 'object' },
      handler: () => 'issue',
    },
  ]);
  await mcp.start();
  const secrets = new StaticSecretResolver({
    'mail-hook': 'mail-secret-1',
    'oa-client-id': 'client-id-4711',
    'oa-client-secret': CLIENT_SECRET,
  });
  n = await testNode(
    {
      OAX_MCP_OAUTH_KEK: randomBytes(32).toString('base64'),
      OAX_RUNNERS_ENABLED: 'in-process,container',
      OAX_CONTAINER_RUNNER_ENABLED: 'true',
      OAX_CONTAINER_ENGINE_URL: 'http://socket-proxy:2375',
      OAX_CONTAINER_IMAGE: IMAGE,
      OAX_CONTAINER_NETWORK: 'oax-nodes',
      OAX_NODE_CONTROL_URL: 'http://api:8080',
      OAX_CONTAINER_EGRESS_PROXY_URL: 'http://egress-proxy:3128',
      OAX_CONTAINER_EGRESS_GRANT_SECRET: 'g'.repeat(40),
      OAX_CONTAINER_EGRESS_ALLOW: 'jira.example.org',
      OAX_MCP_STDIO_COMMANDS: '/opt/mcp/bin/*',
    },
    { secrets, mcpOutbound: world.dispatcher, mcpProbeLimit: 10_000 },
  );
  await n.req({ method: 'POST', url: '/v1/teams', payload: { slug: 'team-ops', name: 'Ops' } });
  const tenantId = (await n.req({ method: 'GET', url: '/v1/tenants' })).json().items[0].id;
  await n.req({
    method: 'PATCH',
    url: `/v1/tenants/${tenantId}`,
    payload: { secretRefs: ['mail-hook', 'oa-client-id', 'oa-client-secret'] },
  });
  // a stdio server keeps the environment merge of the node under test
  const stdio = await n.req({
    method: 'POST',
    url: '/v1/connections',
    payload: {
      name: 'ops',
      config: {
        transport: 'stdio',
        command: '/opt/mcp/bin/ops-mcp',
        env: { OPS_URL: 'https://jira.example.org' },
        envSecrets: { OPS_TOKEN: 'mail-hook' },
        tools: { get_issue: { access: 'read' } },
      },
    },
  });
  expect(stdio.statusCode, stdio.body).toBe(201);
  const http = await n.req({
    method: 'POST',
    url: '/v1/connections',
    payload: {
      name: 'jira',
      config: {
        transport: 'streamable-http',
        url: 'https://jira.example.org/mcp',
        auth: {
          kind: 'oauth',
          grant: 'client_credentials',
          issuer: 'https://auth.example.org',
          client: {
            clientIdSecret: 'oa-client-id',
            clientAuth: 'client_secret_basic',
            clientSecretSecret: 'oa-client-secret',
          },
        },
        tools: {
          get_issue: { access: 'read', scopes: ['issues.read'] },
          echo_auth: { access: 'read', scopes: ['issues.read'] },
        },
        profiles: { read: ['get_issue', 'echo_auth'] },
      },
    },
  });
  expect(http.statusCode, http.body).toBe(201);
  const id = http.json().id as string;
  const auth = await n.req({
    method: 'POST',
    url: `/v1/connections/${id}/oauth/authorize`,
    payload: {},
  });
  expect(auth.statusCode, auth.body).toBe(200);
  const refresh = await n.req({ method: 'POST', url: `/v1/connections/${id}/tools/refresh` });
  expect(refresh.statusCode, refresh.body).toBe(200);
  const approve = await n.req({
    method: 'POST',
    url: `/v1/connections/${id}/tool-snapshots/${refresh.json().snapshot.digest}/approve`,
    payload: { scope: 'new-versions' },
  });
  expect(approve.statusCode, approve.body).toBe(200);
  const created = await n.req({ method: 'POST', url: '/v1/agents', payload: { source: SOURCE } });
  expect(created.statusCode, created.body).toBe(201);
  agentId = created.json().id;
  const pub = await n.req({ method: 'POST', url: `/v1/agents/${agentId}/publish` });
  expect(pub.statusCode, pub.body).toBe(201);
});
afterAll(async () => {
  processSecrets.clear();
  await mcp.stop();
  await n.close();
});

describe('token leak canary: run node', () => {
  it('the token reaches the server through the relay, and nothing a node can see carries it', async () => {
    const res = await n.req({
      method: 'POST',
      url: `/v1/agents/${agentId}/runs`,
      payload: { data: {} },
    });
    const runId = res.json().id as string;
    await n.ctx.db
      .update(runs)
      .set({
        status: 'running',
        lockedBy: 'w1',
        startedAt: new Date(),
        leaseUntil: new Date(Date.now() + 60_000),
      })
      .where(eq(runs.id, runId));
    const session = await n.services.runNodes.createSession(runId, 'w1', {
      agentId: 'research',
      input: { ticket: 'SEC-1' },
      timeoutSeconds: 30,
      runner: 'container',
      image: IMAGE,
    });
    const seen = [JSON.stringify(session)];
    const call = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
      const r = await n.req({ method, url, token: session.token, payload: payload as never });
      seen.push(r.body);
      return r;
    };
    expect(
      (await call('POST', `/v1/worker/runs/${runId}/credentials`, { agentId: 'research' }))
        .statusCode,
    ).toBe(200);
    expect(
      (await call('GET', `/v1/worker/runs/${runId}/handover?agentId=research`)).statusCode,
    ).toBe(200);
    const rpc = (id: number, method: string, params?: unknown) =>
      call('POST', `/v1/worker/runs/${runId}/mcp/jira`, { jsonrpc: '2.0', id, method, params });
    expect((await rpc(1, 'tools/list')).statusCode).toBe(200);
    const echoed = await rpc(2, 'tools/call', { name: 'echo_auth', arguments: {} });
    expect(echoed.statusCode, echoed.body).toBe(200);

    // The token really flowed: the server saw a token the authorization server issued, and its
    // echo came back to the control node. The relay's answer to the node is redacted.
    const issued = [...as.tokens];
    expect(issued.length).toBeGreaterThan(0);
    expect(mcp.seenAuth.some((a) => a === `Bearer ${issued.at(-1)}`)).toBe(true);
    expect(mcp.lastAuth).toBe(`Bearer ${issued.at(-1)}`);
    expect(echoed.body).toContain('the header was');
    expect(echoed.body).toContain('[redacted:known-secret]');

    // The redactor must not be what keeps the token out of the node from here on: it is empty, so a
    // structural leak shows up in the bodies below instead of being scrubbed on the way out.
    processSecrets.clear();
    for (const url of [
      `/v1/runs/${runId}`,
      `/v1/runs/${runId}/steps`,
      `/v1/audit?runId=${runId}&limit=200`,
      '/v1/audit?limit=500',
    ]) {
      const r = await n.req({ method: 'GET', url });
      seen.push(r.body);
    }
    const everything = seen.join('\n');
    for (const secret of [...issued, CLIENT_SECRET, 'oa-client-secret'])
      expect(everything, secret.slice(0, 6)).not.toContain(secret);
    expect(everything).not.toMatch(/accessTokenEnc|access_token_enc/);
    expect(everything).not.toContain('clientSecretSecret');

    // The node environment and the environment of its MCP children, built from exactly what the
    // control node handed over, and the container's create options.
    const creds = JSON.parse(seen[1] as string);
    const handover = JSON.parse(seen[2] as string);
    const jira = (handover.mcp as { name: string; url: string; auth?: unknown }[]).find(
      (c) => c.name === 'jira',
    )!;
    expect(jira.url).not.toContain('jira.example.org');
    expect(jira.auth).toBeUndefined();
    const merged = mergeCredentials(handover.mcp ?? [], creds);
    const env = JSON.stringify(merged);
    for (const secret of issued) expect(env).not.toContain(secret);
    const body = new ContainerRunner({
      engineUrl: 'http://socket-proxy:2375',
      image: IMAGE,
      network: 'oax-nodes',
    }).buildCreateBody({
      runId,
      nodeId: session.nodeId,
      steps: ['research'],
      image: IMAGE,
      controlUrl: 'http://api:8080',
      runToken: session.token,
      limits: { cpus: 0.5, memoryMb: 256, timeoutSeconds: 30, pids: 64 },
      egress: [],
    });
    for (const secret of [...issued, CLIENT_SECRET])
      expect(JSON.stringify(body)).not.toContain(secret);
    expect(body.Env.some((e: string) => issued.some((t) => e.includes(t)))).toBe(false);
  });

  it('the detector goes red for a variant that puts a token into the node environment', async () => {
    const token = [...as.tokens].at(-1)!;
    // What a leaking implementation would produce: the check above must notice it.
    const leaked = mergeCredentials(
      [
        {
          name: 'x',
          transport: 'stdio',
          command: '/opt/mcp/bin/x',
          args: [],
          env: {},
          envSecrets: {},
          tools: {},
        } as never,
      ],
      {
        agentId: 'a',
        credentials: [{ secret: 's', env: 'LEAK', value: token }],
        connections: [],
        expiresAt: '',
      } as never,
    );
    expect(JSON.stringify(leaked)).toContain(token);
  });

  it('the broker never lists the OAuth client secrets of an HTTP connection', async () => {
    const res = await n.req({ method: 'GET', url: '/v1/audit?limit=500' });
    expect(res.body).not.toContain(CLIENT_SECRET);
  });
});
