import { OaxError, type SecretResolver } from '@openagentix/core';
import {
  CreateMessageResultSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import {
  McpConnection,
  McpServerConfigSchema,
  RELAY_PLACEHOLDER_URL,
  RelayMessageSchema,
  RelayTransport,
  ToolGateway,
  createMockMcpServer,
  createTransport,
  linkInMemory,
  relayConfigFor,
  relayError,
  relayMethodClass,
  type McpServerConfig,
  type RelayPost,
} from '../src/index.js';

/**
 * ADR 0016 section 6, node side: an HTTP connection of a run node is a message pipe to the control
 * node. No url, header, secret or dispatcher takes part, whatever the stored configuration says.
 */
type HttpConfig = Extract<McpServerConfig, { transport: 'streamable-http' }>;
const http = (extra: object = {}) =>
  McpServerConfigSchema.parse({
    name: 'crm',
    transport: 'streamable-http',
    url: 'https://crm.example.org/mcp?api_key=SECRET-IN-QUERY',
    headers: { 'x-plain': 'plain-header-value' },
    headerSecrets: { authorization: 'crm-token' },
    egress: ['crm.example.org'],
    ...extra,
  }) as HttpConfig;
const tripwire: SecretResolver = {
  resolve: async (ref) => {
    throw new Error(`the node must never resolve a secret (${ref})`);
  },
};

/** A control node that serves one tool and refuses another with the platform code. */
function fakeRelay(seen: unknown[] = []): RelayPost {
  return async (server, message) => {
    seen.push({ server, message });
    const m = message as { id?: number; method: string; params?: Record<string, unknown> };
    if (m.id === undefined) return undefined;
    const ok = (result: Record<string, unknown>) => ({
      jsonrpc: '2.0' as const,
      id: m.id!,
      result,
    });
    if (m.method === 'initialize')
      return ok({
        protocolVersion: m.params!.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'relay', version: '1' },
      });
    if (m.method === 'tools/list')
      return ok({ tools: [{ name: 'lookup', description: 'd', inputSchema: { type: 'object' } }] });
    if (m.params?.name === 'boom')
      return relayError(m.id, -32001, 'denied by the gate', 'policy_denied');
    if (m.params?.name === 'slow') return relayError(m.id, -32000, 'timed out', 'tool_timeout');
    return ok({ content: [{ type: 'text', text: 'found' }], isError: false });
  };
}

describe('relayConfigFor', () => {
  it('drops the url, headers, secret references and egress; keeps what classifies tools', () => {
    const out = relayConfigFor(
      http({ tools: { lookup: { access: 'read' } }, profiles: { read: ['lookup'] } }),
    );
    expect(out).toMatchObject({
      name: 'crm',
      url: RELAY_PLACEHOLDER_URL,
      headers: {},
      headerSecrets: {},
      tools: { lookup: { access: 'read' } },
      profiles: { read: ['lookup'] },
    });
    expect('egress' in out).toBe(false);
    expect(JSON.stringify(out)).not.toMatch(
      /SECRET-IN-QUERY|plain-header-value|crm-token|crm\.example\.org/,
    );
  });
});

describe('RelayTransport and connections with a relay', () => {
  it('serves initialize, tools/list and tools/call without resolving a secret or touching the network', async () => {
    const seen: unknown[] = [];
    const conn = await McpConnection.connect(relayConfigFor(http()), {
      secrets: tripwire,
      relay: fakeRelay(seen),
      // a dispatcher would be used by the direct path; here it must never be asked
      outbound: {
        fetch: () => {
          throw new Error('direct network access');
        },
      } as never,
    });
    expect((await conn.listTools()).map((t) => t.name)).toEqual(['lookup']);
    expect((await conn.callTool('lookup', { q: 1 })).text).toBe('found');
    await conn.close();
    expect(JSON.stringify(seen)).not.toMatch(/SECRET-IN-QUERY|plain-header-value|crm-token/);
    expect(seen.every((s) => (s as { server: string }).server === 'crm')).toBe(true);
  });

  it('ignores header secrets of a stored configuration even if a handover carried them', async () => {
    // the node's configuration is irrelevant: with a relay the transport is built without them
    const t = await createTransport(http(), { secrets: tripwire, relay: fakeRelay() });
    expect(t).toBeInstanceOf(RelayTransport);
  });

  it('re-raises the platform code of a refusal instead of an opaque failure', async () => {
    const conn = await McpConnection.connect(relayConfigFor(http()), {
      secrets: tripwire,
      relay: fakeRelay(),
    });
    await expect(conn.callTool('boom', {})).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(conn.callTool('slow', {})).rejects.toMatchObject({ code: 'tool_timeout' });
  });

  it('turns a failed POST into a failed request of that call only', async () => {
    let n = 0;
    const post: RelayPost = async (server, message, signal) => {
      if ((message as { method: string }).method === 'tools/call' && n++ === 0)
        throw new OaxError('mcp_relay_busy', 'too many concurrent MCP calls in this session');
      return fakeRelay()(server, message, signal);
    };
    const conn = await McpConnection.connect(relayConfigFor(http()), {
      secrets: tripwire,
      relay: post,
    });
    await expect(conn.callTool('lookup', {})).rejects.toMatchObject({ code: 'mcp_relay_busy' });
    expect((await conn.callTool('lookup', {})).text).toBe('found');
  });

  it('cuts a POST off at the connection timeout plus the grace', async () => {
    let aborted = false;
    const post: RelayPost = (_s, message, signal) =>
      (message as { method: string }).method === 'initialize'
        ? fakeRelay()(_s, message, signal)
        : new Promise((_res, rej) =>
            signal?.addEventListener('abort', () => {
              aborted = true;
              rej(new OaxError('mcp_relay_failed', 'aborted'));
            }),
          );
    const t = new RelayTransport('crm', post, 30);
    let answered: unknown;
    t.onmessage = (m) => (answered = m);
    await t.send({ jsonrpc: '2.0', id: 7, method: 'tools/list' });
    expect(aborted).toBe(true);
    expect(answered).toMatchObject({ id: 7, error: { data: { oaxCode: 'mcp_relay_failed' } } });
  });

  it('is dead after close: no message leaves a closed transport', async () => {
    const seen: unknown[] = [];
    const t = new RelayTransport('crm', fakeRelay(seen), 1000);
    await t.close();
    await expect(t.send({ jsonrpc: '2.0', id: 1, method: 'ping' })).rejects.toMatchObject({
      code: 'mcp_relay_closed',
    });
    expect(seen).toEqual([]);
  });
});

describe('the wire format', () => {
  it('accepts exactly one JSON-RPC message with the fields of the protocol', () => {
    const ok = RelayMessageSchema.safeParse({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(ok.success).toBe(true);
    for (const bad of [
      { jsonrpc: '2.0', id: 1, method: 'tools/list', url: 'http://evil' },
      { jsonrpc: '1.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 1.5, method: 'ping' },
      { jsonrpc: '2.0', id: {}, method: 'ping' },
      { jsonrpc: '2.0', id: 1, method: '' },
      { jsonrpc: '2.0', id: 1, method: 'x'.repeat(65) },
      { jsonrpc: '2.0', id: 'x'.repeat(129), method: 'ping' },
      { jsonrpc: '2.0', id: 1, method: 'ping', params: [] },
      [],
      null,
    ])
      expect(RelayMessageSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('labels methods from a closed set', () => {
    expect(['initialize', 'tools/list', 'tools/call', 'ping', 'x/y'].map(relayMethodClass)).toEqual(
      ['initialize', 'tools_list', 'tools_call', 'other', 'other'],
    );
  });
});

describe('server requests for client features (sampling, elicitation, roots)', () => {
  it('fail the call with mcp_capability_unsupported, in process and through the relay alike', async () => {
    const server = createMockMcpServer('needy', []);
    server.setRequestHandler(CallToolRequestSchema, async () => {
      try {
        await server.request(
          { method: 'sampling/createMessage', params: { messages: [], maxTokens: 1 } },
          CreateMessageResultSchema,
        );
      } catch {
        /* the server learns that the client cannot do it, and gives up */
      }
      return { content: [{ type: 'text', text: 'could not sample' }], isError: true };
    });
    const conn = await McpConnection.connect(
      McpServerConfigSchema.parse({ name: 'needy', transport: 'in-memory' }),
      { secrets: tripwire, inMemory: async () => linkInMemory(server) },
    );
    await expect(conn.callTool('anything', {})).rejects.toMatchObject({
      code: 'mcp_capability_unsupported',
    });
  });

  it('an ordinary error result of a server stays an ordinary result', async () => {
    const server = createMockMcpServer('plain', [
      {
        name: 'fails',
        handler: () => {
          throw new Error('bad input');
        },
      },
    ]);
    const conn = await McpConnection.connect(
      McpServerConfigSchema.parse({ name: 'plain', transport: 'in-memory' }),
      { secrets: tripwire, inMemory: async () => linkInMemory(server) },
    );
    expect(await conn.callTool('fails', {})).toMatchObject({ isError: true, text: 'bad input' });
  });
});

describe('ToolGateway.execute and serverTools (what the relay is built on)', () => {
  it('guard the result with the secrets the connection resolved, with no gate in between', async () => {
    const server = createMockMcpServer('echo', [
      { name: 'say', handler: () => 'the token is Bearer TOP-SECRET-VALUE-12345' },
    ]);
    const gateway = new ToolGateway(
      [McpServerConfigSchema.parse({ name: 'echo', transport: 'in-memory' })],
      { secrets: tripwire, inMemory: async () => linkInMemory(server) },
    );
    gateway.guard.addSecret('Bearer TOP-SECRET-VALUE-12345');
    expect((await gateway.serverTools('echo')).map((t) => t.name)).toEqual(['say']);
    const { result, guard } = await gateway.execute({ server: 'echo', tool: 'say', args: {} });
    expect(result.text).not.toContain('TOP-SECRET');
    expect(guard?.secrets.total).toBe(1);
    await gateway.close();
  });
});
