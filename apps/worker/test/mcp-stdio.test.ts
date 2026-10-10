import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testNode, type TestNode } from '../../api/test/helpers.js';
import { Worker, workerStdioGuard } from '../src/index.js';

/**
 * ADR 0016 S0, worker side: a tenant-defined stdio server never starts in the worker process,
 * not even for a version that was published before the rule existed; platform stdio servers keep
 * working in-process.
 */
// Not below the temporary directory: OAX_MCP_STDIO_COMMANDS refuses entries in /tmp and friends.
const dir = realpathSync(
  mkdtempSync(join(fileURLToPath(new URL('.', import.meta.url)), '.oax-stdio-worker-')),
);
const marker = join(dir, 'started');
const script = join(dir, 'tenant-server');
const fixture = fileURLToPath(
  new URL('../../../packages/mcp/test/fixtures/stdio-server.mjs', import.meta.url),
);
let n: TestNode;
let worker: Worker;

const source = (name: string, server: string) => `---
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
      - { server: ${server}, tool: echo }
    simulation:
      responses:
        - toolCalls:
            - { server: ${server}, tool: echo, args: {} }
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
const runAgent = async (name: string) => {
  const agents = (await n.req({ method: 'GET', url: '/v1/agents?limit=100' })).json().items as {
    id: string;
    name: string;
  }[];
  const id = agents.find((a) => a.name === name)!.id;
  const runId = (
    await n.req({ method: 'POST', url: `/v1/agents/${id}/runs`, payload: { data: {} } })
  ).json().id as string;
  return waitFor(async () => {
    const r = (await n.req({ method: 'GET', url: `/v1/runs/${runId}` })).json();
    return ['succeeded', 'failed', 'blocked_by_policy'].includes(r.status) ? r : undefined;
  });
};
const audit = async (action: string) =>
  (await n.req({ method: 'GET', url: `/v1/audit?action=${action}&limit=100` })).json().items as {
    payload: Record<string, unknown>;
  }[];

beforeAll(async () => {
  // a command that leaves a trace if it is ever started
  writeFileSync(script, `#!/bin/sh\ntouch ${marker}\n`);
  chmodSync(script, 0o755);
  n = await testNode({ OAX_WORKER_POLL_MS: '20', OAX_MCP_STDIO_COMMANDS: `${dir}/*` });
  await n.req({ method: 'POST', url: '/v1/teams', payload: { slug: 'team-ops', name: 'Ops' } });
  // published BEFORE the connection exists: publish cannot know yet (second wall under test)
  for (const [name, server] of [
    ['late-tenant', 'tenant-srv'],
    ['platform-inproc', 'platform-srv'],
  ] as const) {
    const created = await n.req({
      method: 'POST',
      url: '/v1/agents',
      payload: { source: source(name, server) },
    });
    expect(
      (await n.req({ method: 'POST', url: `/v1/agents/${created.json().id}/publish` })).statusCode,
    ).toBe(201);
  }
  const tenant = await n.req({
    method: 'POST',
    url: '/v1/connections',
    payload: { name: 'tenant-srv', config: { transport: 'stdio', command: script } },
  });
  expect(tenant.statusCode).toBe(201);
  const platform = await n.req({
    method: 'POST',
    url: '/v1/connections',
    payload: {
      name: 'platform-srv',
      scope: 'platform',
      config: {
        transport: 'stdio',
        command: process.execPath,
        args: [fixture],
        tools: { echo: { access: 'read' } },
      },
    },
  });
  expect(platform.statusCode).toBe(201);
  worker = new Worker(n.ctx, { workerId: 'w-stdio' });
  worker.start();
});
afterAll(async () => {
  await worker.stop(true);
  await n.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('in-process steps', () => {
  it('fail a run with a tenant stdio grant before anything is started, and audit it', async () => {
    const run = await runAgent('late-tenant');
    expect(run.status).toBe('failed');
    expect(run.errorCode).toBe('mcp_stdio_requires_isolation');
    expect(run.errorMessage).toContain('tenant-srv');
    expect(existsSync(marker)).toBe(false);
    const entry = (await audit('mcp.stdio.refused')).find(
      (e) => e.payload.code === 'mcp_stdio_requires_isolation',
    );
    expect((entry?.payload.issues as unknown[])[0]).toMatchObject({
      step: 'a',
      connection: 'tenant-srv',
    });
  });

  it('still run platform (operator-defined) stdio servers', async () => {
    const run = await runAgent('platform-inproc');
    expect(run.status).toBe('succeeded');
    expect(run.toolCalls).toBe(1);
  });
});

describe('the gateway of the worker process', () => {
  it('refuses every stdio server that is not a platform one, whatever the step says', () => {
    const guard = workerStdioGuard(new Set(['platform-srv']));
    expect(() => guard({ name: 'platform-srv' })).not.toThrow();
    expect(() => guard({ name: 'tenant-srv' })).toThrowError(
      expect.objectContaining({ code: 'mcp_stdio_requires_isolation' }),
    );
    expect(() => guard({ name: 'shadowed' })).toThrow(/run node/);
  });
});
