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
  it('removes hidden characters from a tool result, and reports counts only', async () => {
    const hidden = String.fromCodePoint(0xe0041, 0xe0042);
    const r = await call(gatewayReturning(`Issue body\u200B${hidden}`));
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(r.result.text).toBe('Issue body');
    expect(r.guard?.invisible).toEqual({ total: 3, classes: { zero_width: 1, tag: 2 } });
  });

  it('adds no report for clean results and passes the result through', async () => {
    const r = await call(gatewayReturning('all good'));
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(r.guard).toBeUndefined();
    expect(r.result.text).toBe('all good');
  });

  it('can be switched off for diagnostics', async () => {
    const guard = new ContextGuard({ stripInvisible: false });
    const r = await call(gatewayReturning('a\u200B b', guard));
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(r.result.text).toBe('a\u200B b');
    expect(r.guard).toBeUndefined();
  });
});
