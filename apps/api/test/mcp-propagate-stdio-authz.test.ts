import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testNode, type TestNode } from './helpers.js';

/**
 * ADR 0015 S8: once `telemetry.propagate` is on, repointing the connection (command, args, env,
 * secrets, egress) needs a tenant admin again; an integrator may still save an unchanged one.
 */
const IMAGE = `ghcr.io/open-agentix/open-agentix-worker@sha256:${'a'.repeat(64)}`;
const JIRA = '/opt/mcp/bin/jira-mcp';
const OTHER = '/opt/mcp/bin/other-mcp';
const ENV = {
  OAX_RUNNERS_ENABLED: 'in-process,container',
  OAX_CONTAINER_RUNNER_ENABLED: 'true',
  OAX_CONTAINER_ENGINE_URL: 'http://socket-proxy:2375',
  OAX_CONTAINER_IMAGE: IMAGE,
  OAX_CONTAINER_NETWORK: 'oax-nodes',
  OAX_NODE_CONTROL_URL: 'http://api:8080',
  OAX_CONTAINER_EGRESS_PROXY_URL: 'http://egress-proxy:3128',
  OAX_CONTAINER_EGRESS_GRANT_SECRET: 'g'.repeat(40),
  OAX_CONTAINER_EGRESS_ALLOW: '*.atlassian.example,api.jira.example',
  OAX_MCP_STDIO_COMMANDS: '/opt/mcp/bin/*',
  OAX_MCP_STDIO_EGRESS: JSON.stringify({
    [JIRA]: ['*.atlassian.example', 'api.jira.example'],
    [OTHER]: ['*.atlassian.example'],
  }),
};

let n: TestNode;
let integrator: string;
beforeAll(async () => {
  n = await testNode(ENV);
  await n.req({
    method: 'POST',
    url: '/v1/users',
    payload: {
      email: 'integ@example.com',
      displayName: 'I',
      password: 'long-password-1',
      globalRoles: ['integrator'],
    },
  });
  integrator = await n.login('integ@example.com', 'long-password-1');
});
afterAll(async () => n.close());

const base = {
  transport: 'stdio',
  command: JIRA,
  args: ['--x'],
  env: { A: '1', B: '2' },
  egress: ['api.jira.example'],
  telemetry: { propagate: true },
};

describe('repointing a stdio connection that has propagation on', () => {
  it('needs the admin for command, args, env, envSecrets and egress, not for an unchanged save', async () => {
    const id = (
      await n.req({
        method: 'POST',
        url: '/v1/connections',
        payload: { name: 'stdio-prop', config: base },
      })
    ).json().id as string;
    const put = (token: string | undefined, config: unknown) =>
      n.req({
        method: 'PUT',
        url: `/v1/connections/${id}`,
        ...(token ? { token } : {}),
        payload: { config },
      });
    // Unchanged (also with the keys in another order): nothing new is exposed.
    expect(
      (
        await put(integrator, {
          telemetry: { propagate: true },
          egress: ['api.jira.example'],
          env: { B: '2', A: '1' },
          args: ['--x'],
          command: JIRA,
          transport: 'stdio',
        })
      ).statusCode,
    ).toBe(200);
    const changes: Record<string, unknown>[] = [
      { command: OTHER, egress: ['*.atlassian.example'] },
      { args: ['--y'] },
      { env: { A: '1', B: '2', C: '3' } },
      { envSecrets: { TOKEN: 'some-secret' } },
      { egress: ['*.atlassian.example'] },
    ];
    for (const change of changes) {
      const res = await put(integrator, { ...base, ...change });
      expect(res.statusCode, JSON.stringify(change)).toBe(403);
    }
    // The admin may do the same.
    expect((await put(undefined, { ...base, args: ['--y'] })).statusCode).toBe(200);
  });
});
