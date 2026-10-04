import { StaticSecretResolver, ToolGrantSchema, type PolicyContext } from '@openagentix/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  McpServerConfigSchema,
  ToolGateway,
  demoServerFactories,
  inMemoryServers,
  localPolicyGate,
  serveGateHttp,
  type GateHttpHandle,
  type Ticket,
} from '../src/index.js';

let handle: GateHttpHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

async function start(extra: { token?: string; maxBodyBytes?: number } = {}) {
  const store = new Map<string, Ticket>();
  const gateway = new ToolGateway(
    [McpServerConfigSchema.parse({ name: 'tickets', transport: 'in-memory' })],
    {
      secrets: new StaticSecretResolver({}),
      inMemory: inMemoryServers(demoServerFactories(store)),
    },
  );
  const policy: PolicyContext = {
    definition: { classification: 'internal' },
    agent: {
      id: 'a',
      tools: [
        ToolGrantSchema.parse({
          server: 'tickets',
          tool: 'add_comment',
          args: { key: { type: 'string' }, comment: { type: 'string' } },
        }),
      ],
    },
  };
  const seen: string[] = [];
  handle = await serveGateHttp({
    gateway,
    gate: localPolicyGate(policy),
    tools: await gateway.exposedTools(policy.agent),
    onCall: (c, r) => void seen.push(`${c.tool}:${r.status}`),
    ...extra,
  });
  return { store, seen };
}

const post = (url: string, headers: Record<string, string>, body: string, method = 'POST') =>
  fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: method === 'POST' ? body : undefined,
  });

describe('gate over streamable HTTP (MCP bridge)', () => {
  it('serves the gate on loopback to an MCP client with the bearer token', async () => {
    const { store, seen } = await start();
    expect(handle!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const client = new Client({ name: 'harness', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(handle!.url), {
        requestInit: { headers: { Authorization: `Bearer ${handle!.token}` } },
      }),
    );
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['tickets__add_comment']);
    const ok = await client.callTool({
      name: 'tickets__add_comment',
      arguments: { key: 'SEC-1', comment: 'hi' },
    });
    expect(ok.isError).toBe(false);
    const unknown = await client.callTool({
      name: 'tickets__delete_ticket',
      arguments: { key: 'SEC-1' },
    });
    expect(unknown.isError).toBe(true);
    expect(seen).toEqual(['add_comment:ok']);
    expect(store.get('SEC-1')?.comments).toEqual(['hi']);
    await client.close();
  });

  it('rejects missing or wrong tokens, other paths and methods, bad bodies', async () => {
    await start({ token: 'fixed-token', maxBodyBytes: 200 });
    expect(handle!.token).toBe('fixed-token');
    const ping = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect((await post(handle!.url, {}, ping)).status).toBe(401);
    expect((await post(handle!.url, { authorization: 'Bearer nope' }, ping)).status).toBe(401);
    const auth = { authorization: 'Bearer fixed-token' };
    expect((await post(handle!.url.replace('/mcp', '/other'), auth, ping)).status).toBe(404);
    expect((await post(handle!.url, auth, '', 'GET')).status).toBe(405);
    expect((await post(handle!.url, auth, 'not json')).status).toBe(400);
    expect((await post(handle!.url, auth, JSON.stringify({ pad: 'x'.repeat(500) }))).status).toBe(
      400,
    );
    expect((await post(handle!.url, auth, ping)).status).toBe(200);
  });
});
