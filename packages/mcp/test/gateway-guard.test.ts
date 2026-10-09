import { fileURLToPath } from 'node:url';
import {
  ContextGuard,
  StaticSecretResolver,
  ToolGrantSchema,
  type PolicyContext,
} from '@openagentix/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  McpServerConfigSchema,
  ToolGateway,
  createMockMcpServer,
  inMemoryServers,
  localPolicyGate,
} from '../src/index.js';

// Example values only.
const FAKE_TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
const policy: PolicyContext = {
  definition: { classification: 'internal' },
  agent: { id: 'a', tools: [ToolGrantSchema.parse({ server: 'srv', tool: '*' })] },
};

const gateways: ToolGateway[] = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((g) => g.close()));
});

function gatewayReturning(text: string, guard?: ContextGuard) {
  const g = new ToolGateway(
    [McpServerConfigSchema.parse({ name: 'srv', transport: 'in-memory' })],
    {
      secrets: new StaticSecretResolver({}),
      inMemory: inMemoryServers({
        srv: () => createMockMcpServer('srv', [{ name: 'read', handler: () => text }]),
      }),
    },
    ...(guard ? [guard] : []),
  );
  gateways.push(g);
  return g;
}

const call = (g: ToolGateway) =>
  g.call({ server: 'srv', tool: 'read', args: {} }, localPolicyGate(policy));

describe('ToolGateway context guard', () => {
  it('removes hidden characters and secrets from a tool result, and reports counts only', async () => {
    const hidden = String.fromCodePoint(0xe0041, 0xe0042);
    const r = await call(gatewayReturning(`Issue body\u200B${hidden} token ${FAKE_TOKEN}`));
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(r.result.text).toBe('Issue body token [redacted:github-token]');
    expect(r.guard?.invisible).toEqual({ total: 3, classes: { zero_width: 1, tag: 2 } });
    expect(r.guard?.secrets).toEqual({ total: 1, kinds: { 'github-token': 1 } });
    expect(JSON.stringify(r.guard)).not.toContain('ghp_');
  });

  it('adds no report for clean results and passes the result through', async () => {
    const r = await call(gatewayReturning('all good'));
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(r.guard).toBeUndefined();
    expect(r.result.text).toBe('all good');
  });

  it('can be switched off for diagnostics', async () => {
    const guard = new ContextGuard({ stripInvisible: false, redactSecrets: false });
    const r = await call(gatewayReturning(`a\u200B ${FAKE_TOKEN}`, guard));
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(r.result.text).toBe(`a\u200B ${FAKE_TOKEN}`);
    expect(r.guard).toBeUndefined();
  });

  it('replaces a secret that was resolved for the server, whatever its shape', async () => {
    const value = 'plain-secret-value-0123';
    const script = fileURLToPath(new URL('./fixtures/stdio-server.mjs', import.meta.url));
    const g = new ToolGateway(
      [
        McpServerConfigSchema.parse({
          name: 'srv',
          transport: 'stdio',
          command: process.execPath,
          args: [script],
          envSecrets: { ECHO_TOKEN: 'echo-token' },
        }),
      ],
      { secrets: new StaticSecretResolver({ 'echo-token': value }) },
    );
    gateways.push(g);
    const r = await g.call({ server: 'srv', tool: 'echo', args: {} }, localPolicyGate(policy));
    if (r.status !== 'ok') throw new Error('expected ok');
    // The fixture echoes its token; the model must see the placeholder instead.
    expect(r.result.text).not.toContain(value);
    expect(r.result.text).toContain('[redacted:known-secret]');
    expect(r.guard?.secrets.kinds).toEqual({ 'known-secret': 1 });
  });
});
