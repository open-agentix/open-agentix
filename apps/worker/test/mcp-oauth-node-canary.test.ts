import { randomBytes } from 'node:crypto';
import { ContextGuard } from '@openagentix/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_TENANT_ID, runs } from '../src/db/schema.js';
import { processSecrets } from '../src/mcp-oauth/index.js';
import { testNode, type TestNode } from './helpers.js';

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
  await n.services.mcpOauth.tokens.put({
    tenantId: DEFAULT_TENANT_ID,
    connectionId: conn.json().id,
    credentialVersion: 1,
    issuer: 'https://auth.example.org',
    resource: 'https://jira.example.org/mcp',
    clientRef: 'client',
    scopes: ['read'],
    accessToken: CANARY,
  });
  await n.services.mcpOauth.credentials.accessToken(
    {
      id: conn.json().id,
      tenantId: DEFAULT_TENANT_ID,
      credentialVersion: 1,
      resource: 'https://jira.example.org/mcp',
    },
    ['read'],
    { guard: new ContextGuard() },
  );
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
  });
});
