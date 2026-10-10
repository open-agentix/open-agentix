import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  EgressPolicy,
  NetworkConfigSchema,
  StaticSecretResolver,
  compileNetwork,
  parseAllowlist,
} from '@openagentix/core';
import { createOutboundDispatcher, type OutboundDispatcher } from '@openagentix/providers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  McpConnection,
  McpServerConfigSchema,
  ToolGateway,
  createMcpFetch,
  createMockMcpServer,
  createTransport,
  categorizeMcpError,
  testMcpServer,
  type ConnectDeps,
  type McpServerConfig,
} from '../src/index.js';

/**
 * ADR 0016 S1 abuse suite: HTTP MCP requests leave through the outbound dispatcher (purpose `mcp`).
 * Real sockets are used where the property is "nothing was contacted"; the destination of every
 * test is either a local server this file started or a name that a fake resolver maps to an
 * address (no external network).
 */
const SECRET = 'sekrit-token-4711';
const secrets = new StaticSecretResolver({ 'api-auth': SECRET });
const http = (over: Record<string, unknown>) =>
  McpServerConfigSchema.parse({
    name: 'remote',
    transport: 'streamable-http',
    url: 'https://mcp.vendor.example/mcp',
    headerSecrets: { authorization: 'api-auth' },
    ...over,
  }) as Extract<McpServerConfig, { transport: 'streamable-http' }>;

const toLookup = (map: Record<string, string[] | (() => string[])>) => async (host: string) => {
  const v = map[host];
  if (!v) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  return (typeof v === 'function' ? v() : v).map((address) => ({ address }));
};

const servers: HttpServer[] = [];
const dispatchers: OutboundDispatcher[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
  await Promise.all(dispatchers.splice(0).map((d) => d.close()));
});
const dispatcher = (opts: Parameters<typeof createOutboundDispatcher>[0] = {}) => {
  const d = createOutboundDispatcher({ env: {}, allowPlainHttpForPlatform: true, ...opts });
  dispatchers.push(d);
  return d;
};

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const hits: string[] = [];
  const s = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    handler(req, res);
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { hits, port: (s.address() as AddressInfo).port };
}

/** A stateless streamable-HTTP MCP server (one tool with a description we must never leak). */
async function mcpServer(status?: number) {
  return listen((req, res) => {
    if (status) {
      res.writeHead(status, { 'content-type': 'text/plain' }).end('server says: secret body');
      return;
    }
    const server = createMockMcpServer('srv', [
      { name: 'ping', description: 'PRIVATE-DESCRIPTION', handler: () => 'pong' },
    ]);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => void transport.close());
    void server.connect(transport).then(() => transport.handleRequest(req, res));
  });
}

describe('destination rules at connect time (tenant servers)', () => {
  it.each([
    ['cloud metadata (IPv4 literal)', 'https://169.254.169.254/mcp', {}],
    ['metadata, decimal spelling', 'https://2852039166/mcp', {}],
    ['metadata, hex spelling', 'https://0xa9fea9fe/mcp', {}],
    ['metadata, octal spelling', 'https://0251.0376.0251.0376/mcp', {}],
    ['metadata, IPv6 mapped', 'https://[::ffff:169.254.169.254]/mcp', {}],
    ['metadata, IPv6 (AWS)', 'https://[fd00:ec2::254]/mcp', {}],
    ['metadata name', 'https://metadata.google.internal/mcp', {}],
    ['private 10/8', 'https://10.1.2.3/mcp', {}],
    ['private 192.168/16', 'https://192.168.0.10/mcp', {}],
    ['private 172.16/12', 'https://172.16.5.5/mcp', {}],
    ['loopback literal', 'https://127.0.0.1/mcp', {}],
    ['loopback, short spelling', 'https://127.1/mcp', {}],
    ['loopback IPv6', 'https://[::1]/mcp', {}],
    ['localhost', 'https://localhost/mcp', {}],
    ['subdomain of localhost', 'https://api.localhost/mcp', {}],
    ['plain http', 'http://mcp.vendor.example/mcp', {}],
  ])('refuses %s without any connection', async (_label, url) => {
    const d = dispatcher();
    const lookup = vi.fn(toLookup({ 'mcp.vendor.example': ['93.184.216.34'] }));
    const err = await McpConnection.connect(http({ url }), {
      secrets,
      outbound: d,
      originFor: () => 'tenant',
      lookup,
    }).catch((e: unknown) => e);
    expect(categorizeMcpError(err).category).toBe('egress_denied');
    // Refused by name or literal address before any lookup, never by "trying and seeing".
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    ['private', ['10.0.0.8']],
    ['loopback', ['127.0.0.1']],
    ['metadata', ['169.254.169.254']],
    ['IPv4-mapped IPv6 private', ['::ffff:10.0.0.8']],
    ['NAT64 of a private address', ['64:ff9b::a00:8']],
    ['one public and one private answer', ['93.184.216.34', '10.0.0.8']],
  ])('refuses a name that resolves to %s and never opens a socket', async (_l, answers) => {
    const target = await mcpServer();
    const d = dispatcher();
    // The name maps to a real local listener: if the address check were skipped we would connect.
    const lookup = toLookup({ 'rebind.example': answers });
    const err = await McpConnection.connect(
      http({ url: `https://rebind.example:${target.port}/mcp` }),
      { secrets, outbound: d, originFor: () => 'tenant', lookup },
    ).catch((e: unknown) => e);
    expect(categorizeMcpError(err).category).toBe('egress_denied');
    expect(target.hits).toEqual([]);
  });

  it('does not rebind: the address that was checked is the address that is dialled', async () => {
    const target = await mcpServer();
    const d = dispatcher();
    let calls = 0;
    // First answer would be public, every later answer points at the local listener. A client
    // that resolves again after its check (check-then-connect) would end up on 127.0.0.1.
    const lookup = toLookup({
      'rebind.example': () => (++calls === 1 ? ['93.184.216.34'] : ['127.0.0.1']),
    });
    const err = await McpConnection.connect(
      http({ url: `https://rebind.example:${target.port}/mcp`, timeoutMs: 1500 }),
      { secrets, outbound: d, originFor: () => 'tenant', lookup },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(target.hits).toEqual([]);
    // One resolution per connection attempt (the pinned one), not one for the check and one more.
    expect(calls).toBeLessThanOrEqual(2);
  });

  it('refuses a redirect to another host and sends nothing there', async () => {
    const internal = await listen((_req, res) => res.writeHead(200).end('internal'));
    const front = await listen((_req, res) =>
      res.writeHead(307, { location: `http://127.0.0.1:${internal.port}/admin` }).end(),
    );
    const d = dispatcher();
    await expect(
      McpConnection.connect(http({ url: `http://127.0.0.1:${front.port}/mcp`, timeoutMs: 2000 }), {
        secrets,
        outbound: d,
        originFor: () => 'platform',
      }),
    ).rejects.toThrow();
    expect(front.hits.length).toBeGreaterThan(0);
    expect(internal.hits).toEqual([]);
  });

  it('refuses a redirect to the same host as well (redirect: error)', async () => {
    const front = await listen((_req, res) => res.writeHead(302, { location: '/other' }).end());
    const d = dispatcher();
    await expect(
      McpConnection.connect(http({ url: `http://127.0.0.1:${front.port}/mcp`, timeoutMs: 2000 }), {
        secrets,
        outbound: d,
        originFor: () => 'platform',
      }),
    ).rejects.toThrow();
    expect(front.hits).toHaveLength(1);
  });
});

describe('the request URL is limited to the origin of the connection', () => {
  it.each([
    'https://evil.example/mcp',
    'https://mcp.vendor.example:8443/mcp',
    'http://mcp.vendor.example/mcp',
    'https://user:pw@mcp.vendor.example/mcp',
    'https://mcp.vendor.example.evil.example/mcp',
  ])('rejects %s with mcp_egress_denied before the dispatcher is asked', async (url) => {
    const fetch = vi.fn();
    const outbound = { fetch } as unknown as OutboundDispatcher;
    const f = createMcpFetch(http({}), { outbound, originFor: () => 'tenant' });
    await expect(f(url)).rejects.toMatchObject({ code: 'mcp_egress_denied' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('allows other paths of the same origin and sends them as purpose mcp / tenant scope', async () => {
    const fetch = vi.fn(async () => new Response('{}'));
    const outbound = { fetch } as unknown as OutboundDispatcher;
    const f = createMcpFetch(http({}), { outbound, originFor: () => 'tenant' });
    await f('https://MCP.vendor.example:443/other/path', { method: 'POST' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const args = fetch.mock.calls[0] as unknown as [URL, RequestInit, Record<string, unknown>];
    expect(args[2]).toMatchObject({ purpose: 'mcp', scope: { origin: 'tenant' } });
  });

  it('treats a server of unknown origin as tenant defined (fail closed)', async () => {
    const fetch = vi.fn(async () => new Response('{}'));
    const outbound = { fetch } as unknown as OutboundDispatcher;
    await createMcpFetch(http({}), { outbound })('https://mcp.vendor.example/mcp');
    expect((fetch.mock.calls[0] as unknown as unknown[])[2]).toMatchObject({
      scope: { origin: 'tenant' },
    });
  });

  it('every request of the SDK transport goes through the dispatcher with redirect error', async () => {
    const calls: { url: string; init: Record<string, unknown> }[] = [];
    const routes: { purpose: string; decision: string; target?: unknown }[] = [];
    const d = dispatcher({
      fetchImpl: async (url, init) => {
        calls.push({ url, init: init as Record<string, unknown> });
        return new Response('no', { status: 500 });
      },
      onRoute: (a) => routes.push(a),
    });
    await McpConnection.connect(http({ timeoutMs: 1500 }), {
      secrets,
      outbound: d,
      originFor: () => 'tenant',
    }).catch(() => undefined);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.init.redirect).toBe('error');
      expect(c.url.startsWith('https://mcp.vendor.example/')).toBe(true);
    }
    expect(routes.every((r) => r.purpose === 'mcp')).toBe(true);
    expect(JSON.stringify(routes)).not.toContain(SECRET);
  });
});

describe('headers cannot override what the platform sets', () => {
  it.each([
    'Host',
    'content-length',
    'Transfer-Encoding',
    'connection',
    'upgrade',
    'proxy-authorization',
    'x-forwarded-for',
    'cookie',
    'mcp-session-id',
    'mcp-protocol-version',
    'accept',
    'content-type',
    'traceparent',
    'x-oax-run-token',
  ])('refuses the plain header %s', async (name) => {
    await expect(
      createTransport(http({ headers: { [name]: 'x' } }), { secrets }),
    ).rejects.toMatchObject({ code: 'mcp_header_forbidden' });
  });

  it('refuses the same header as plain value and as secret (one would override the other)', async () => {
    await expect(
      createTransport(http({ headers: { Authorization: 'plain' } }), { secrets }),
    ).rejects.toMatchObject({ code: 'mcp_header_forbidden' });
  });

  it('refuses control characters in a secret-backed header value without echoing it', async () => {
    const evil = new StaticSecretResolver({ 'api-auth': 'ok\r\nX-Injected: 1' });
    const err = await createTransport(http({}), { secrets: evil }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'mcp_header_forbidden' });
    expect(String((err as Error).message)).not.toContain('Injected');
  });

  it('refuses credentials and fragments in the url', async () => {
    await expect(
      createTransport(http({ url: 'https://u:p@mcp.vendor.example/mcp' }), { secrets }),
    ).rejects.toMatchObject({ code: 'mcp_url_invalid' });
  });

  it('accepts the normal case: a secret-backed authorization header', async () => {
    await expect(createTransport(http({}), { secrets })).resolves.toBeDefined();
  });
});

describe('secrets never show up in errors or in the routing audit', () => {
  it('a refused destination does not leak the header secret', async () => {
    const audits: unknown[] = [];
    const d = dispatcher({ onRoute: (a) => audits.push(a) });
    const gw = new ToolGateway([http({ url: 'https://10.0.0.5/mcp' })], {
      secrets,
      outbound: d,
      originFor: () => 'tenant',
    });
    const err = await gw
      .exposedTools({ id: 'a', tools: [{ server: 'remote', tool: '*' }] } as never)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(JSON.stringify([String((err as Error).message), audits])).not.toContain(SECRET);
    await gw.close();
  });
});

describe('air-gapped mode fails closed', () => {
  const net = compileNetwork(NetworkConfigSchema.parse({}), {
    egress: new EgressPolicy({ airgapped: true, allow: parseAllowlist('mcp.internal.example') }),
  });
  it.each([
    ['tenant', 'https://tools.vendor.example/mcp'],
    ['platform', 'https://tools.vendor.example/mcp'],
    ['platform', 'http://tools.vendor.example/mcp'],
  ] as const)('refuses a %s server outside the allowlist (%s)', async (origin, url) => {
    const fetchImpl = vi.fn(async () => new Response('{}'));
    const d = dispatcher({ network: net, fetchImpl });
    const err = await McpConnection.connect(http({ url }), {
      secrets,
      outbound: d,
      originFor: () => origin,
    }).catch((e: unknown) => e);
    expect(categorizeMcpError(err).category).toBe('egress_denied');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('connection test returns categories only', () => {
  const deps = (d: OutboundDispatcher, over: Partial<ConnectDeps> = {}): ConnectDeps => ({
    secrets,
    outbound: d,
    originFor: () => 'platform',
    ...over,
  });

  it('ok: counts the tools, leaks no name, description or body', async () => {
    const srv = await mcpServer();
    const r = await testMcpServer(
      http({ url: `http://127.0.0.1:${srv.port}/mcp` }),
      deps(dispatcher()),
    );
    expect(r).toMatchObject({ ok: true, category: 'ok', toolCount: 1 });
    expect(Object.keys(r).sort()).toEqual(['category', 'latency', 'ok', 'toolCount']);
    expect(JSON.stringify(r)).not.toMatch(/ping|PRIVATE-DESCRIPTION|pong/);
  });

  it.each([
    [401, 'auth_failed'],
    [403, 'auth_failed'],
    [404, 'http_error'],
    [503, 'http_error'],
  ])('HTTP %s is %s, status class only, body not echoed', async (status, category) => {
    const srv = await mcpServer(status);
    const r = await testMcpServer(
      http({ url: `http://127.0.0.1:${srv.port}/mcp` }),
      deps(dispatcher()),
    );
    expect(r).toMatchObject({ ok: false, category });
    expect(JSON.stringify(r)).not.toContain('secret body');
    if (category === 'http_error') expect(r.httpClass).toBe(status >= 500 ? '5xx' : '4xx');
  });

  it('a server that does not speak MCP is a protocol error', async () => {
    const srv = await listen((_req, res) =>
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"not":"mcp"}'),
    );
    const r = await testMcpServer(
      http({ url: `http://127.0.0.1:${srv.port}/mcp` }),
      deps(dispatcher()),
    );
    expect(r).toMatchObject({ ok: false });
    expect(['protocol_error', 'error']).toContain(r.category);
  });

  it('a whole test is bounded even when every single request stays under its timeout', async () => {
    // The server accepts the request and never answers; the per-request timeout is far away.
    const srv = await listen((_req, res) => void setTimeout(() => res.destroy(), 3_000));
    const t0 = Date.now();
    const r = await testMcpServer(
      http({ url: `http://127.0.0.1:${srv.port}/mcp`, timeoutMs: 60_000 }),
      deps(dispatcher()),
      Date.now,
      300,
    );
    expect(r).toMatchObject({ ok: false, category: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('a closed port is connect_failed', async () => {
    const srv = await listen((_q, res) => res.end());
    const port = srv.port;
    await new Promise((r) => servers.pop()!.close(() => r(null)));
    const r = await testMcpServer(
      http({ url: `http://127.0.0.1:${port}/mcp` }),
      deps(dispatcher()),
    );
    expect(r.category).toBe('connect_failed');
  });

  it('a private destination of a tenant is egress_denied (no oracle for what exists behind it)', async () => {
    const d = dispatcher();
    const a = await testMcpServer(
      http({ url: 'https://10.0.0.5/mcp' }),
      deps(d, { originFor: () => 'tenant' }),
    );
    const b = await testMcpServer(
      http({ url: 'https://169.254.169.254/latest' }),
      deps(d, { originFor: () => 'tenant' }),
    );
    const c = await testMcpServer(
      http({ url: 'https://internal.example/mcp' }),
      deps(d, {
        originFor: () => 'tenant',
        lookup: toLookup({ 'internal.example': ['10.9.9.9'] }),
      }),
    );
    for (const r of [a, b, c]) expect(r).toMatchObject({ ok: false, category: 'egress_denied' });
  });

  it('an unresolvable name is egress_denied or dns_failed, never a hint about the network', async () => {
    const r = await testMcpServer(
      http({ url: 'https://nx.example/mcp' }),
      deps(dispatcher(), { originFor: () => 'tenant', lookup: toLookup({}) }),
    );
    expect(['egress_denied', 'dns_failed']).toContain(r.category);
  });
});
