import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { StaticSecretResolver, ToolGrantSchema, type PolicyContext } from '@openagentix/core';
import { createOutboundDispatcher, type OutboundDispatcher } from '@openagentix/providers';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MCP_PROTOCOL_VERSIONS,
  McpServerConfigSchema,
  ToolGateway,
  formatTraceparent,
  isTraceparent,
  localPolicyGate,
  traceMetaFor,
  type McpPropagationPolicy,
} from '../src/index.js';
import { ATTRIBUTE_SPECS } from '../../core/src/telemetry/attribute-specs.js';

/**
 * ADR 0015 S8: opt-in trace context propagation to MCP servers. The server is a real HTTP listener
 * that records the raw request (headers and JSON body) of everything the client sends, so the
 * assertions are about the wire, not about our own helpers.
 */
const TRACE = '0af7651916cd43dd8448eb211c80319c';
const SPAN = 'b7ad6b7169203331';
const TP = `00-${TRACE}-${SPAN}-01`;
const ATTACKER = `00-${'f'.repeat(32)}-${'e'.repeat(16)}-01`;

interface Seen {
  headers: Record<string, string | string[] | undefined>;
  body: { method?: string; params?: { name?: string; _meta?: unknown } & Record<string, unknown> };
}

const httpServers: HttpServer[] = [];
const dispatchers: OutboundDispatcher[] = [];
const gateways: ToolGateway[] = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((g) => g.close()));
  await Promise.all(httpServers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
  await Promise.all(dispatchers.splice(0).map((d) => d.close()));
});

/** A stateless streamable-HTTP server; `evil` makes it answer with trace-context lookalikes. */
async function listen(evil = false) {
  const seen: Seen[] = [];
  const s = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? (JSON.parse(raw) as Seen['body']) : {};
      seen.push({ headers: req.headers, body });
      const server = new Server({ name: 'srv', version: '0' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: 'ping', description: 'd', inputSchema: { type: 'object' as const } }],
        ...(evil ? { _meta: { traceparent: ATTACKER, tracestate: 'x=y', baggage: 'k=v' } } : {}),
      }));
      server.setRequestHandler(CallToolRequestSchema, async () => ({
        content: [{ type: 'text', text: 'pong' }],
        ...(evil ? { _meta: { traceparent: ATTACKER, tracestate: 'x=y', baggage: 'k=v' } } : {}),
      }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => void transport.close());
      void server.connect(transport).then(() => transport.handleRequest(req, res, body));
    });
  });
  httpServers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { seen, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/mcp` };
}

const policy: PolicyContext = {
  definition: { classification: 'internal' },
  agent: {
    id: 'a',
    tools: [ToolGrantSchema.parse({ server: 'srv', tool: '*', allowAdditionalArgs: true })],
  },
};

function gateway(
  url: string,
  telemetry: unknown,
  platform: McpPropagationPolicy | undefined,
  extra: Record<string, unknown> = {},
) {
  const outbound = createOutboundDispatcher({ env: {}, allowPlainHttpForPlatform: true });
  dispatchers.push(outbound);
  const g = new ToolGateway(
    [
      McpServerConfigSchema.parse({
        name: 'srv',
        transport: 'streamable-http',
        url,
        headerSecrets: { authorization: 'tok' },
        ...(telemetry === undefined ? {} : { telemetry }),
        ...extra,
      }),
    ],
    {
      secrets: new StaticSecretResolver({ tok: 'Bearer test-token' }),
      outbound,
      originFor: () => 'platform',
      ...(platform ? { tracePropagation: platform } : {}),
    },
  );
  gateways.push(g);
  return g;
}

const callPing = (g: ToolGateway, traceparent: string | undefined = TP) =>
  g.call({ server: 'srv', tool: 'ping', args: { q: 1 } }, localPolicyGate(policy), {
    trace: { traceparent },
  });
const toolCalls = (seen: Seen[]) => seen.filter((s) => s.body.method === 'tools/call');

describe('default: nothing is sent', () => {
  it.each([
    ['no telemetry setting, no platform switch', undefined, undefined],
    ['telemetry.propagate false, platform allow', { propagate: false }, 'allow'],
    ['telemetry {} (defaults), platform allow', {}, 'allow'],
    ['no telemetry setting, platform allow', undefined, 'allow'],
    ['connection opted in, platform unset', { propagate: true }, undefined],
    ['connection opted in, platform deny', { propagate: true }, 'deny'],
  ] as const)('%s', async (_l, telemetry, platform) => {
    const srv = await listen();
    const g = gateway(srv.url, telemetry, platform);
    const r = await callPing(g);
    expect(r.status).toBe('ok');
    const calls = toolCalls(srv.seen);
    expect(calls).toHaveLength(1);
    // The request is byte-for-byte what it was before this slice: no _meta at all.
    expect(calls[0]!.body.params).toEqual({ name: 'ping', arguments: { q: 1 } });
    for (const s of srv.seen) {
      for (const h of ['traceparent', 'tracestate', 'baggage'])
        expect(s.headers[h], `${h} header`).toBeUndefined();
    }
  });

  it('sends nothing when the caller has no trace (tracing off)', async () => {
    const srv = await listen();
    const g = gateway(srv.url, { propagate: true }, 'allow');
    await g.call({ server: 'srv', tool: 'ping', args: {} }, localPolicyGate(policy));
    expect(toolCalls(srv.seen)[0]!.body.params).toEqual({ name: 'ping', arguments: {} });
  });
});

describe('both opt-ins: only the traceparent, in _meta', () => {
  it('sends params._meta.traceparent and nothing else', async () => {
    const srv = await listen();
    const g = gateway(srv.url, { propagate: true }, 'allow');
    const infos: unknown[] = [];
    const r = await g.call(
      { server: 'srv', tool: 'ping', args: { q: 1 } },
      localPolicyGate(policy),
      {
        trace: { traceparent: TP, onPropagated: (i) => void infos.push(i) },
      },
    );
    expect(r.status).toBe('ok');
    const [call] = toolCalls(srv.seen);
    expect(call!.body.params).toEqual({
      name: 'ping',
      arguments: { q: 1 },
      _meta: { traceparent: TP },
    });
    expect(Object.keys(call!.body.params!._meta as object)).toEqual(['traceparent']);
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatchObject({ method: 'tools/call' });
    expect((infos[0] as { protocolVersion?: string }).protocolVersion).toSatisfy(
      (v: string | undefined) => v === undefined || MCP_PROTOCOL_VERSIONS.includes(v as never),
    );
  });

  it('adds no header: the HTTP request carries the same headers with and without propagation', async () => {
    const a = await listen();
    const b = await listen();
    await callPing(gateway(a.url, undefined, undefined));
    await callPing(gateway(b.url, { propagate: true }, 'allow'));
    const names = (s: Seen[]) =>
      Object.keys(toolCalls(s)[0]!.headers)
        .filter((h) => h !== 'host' && h !== 'content-length')
        .sort();
    expect(names(b.seen)).toEqual(names(a.seen));
    for (const h of ['traceparent', 'tracestate', 'baggage', 'x-oax-trace'])
      expect(toolCalls(b.seen)[0]!.headers[h]).toBeUndefined();
  });

  it('does not propagate on initialize or tools/list, only on tools/call', async () => {
    const srv = await listen();
    const g = gateway(srv.url, { propagate: true }, 'allow');
    await g.exposedTools(policy.agent);
    await callPing(g);
    for (const s of srv.seen) {
      const meta = (s.body.params as { _meta?: unknown } | undefined)?._meta;
      if (s.body.method === 'tools/call') expect(meta).toEqual({ traceparent: TP });
      else expect(meta, String(s.body.method)).toBeUndefined();
    }
  });

  it('works for a stdio-less in-memory style config too: telemetry is accepted on every transport', () => {
    for (const cfg of [
      { name: 'a', transport: 'stdio', command: '/bin/true', telemetry: { propagate: true } },
      { name: 'b', transport: 'in-memory', telemetry: { propagate: true } },
    ])
      expect(McpServerConfigSchema.parse(cfg)).toMatchObject({ telemetry: { propagate: true } });
  });

  it('the platform deny wins over an opted-in connection, per call', async () => {
    const srv = await listen();
    const g = gateway(srv.url, { propagate: true }, 'deny');
    await callPing(g);
    expect(toolCalls(srv.seen)[0]!.body.params).toEqual({ name: 'ping', arguments: { q: 1 } });
  });
});

describe('canary: nothing but the traceparent can be added', () => {
  it('a hostile caller-supplied trace value is dropped, never forwarded', async () => {
    const hostile = [
      `${TP}, tracestate=a=b`,
      `${TP}\r\nbaggage: k=v`,
      `${TP}\nx-evil: 1`,
      `01-${TRACE}-${SPAN}-01`,
      `00-${TRACE}-${SPAN}-03`, // other trace flags
      `00-${TRACE}-${SPAN}-01 `,
      ` ${TP}`,
      `00-${'0'.repeat(32)}-${SPAN}-01`,
      `00-${TRACE}-${'0'.repeat(16)}-01`,
      `00-${TRACE.toUpperCase()}-${SPAN}-01`,
      `00-${TRACE}-${SPAN}`,
      '',
    ];
    for (const value of hostile) {
      const srv = await listen();
      const g = gateway(srv.url, { propagate: true }, 'allow');
      await callPing(g, value);
      expect(toolCalls(srv.seen)[0]!.body.params, JSON.stringify(value)).toEqual({
        name: 'ping',
        arguments: { q: 1 },
      });
    }
  });

  it('extra keys on the propagated meta object never reach the wire', async () => {
    const srv = await listen();
    const g = gateway(srv.url, { propagate: true }, 'allow');
    // The connection layer rebuilds _meta from the one validated field.
    const conn = await (
      g as unknown as { connection(s: string): Promise<{ callTool: (...a: unknown[]) => unknown }> }
    ).connection('srv');
    await conn.callTool('ping', {}, undefined, {
      traceparent: TP,
      tracestate: 'a=b',
      baggage: 'k=v',
    });
    expect(toolCalls(srv.seen)[0]!.body.params!._meta).toEqual({ traceparent: TP });
  });

  it.each([
    ['telemetry with an extra key', { propagate: true, tracestate: 'a=b' }],
    ['telemetry with headers', { propagate: true, headers: { traceparent: TP } }],
    ['telemetry with baggage', { propagate: true, baggage: 'k=v' }],
    ['propagate as a string', { propagate: 'true' }],
    ['propagate as a number', { propagate: 1 }],
    ['telemetry as a boolean', true],
    ['telemetry as an array', [{ propagate: true }]],
  ])('the connection schema refuses %s', (_l, telemetry) => {
    const r = McpServerConfigSchema.safeParse({
      name: 'srv',
      transport: 'streamable-http',
      url: 'https://mcp.vendor.example/mcp',
      telemetry,
    });
    expect(r.success).toBe(false);
  });

  it.each(['traceparent', 'TraceParent', 'tracestate', 'baggage'])(
    'a connection cannot carry a "%s" header, plain or secret-backed (S1 list stays)',
    async (header) => {
      const srv = await listen();
      for (const extra of [{ headers: { [header]: TP } }, { headerSecrets: { [header]: 'tok' } }]) {
        const g = gateway(srv.url, { propagate: true }, 'allow', extra);
        // A config that predates the rules fails closed when a run uses it: nothing is sent.
        await expect(callPing(g)).rejects.toMatchObject({ code: 'mcp_header_forbidden' });
      }
      expect(srv.seen).toEqual([]);
    },
  );
});

describe('an untrusted server cannot steer or poison the context', () => {
  it('never becomes a parent: the next call still carries the run own traceparent', async () => {
    const srv = await listen(true);
    const g = gateway(srv.url, { propagate: true }, 'allow');
    const first = await callPing(g);
    expect(first.status).toBe('ok');
    if (first.status === 'ok') expect(JSON.stringify(first.result)).not.toContain(ATTACKER);
    await callPing(g);
    const calls = toolCalls(srv.seen);
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c.body.params!._meta).toEqual({ traceparent: TP });
  });

  it('a pure helper: only the traceparent comes out, and only with both switches', () => {
    expect(traceMetaFor({ telemetry: { propagate: true } }, 'allow', TP)).toEqual({
      traceparent: TP,
    });
    expect(traceMetaFor({ telemetry: { propagate: true } }, 'deny', TP)).toBeUndefined();
    expect(traceMetaFor({ telemetry: { propagate: true } }, undefined, TP)).toBeUndefined();
    expect(traceMetaFor({ telemetry: { propagate: false } }, 'allow', TP)).toBeUndefined();
    expect(traceMetaFor({}, 'allow', TP)).toBeUndefined();
    expect(traceMetaFor({ telemetry: { propagate: true } }, 'allow', 'nope')).toBeUndefined();
  });
});

describe('traceparent format', () => {
  it('accepts exactly the strict version-00 form', () => {
    expect(isTraceparent(TP)).toBe(true);
    expect(isTraceparent(`00-${TRACE}-${SPAN}-00`)).toBe(true);
    expect(isTraceparent(undefined)).toBe(false);
    expect(isTraceparent(42)).toBe(false);
    expect(formatTraceparent(TRACE, SPAN, true)).toBe(TP);
    expect(formatTraceparent(TRACE, SPAN, false)).toBe(`00-${TRACE}-${SPAN}-00`);
    expect(formatTraceparent('x', SPAN, true)).toBeUndefined();
    expect(formatTraceparent('0'.repeat(32), SPAN, true)).toBeUndefined();
  });

  it('the span attribute for the protocol version is a closed set equal to the client list', () => {
    const spec = ATTRIBUTE_SPECS['mcp.protocol.version'] as { enum?: readonly string[] };
    expect([...(spec.enum ?? [])].sort()).toEqual([...MCP_PROTOCOL_VERSIONS].sort());
  });
});
