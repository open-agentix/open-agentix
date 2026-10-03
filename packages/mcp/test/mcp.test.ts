import { fileURLToPath } from 'node:url';
import { StaticSecretResolver, ToolGrantSchema, type PolicyContext } from '@openagentix/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  McpConnection,
  McpServerConfigSchema,
  ToolGateway,
  createMockMcpServer,
  createTransport,
  cveDbServer,
  demoServerFactories,
  inMemoryServers,
  linkInMemory,
  localPolicyGate,
  modelToolName,
  renderToolResult,
  ticketsServer,
  type GatewayCallResult,
  type Ticket,
} from '../src/index.js';

const secrets = new StaticSecretResolver({ 'echo-token': 'tok', 'api-auth': 'Bearer x' });
const cfg = (o: object) => McpServerConfigSchema.parse(o);

const ctx = (tools: unknown[]): PolicyContext => ({
  definition: { classification: 'internal' },
  agent: { id: 'a', tools: tools.map((t) => ToolGrantSchema.parse(t)) },
});

const gateways: ToolGateway[] = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((g) => g.close()));
});

function demoGateway(store = new Map<string, Ticket>(), extra: object = {}) {
  const g = new ToolGateway(
    [
      cfg({ name: 'cve-db', transport: 'in-memory' }),
      cfg({ name: 'tickets', transport: 'in-memory', maxResultBytes: 4096, ...extra }),
    ],
    { secrets, inMemory: inMemoryServers(demoServerFactories(store)) },
  );
  gateways.push(g);
  return g;
}

describe('ToolGateway', () => {
  it('exposes only granted tools', async () => {
    const g = demoGateway();
    const tools = await g.exposedTools(
      ctx([
        { server: 'tickets', tool: 'add_comment' },
        { server: 'cve-db', tool: '*' },
      ]).agent,
    );
    expect(tools.map((t) => t.modelName).sort()).toEqual([
      'cve-db__lookup_cve',
      'tickets__add_comment',
    ]);
    // cached listing
    expect(
      await g.exposedTools(ctx([{ server: 'cve-db', tool: 'lookup_cve' }]).agent),
    ).toHaveLength(1);
  });

  it('checks the policy before calling and returns results', async () => {
    const store = new Map<string, Ticket>();
    const g = demoGateway(store);
    const policy = ctx([
      {
        server: 'cve-db',
        tool: 'lookup_cve',
        args: { cveId: { type: 'string', pattern: '^CVE-' } },
      },
      { server: 'tickets', tool: 'update_ticket', approval: 'required', allowAdditionalArgs: true },
    ]);
    const gate = localPolicyGate(policy);
    const ok = await g.call(
      { server: 'cve-db', tool: 'lookup_cve', args: { cveId: 'CVE-2024-3094' } },
      gate,
    );
    expect(ok.status).toBe('ok');
    expect(
      JSON.parse((ok as Extract<GatewayCallResult, { status: 'ok' }>).result.text),
    ).toMatchObject({ severity: 'CRITICAL' });
    const notFound = await g.call(
      { server: 'cve-db', tool: 'lookup_cve', args: { cveId: 'CVE-0000-0' } },
      gate,
    );
    expect(notFound.status === 'ok' && notFound.result.isError).toBe(true);
    const denied = await g.call(
      { server: 'tickets', tool: 'delete_ticket', args: { key: 'SEC-1' } },
      gate,
    );
    expect(denied.status).toBe('denied');
    const pending = await g.call(
      { server: 'tickets', tool: 'update_ticket', args: { key: 'SEC-1', status: 'done' } },
      gate,
    );
    expect(pending.status).toBe('approval_required');
    expect(store.size).toBe(0);
    const approved = await g.call(
      { server: 'tickets', tool: 'update_ticket', args: { key: 'SEC-1', status: 'done' } },
      gate,
      { approved: true },
    );
    expect(approved.status).toBe('ok');
    expect(store.get('SEC-1')?.status).toBe('done');
  });

  it('fails clearly for unknown servers and missing in-memory factories', async () => {
    const g = demoGateway();
    await expect(
      g.call(
        { server: 'nope', tool: 'x', args: {} },
        { decide: async () => ({ effect: 'allow', reasons: [], grant: null }) },
      ),
    ).rejects.toThrow(/not configured/);
    const bare = new ToolGateway([cfg({ name: 'x', transport: 'in-memory' })], { secrets });
    await expect(bare.exposedTools(ctx([{ server: 'x', tool: 'y' }]).agent)).rejects.toThrow(
      /no in-memory MCP server/,
    );
  });

  it('enforces timeouts', async () => {
    const slow = createMockMcpServer('slow', [
      { name: 'wait', handler: () => 'late', delayMs: 300 },
    ]);
    const conn = await McpConnection.connect(
      cfg({ name: 'slow', transport: 'in-memory', timeoutMs: 50 }),
      { secrets, inMemory: () => linkInMemory(slow) },
    );
    await expect(conn.callTool('wait', {})).rejects.toThrow(/timed out/);
    await conn.close();
  });

  it('wraps other tool failures', async () => {
    const srv = createMockMcpServer('s', [{ name: 'ok', handler: () => ({ a: 1 }) }]);
    const conn = await McpConnection.connect(cfg({ name: 's', transport: 'in-memory' }), {
      secrets,
      inMemory: () => linkInMemory(srv),
    });
    expect((await conn.callTool('missing', {})).isError).toBe(true);
    const ac = new AbortController();
    ac.abort(new Error('cancelled by run'));
    await expect(conn.callTool('ok', {}, ac.signal)).rejects.toThrow(/failed/);
    await conn.close();
  });
});

describe('renderToolResult', () => {
  it('renders blocks and truncates large outputs', () => {
    expect(
      renderToolResult(
        {
          content: [
            { type: 'text', text: 'a' },
            { type: 'image' },
            { type: 'resource', resource: { text: 'r' } },
          ],
        },
        100,
      ),
    ).toMatchObject({ text: 'a\n[image content omitted]\nr', isError: false, truncated: false });
    const big = renderToolResult(
      { content: [{ type: 'text', text: 'x'.repeat(50) }], isError: true },
      10,
    );
    expect(big.truncated).toBe(true);
    expect(big.text).toMatch(/^x{10}\n\[truncated: 50 bytes, limit 10\]$/);
    expect(renderToolResult({ structuredContent: { a: 1 } }, 100)).toMatchObject({
      text: '{"a":1}',
      structured: { a: 1 },
    });
    expect(renderToolResult({}, 10).text).toBe('');
  });
  it('builds model tool names', () => {
    expect(modelToolName('cve-db', 'lookup.cve')).toBe('cve-db__lookup_cve');
  });
});

describe('transports', () => {
  it('spawns stdio servers with only configured env and secret refs', async () => {
    process.env.OAX_TEST_PARENT_SECRET = 'must-not-leak';
    const script = fileURLToPath(new URL('./fixtures/stdio-server.mjs', import.meta.url));
    const conn = await McpConnection.connect(
      cfg({
        name: 'echo',
        transport: 'stdio',
        command: process.execPath,
        args: [script],
        env: { A: '1' },
        envSecrets: { ECHO_TOKEN: 'echo-token' },
      }),
      { secrets },
    );
    expect((await conn.listTools()).map((t) => t.name)).toEqual(['echo']);
    const out = JSON.parse((await conn.callTool('echo', { x: 1 })).text) as Record<string, unknown>;
    expect(out).toEqual({ args: { x: 1 }, token: 'tok', leaked: null });
    await conn.close();
  });

  it('builds streamable-http transports with secret headers (no connect)', async () => {
    const t = await createTransport(
      cfg({
        name: 'remote',
        transport: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        headerSecrets: { authorization: 'api-auth' },
      }),
      { secrets },
    );
    expect(t).toBeInstanceOf(StreamableHTTPClientTransport);
  });
});

describe('demo servers', () => {
  it('cve-db and tickets behave deterministically', async () => {
    const client = new Client({ name: 't', version: '0' });
    await client.connect(await linkInMemory(cveDbServer()));
    const r = await client.callTool({ name: 'lookup_cve', arguments: {} });
    expect(r.isError).toBe(true);
    await client.close();
    const store = new Map<string, Ticket>();
    const t = new Client({ name: 't', version: '0' });
    await t.connect(await linkInMemory(ticketsServer(store)));
    await t.callTool({ name: 'update_ticket', arguments: { key: 'A-1', labels: ['x'] } });
    await t.callTool({ name: 'get_ticket', arguments: { key: 'A-1' } });
    const del = await t.callTool({ name: 'delete_ticket', arguments: { key: 'A-1' } });
    expect(JSON.stringify(del.content)).toContain('true');
    await t.close();
    expect(Object.keys(demoServerFactories())).toEqual(['cve-db', 'tickets']);
    await expect(inMemoryServers({})('x')).rejects.toThrow(/no in-memory/);
  });
});
