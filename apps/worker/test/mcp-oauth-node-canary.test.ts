import { randomBytes } from 'node:crypto';
import { ContextGuard } from '@openagentix/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContainerRunner } from '@openagentix/runners';
import { DEFAULT_TENANT_ID, runs } from '../../api/src/db/schema.js';
import { processSecrets } from '../../api/src/mcp-oauth/index.js';
import { testNode, type TestNode } from '../../api/test/helpers.js';
import { mergeCredentials } from '../src/run-node.js';

/**
 * Token leak canary, run-node side (ADR 0016 section 10, slice S5): a run node gets its session,
 * its handover, its credentials and its step records from the control node, and its environment is
 * built from those. A stored OAuth token of a connection the step uses must be in none of them.
 */
const CANARY = 'CANARY-node-access-4c2e8a1f7d3b9065';
const IMAGE = `ghcr.io/open-agentix/open-agentix-worker@sha256:${'a'.repeat(64)}`;
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
---
`;

let n: TestNode;
let agentId: string;

beforeAll(async () => {
  n = await testNode({
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
  });
  await n.req({ method: 'POST', url: '/v1/teams', payload: { slug: 'team-ops', name: 'Ops' } });
  const conn = await n.req({
    method: 'POST',
    url: '/v1/connections',
    payload: {
      name: 'jira',
      config: {
        transport: 'stdio',
        command: '/opt/mcp/bin/jira-mcp',
        env: { JIRA_URL: 'https://jira.example.org' },
        envSecrets: { JIRA_TOKEN: 'mail-hook' },
        tools: { get_issue: { access: 'read' } },
      },
    },
  });
  expect(conn.statusCode, conn.body).toBe(201);
  const tenantId = (await n.req({ method: 'GET', url: '/v1/tenants' })).json().items[0].id;
  await n.req({
    method: 'PATCH',
    url: `/v1/tenants/${tenantId}`,
    payload: { secretRefs: ['mail-hook'] },
  });
  // An HTTP connection of the same tenant holds the OAuth token; the stdio `jira` connection is
  // what the step uses. Nothing the node is given may be derived from the token table.
  const http = await n.req({
    method: 'POST',
    url: '/v1/connections',
    payload: {
      name: 'jira-oauth',
      config: { transport: 'streamable-http', url: 'https://jira.example.org/mcp' },
    },
  });
  expect(http.statusCode, http.body).toBe(201);
  await n.services.mcpOauth.tokens.put({
    tenantId: DEFAULT_TENANT_ID,
    connectionId: http.json().id,
    credentialVersion: 1,
    issuer: 'https://auth.example.org',
    resource: 'https://jira.example.org/mcp',
    clientRef: 'client',
    scopes: ['read'],
    accessToken: CANARY,
  });
  await n.services.mcpOauth.credentials.accessToken(
    { id: http.json().id, tenantId: DEFAULT_TENANT_ID },
    ['read'],
    { guard: new ContextGuard() },
  );
  // The redactor must not be what keeps the token out of the node: it is empty from here on, so a
  // structural leak shows up in the bodies below instead of being scrubbed on the way out.
  processSecrets.clear();
  const created = await n.req({ method: 'POST', url: '/v1/agents', payload: { source: SOURCE } });
  expect(created.statusCode, created.body).toBe(201);
  agentId = created.json().id;
  const pub = await n.req({ method: 'POST', url: `/v1/agents/${agentId}/publish` });
  expect(pub.statusCode, pub.body).toBe(201);
});
afterAll(async () => {
  processSecrets.clear();
  await n.close();
});

describe('token leak canary: run node', () => {
  it('session, handover, credentials, steps and audit carry no token', async () => {
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
    await call('POST', `/v1/worker/runs/${runId}/mcp/jira`, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    // control-side views of the same run
    for (const url of [
      `/v1/runs/${runId}`,
      `/v1/runs/${runId}/steps`,
      `/v1/audit?runId=${runId}&limit=200`,
    ]) {
      const r = await n.req({ method: 'GET', url });
      seen.push(r.body);
    }
    for (const body of seen) expect(body).not.toContain(CANARY);
    expect(seen.join('')).not.toMatch(/accessTokenEnc|access_token_enc/);

    // The node environment and the environment of its MCP children, built from exactly what the
    // control node handed over, and the container's create options.
    const creds = JSON.parse(seen[1] as string);
    const handover = JSON.parse(seen[2] as string);
    const merged = mergeCredentials(handover.mcp ?? [], creds);
    expect(JSON.stringify(merged)).not.toContain(CANARY);
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
    expect(JSON.stringify(body)).not.toContain(CANARY);
    expect(body.Env.some((e: string) => e.includes(CANARY))).toBe(false);
  });

  it('the detector goes red for a variant that puts the token into the node environment', async () => {
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
        credentials: [{ secret: 's', env: 'LEAK', value: CANARY }],
        connections: [],
        expiresAt: '',
      } as never,
    );
    expect(JSON.stringify(leaked)).toContain(CANARY);
  });
});
