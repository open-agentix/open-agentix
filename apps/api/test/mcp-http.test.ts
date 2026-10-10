import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StaticSecretResolver } from '@openagentix/core';
import { handleMockMcpHttp } from '@openagentix/mcp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectionEndpoints } from '../src/airgap.js';
import { testNode, type TestNode } from './helpers.js';

/**
 * ADR 0016 slice S1: destination rules for HTTP MCP connections when they are saved (abuse suite
 * over every spelling of a forbidden destination), platform-owned headers, air-gapped egress
 * entries and the categorized connection test.
 */
let n: TestNode;
let mcp: Server;
let mcpPort = 0;
const mcpHits: string[] = [];

beforeAll(async () => {
  mcp = createServer((req, res) => {
    mcpHits.push(`${req.method} ${req.url}`);
    void handleMockMcpHttp(req, res, 'srv', [
      { name: 'secret_tool', description: 'PRIVATE-DESCRIPTION', handler: () => 'x' },
    ]);
  });
  await new Promise<void>((r) => mcp.listen(0, '127.0.0.1', () => r()));
  mcpPort = (mcp.address() as AddressInfo).port;
  n = await testNode(
    {},
    {
      secrets: new StaticSecretResolver({ tok: 'sekrit-token-4711' }),
      hostLookup: async (host) => {
        if (host === 'rebinds.example') return [{ address: '10.0.0.7' }];
        return [{ address: '93.184.216.34' }];
      },
    },
  );
});
afterAll(async () => {
  await n.close();
  await new Promise((r) => mcp.close(r));
});

let seq = 0;
const post = (config: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  n.req({
    method: 'POST',
    url: '/v1/connections',
    payload: { name: `c${++seq}`, config: { transport: 'streamable-http', ...config }, ...extra },
  });

describe('destination rules when a tenant connection is saved', () => {
  it.each([
    ['metadata IPv4', 'https://169.254.169.254/latest/meta-data'],
    ['metadata decimal', 'https://2852039166/'],
    ['metadata hex', 'https://0xa9fea9fe/'],
    ['metadata octal', 'https://0251.0376.0251.0376/'],
    ['metadata mixed radix', 'https://169.254.0xa9fe/'],
    ['metadata IPv6 mapped', 'https://[::ffff:169.254.169.254]/'],
    ['metadata IPv6 mapped hex', 'https://[::ffff:a9fe:a9fe]/'],
    ['metadata AWS IPv6', 'https://[fd00:ec2::254]/'],
    ['metadata Azure/GCP name', 'https://metadata.google.internal/computeMetadata/v1/'],
    ['metadata name with trailing dot', 'https://metadata.google.internal./'],
    ['private 10/8', 'https://10.0.0.1/'],
    ['private 172.16/12', 'https://172.31.255.1/'],
    ['private 192.168/16', 'https://192.168.1.1/'],
    ['CGNAT', 'https://100.64.0.1/'],
    ['loopback', 'https://127.0.0.1:8080/'],
    ['loopback short', 'https://127.1/'],
    ['loopback decimal', 'https://2130706433/'],
    ['unspecified', 'https://0.0.0.0/'],
    ['IPv6 loopback', 'https://[::1]/'],
    ['IPv6 unique local', 'https://[fc00::1]/'],
    ['IPv6 link local', 'https://[fe80::1]/'],
    ['localhost', 'https://localhost/'],
    ['localhost subdomain', 'https://x.localhost/'],
    ['localhost upper case', 'https://LOCALHOST/'],
    ['localhost with trailing dot', 'https://localhost./'],
    ['loopback hex dotted', 'https://0x7f.0.0.1/'],
    ['loopback IPv6 mapped hex', 'https://[::ffff:7f00:1]/'],
    ['zero address short', 'https://0/'],
    ['plain http', 'http://mcp.vendor.example/'],
  ])('refuses %s with 422 egress_denied', async (_label, url) => {
    const res = await post({ url });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('egress_denied');
    // the message names the connection and the rule code, never an address of ours
    expect(JSON.stringify(res.json())).not.toContain('sekrit');
  });

  it('refuses a change into a forbidden destination', async () => {
    const ok = await post({ url: 'https://mcp.vendor.example/mcp' });
    expect(ok.statusCode).toBe(201);
    const upd = await n.req({
      method: 'PUT',
      url: `/v1/connections/${ok.json().id}`,
      payload: {
        config: { transport: 'streamable-http', url: 'https://169.254.169.254/latest' },
      },
    });
    expect(upd.statusCode).toBe(422);
    expect(upd.json().error).toBe('egress_denied');
  });

  it('applies to team and agent scope as well', async () => {
    const team = await n.req({
      method: 'POST',
      url: '/v1/teams',
      payload: { slug: 'team-http', name: 'Team' },
    });
    const res = await post(
      { url: 'https://10.0.0.1/' },
      { scope: 'team', scopeId: team.json().id },
    );
    expect(res.statusCode).toBe(422);
  });

  it('accepts a public https server and a platform connection with a private address', async () => {
    expect((await post({ url: 'https://mcp.vendor.example:8443/mcp' })).statusCode).toBe(201);
    expect(
      (await post({ url: 'http://mcp.cluster.local:8080/mcp' }, { scope: 'platform' })).statusCode,
    ).toBe(201);
  });
});

describe('platform-owned headers, credentials in the url, egress entries', () => {
  it.each([
    'Host',
    'Content-Length',
    'transfer-encoding',
    'Mcp-Session-Id',
    'traceparent',
    'x-forwarded-for',
  ])('refuses the header %s', async (name) => {
    const res = await post({
      url: 'https://mcp.vendor.example/mcp',
      headers: { [name]: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('mcp_header_forbidden');
  });

  it('refuses a header set both as plain value and as secret', async () => {
    const res = await post({
      url: 'https://mcp.vendor.example/mcp',
      headers: { authorization: 'Bearer x' },
      headerSecrets: { Authorization: 'tok' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('mcp_header_forbidden');
  });

  it('applies to platform connections too (framing headers are never configuration)', async () => {
    const res = await post(
      { url: 'http://mcp.cluster.local/mcp', headers: { host: 'evil' } },
      { scope: 'platform' },
    );
    expect(res.statusCode).toBe(400);
  });

  it('refuses credentials in the url', async () => {
    const res = await post({ url: 'https://user:pw@mcp.vendor.example/mcp' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('mcp_url_invalid');
    expect(JSON.stringify(res.json())).not.toContain('pw@');
  });

  it('accepts egress entries that repeat the own host and refuses everything else', async () => {
    const url = 'https://mcp.vendor.example/mcp';
    expect(
      (await post({ url, egress: ['mcp.vendor.example', 'mcp.vendor.example:443'] })).statusCode,
    ).toBe(201);
    for (const egress of [
      ['other.example'],
      ['mcp.vendor.example:8443'],
      ['169.254.169.254'],
      ['*.vendor.example'],
      ['10.0.0.0/8'],
      ['https://mcp.vendor.example/'],
    ]) {
      const res = await post({ url, egress });
      expect(res.statusCode, JSON.stringify(egress)).toBe(400);
      expect(res.json().error).toBe('mcp_egress_invalid');
    }
  });
});

describe('air-gapped endpoints include egress entries', () => {
  it('lists the url and every egress entry for the start-up check', () => {
    expect(
      connectionEndpoints('mcp', 'x', {
        transport: 'streamable-http',
        url: 'https://a.example/mcp',
        egress: ['a.example', 'b.example:8443'],
      }).map((e) => e.url),
    ).toEqual(['https://a.example/mcp', 'https://a.example', 'https://b.example:8443']);
  });
});

describe('POST /v1/connections/{id}/test for MCP connections', () => {
  const test = (id: string, token?: string | null) =>
    n.req({
      method: 'POST',
      url: `/v1/connections/${id}/test`,
      payload: {},
      ...(token !== undefined ? { token } : {}),
    });

  it('returns a category, a latency bucket and a tool count, never tool text', async () => {
    const c = await post({ url: `http://127.0.0.1:${mcpPort}/mcp` }, { scope: 'platform' });
    expect(c.statusCode).toBe(201);
    const res = await test(c.json().id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, category: 'ok', toolCount: 1 });
    expect(Object.keys(res.json()).sort()).toEqual(['category', 'latency', 'ok', 'toolCount']);
    expect(res.body).not.toMatch(/secret_tool|PRIVATE-DESCRIPTION/);
    expect(mcpHits.length).toBeGreaterThan(0);
  });

  it('a tenant connection that resolves to a private address is egress_denied and never dialled', async () => {
    const c = await post({ url: 'https://rebinds.example/mcp' });
    expect(c.statusCode).toBe(201);
    const res = await test(c.json().id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, category: 'egress_denied' });
  });

  it('is audited with the category only', async () => {
    const c = await post({ url: 'https://rebinds.example/mcp2' });
    await test(c.json().id);
    const audit = (
      await n.req({ method: 'GET', url: '/v1/audit?action=connection.tested&limit=100' })
    ).json().items as { target: string; payload: Record<string, unknown> }[];
    const entry = audit.find((a) => a.target === c.json().id);
    expect(entry?.payload).toMatchObject({ kind: 'mcp', category: 'egress_denied' });
    expect(JSON.stringify(entry)).not.toMatch(/rebinds|10\.0\.0\.7/);
  });

  it('refuses to test a stdio connection (it would start a process)', async () => {
    const c = await n.req({
      method: 'POST',
      url: '/v1/connections',
      payload: {
        name: 'plain-stdio',
        scope: 'platform',
        config: { transport: 'stdio', command: '/bin/true' },
      },
    });
    expect(c.statusCode).toBe(201);
    const res = await test(c.json().id);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('mcp_test_unsupported');
  });

  it('needs authentication and a known connection', async () => {
    expect((await test('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await test('00000000-0000-4000-8000-000000000000', null)).statusCode).toBe(401);
  });

  it('is rate limited per user', async () => {
    const c = await post({ url: 'https://rebinds.example/mcp3' });
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await test(c.json().id)).statusCode);
    expect(codes).toContain(429);
  });
});

describe('model connection tests still need a model', () => {
  it('rejects a model test without model', async () => {
    const c = await n.req({
      method: 'POST',
      url: '/v1/connections',
      payload: {
        name: 'm1',
        kind: 'model',
        config: { kind: 'openai', baseUrl: 'https://llm.vendor.example/v1', apiKeySecret: 'tok' },
      },
    });
    expect(c.statusCode).toBe(201);
    const res = await n.req({
      method: 'POST',
      url: `/v1/connections/${c.json().id}/test`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
