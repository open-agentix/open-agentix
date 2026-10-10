import { createHmac } from 'node:crypto';
import * as net from 'node:net';
import { EgressPolicy, parseAllowlist } from '@openagentix/core';
import { afterEach, describe, expect, it } from 'vitest';
import { EgressProxy, egressAccount, mintEgressGrant, verifyEgressGrant } from '../src/index.js';

const SECRET = 's'.repeat(40);
let proxy: EgressProxy;
let port: number;
let target: net.Server;
let targetPort: number;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await proxy?.close();
  for (const c of cleanups.splice(0)) await c();
});

async function start(opts: Partial<ConstructorParameters<typeof EgressProxy>[0]> = {}) {
  target = net.createServer((s) => s.end('hello from target'));
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  targetPort = (target.address() as net.AddressInfo).port;
  cleanups.push(async () => void (await new Promise((r) => target.close(r))));
  proxy = new EgressProxy({
    secret: SECRET,
    ceiling: [
      '*.example.com',
      'svc.example.org',
      'api.example.net:8443',
      '203.0.113.0/24',
      'socket-proxy',
      'db.internal',
    ],
    // names resolve to a public-looking address unless a test picks another one
    resolve: async (h) => RESOLVE[h] ?? ['93.184.216.34'],
    connect: () => net.connect({ host: '127.0.0.1', port: targetPort }),
    ...opts,
  });
  port = (await proxy.listen(0, '127.0.0.1')).port;
}
const RESOLVE: Record<string, string[]> = {};

const grant = (egress: string[], nodeId = 'node-1', ttl = 60, secret = SECRET, now?: number) =>
  mintEgressGrant(secret, { nodeId, egress, ttlSeconds: ttl }, now);

/** CONNECT through the proxy; returns the status line and the rest of the stream. */
function connect(
  host: string,
  auth?: { user: string; pass: string },
): Promise<{ status: string; rest: string }> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    let buf = '';
    s.on('data', (d) => (buf += d.toString()));
    s.on('error', reject);
    s.on('close', () => resolve({ status: buf.split('\r\n')[0]!, rest: buf }));
    const a = auth
      ? `Proxy-Authorization: Basic ${Buffer.from(`${auth.user}:${auth.pass}`).toString('base64')}\r\n`
      : '';
    s.write(`CONNECT ${host} HTTP/1.1\r\nHost: ${host}\r\n${a}\r\n`);
    setTimeout(() => s.destroy(), 1500);
  });
}
const as = (egress: string[], nodeId = 'node-1') => ({ user: nodeId, pass: grant(egress, nodeId) });
const FORBIDDEN = 'HTTP/1.1 403 Forbidden';

describe('egress grants', () => {
  it('round-trip, and refuse tampering, other nodes, other secrets and expiry', () => {
    const g = grant(['a.example.com'], 'n1', 60, SECRET, 1_000_000);
    expect(verifyEgressGrant(SECRET, 'n1', g, 1_000_000)).toMatchObject({
      n: 'n1',
      e: ['a.example.com'],
    });
    expect(verifyEgressGrant(SECRET, 'n2', g, 1_000_000)).toBeNull();
    expect(verifyEgressGrant('x'.repeat(40), 'n1', g, 1_000_000)).toBeNull();
    expect(verifyEgressGrant(SECRET, 'n1', g, 1_000_000 + 61_000)).toBeNull();
    const [payload, sig] = g.split('.');
    const forged = Buffer.from(JSON.stringify({ n: 'n1', e: ['*.com'], x: 9e9 })).toString(
      'base64url',
    );
    expect(verifyEgressGrant(SECRET, 'n1', `${forged}.${sig}`, 1_000_000)).toBeNull();
    expect(verifyEgressGrant(SECRET, 'n1', `${payload}`, 1_000_000)).toBeNull();
    expect(verifyEgressGrant(SECRET, 'n1', `${g}.x`, 1_000_000)).toBeNull();
    const garbage = Buffer.from('not json').toString('base64url');
    expect(verifyEgressGrant(SECRET, 'n1', `${garbage}.${sig}`, 1_000_000)).toBeNull();
    expect(() => mintEgressGrant('short', { nodeId: 'n', egress: [], ttlSeconds: 1 })).toThrow(
      /32/,
    );
    expect(() => new EgressProxy({ secret: 'short' })).toThrow(/32/);
    expect(() => new EgressProxy({ secret: SECRET, privateAllow: ['nope'] })).toThrow(
      /invalid private/,
    );
  });
});

describe('egress proxy', () => {
  it('relays bytes to an allowed host and dials the resolved address', async () => {
    const dialed: { host: string; port: number }[] = [];
    await start({
      connect: (t) => (dialed.push(t), net.connect({ host: '127.0.0.1', port: targetPort })),
    });
    const r = await connect('a.example.com:443', as(['*.example.com']));
    expect(r.status).toBe('HTTP/1.1 200 Connection Established');
    expect(r.rest).toContain('hello from target');
    expect(dialed).toEqual([{ host: '93.184.216.34', port: 443 }]);
    expect(proxy.recentDenials()).toHaveLength(0);
  });

  it('defaults to port 443; other ports need an explicit entry', async () => {
    await start();
    expect((await connect('a.example.com:8443', as(['*.example.com']))).status).toBe(FORBIDDEN);
    expect((await connect('api.example.net:8443', as(['api.example.net:8443']))).status).toBe(
      'HTTP/1.1 200 Connection Established',
    );
    expect((await connect('api.example.net:443', as(['api.example.net:8443']))).status).toBe(
      FORBIDDEN,
    );
  });

  it('denies everything without entries, outside the list and for look-alike suffixes', async () => {
    await start();
    expect((await connect('example.com:443', as([]))).status).toBe(FORBIDDEN);
    for (const host of ['evil.com:443', 'a.example.com.evil.com:443', 'xexample.com:443'])
      expect((await connect(host, as(['*.example.com']))).status).toBe(FORBIDDEN);
    expect(proxy.recentDenials().every((d) => d.reason === 'not_allowed')).toBe(true);
  });

  describe('private and internal destinations (a pipeline author must not reach them)', () => {
    it.each([
      ['socket-proxy', '172.18.0.5'], // the Docker API behind the socket proxy
      ['db.internal', '10.0.0.7'], // PostgreSQL
      ['socket-proxy', '172.17.0.1'], // docker0 gateway
      ['db.internal', '192.168.1.10'],
      ['db.internal', '100.64.0.9'], // CGNAT / shared address space
      ['db.internal', '198.18.0.3'],
      ['db.internal', 'fd00::5'], // ULA
      ['db.internal', '64:ff9b::a00:1'], // NAT64 embedding 10.0.0.1
      ['db.internal', '::ffff:10.0.0.1'], // IPv4-mapped
      ['db.internal', '::ffff:a00:1'],
      ['db.internal', '0::ffff:a00:1'],
      ['db.internal', '0:0:0:0:0:ffff:a00:1'],
      ['db.internal', '::ffff:0:a00:1'],
      ['db.internal', '::a00:1'],
      ['db.internal', '2002:a00:1::1'], // 6to4 embedding 10.0.0.1
    ])('%s -> %s is refused as private', async (host, ip) => {
      RESOLVE[host] = [ip];
      await start();
      const r = await connect(`${host}:443`, as([host]));
      expect(r.status, `${host} ${ip}`).toBe(FORBIDDEN);
      expect(proxy.recentDenials().at(-1)).toMatchObject({ reason: 'private_address' });
      delete RESOLVE[host];
    });

    it('address literals are classified the same way', async () => {
      await start({ ceiling: ['172.17.0.1', '10.0.0.0/8', '0.0.0.0/8'] });
      for (const lit of ['172.17.0.1:443', '10.1.2.3:443']) {
        const r = await connect(lit, as([lit.replace(':443', '')]));
        expect(r.status, lit).toBe(FORBIDDEN);
      }
    });

    it('rejects /1-style splits of the address space everywhere', async () => {
      await start({ ceiling: [] });
      // a grant carrying them is outside the (empty) ceiling; and they cannot even be parsed
      const r = await connect('8.8.8.8:443', as(['0.0.0.0/1', '128.0.0.0/1']));
      expect(r.status).toBe(FORBIDDEN);
      expect(proxy.recentDenials().at(-1)).toMatchObject({ reason: 'outside_ceiling' });
      expect(() => new EgressProxy({ secret: SECRET, ceiling: ['0.0.0.0/1'] })).toThrow(
        /too broad/,
      );
    });

    it('an operator can open a private range, and only that range', async () => {
      RESOLVE['db.internal'] = ['10.1.2.3'];
      RESOLVE['svc.example.org'] = ['10.2.0.1'];
      await start({ privateAllow: ['10.1.0.0/16'] });
      expect((await connect('db.internal:443', as(['db.internal']))).status).toBe(
        'HTTP/1.1 200 Connection Established',
      );
      expect((await connect('svc.example.org:443', as(['svc.example.org']))).status).toBe(
        FORBIDDEN,
      );
      delete RESOLVE['db.internal'];
      delete RESOLVE['svc.example.org'];
    });

    it('never reaches loopback, link-local or metadata, even when an operator allows them', async () => {
      RESOLVE['db.internal'] = ['169.254.169.254'];
      await start({
        privateAllow: ['169.254.0.0/16', '127.0.0.0/8', '0.0.0.0/8'],
      });
      for (const [h, ip] of [
        ['db.internal', '169.254.169.254'],
        ['db.internal', '127.0.0.1'],
        ['db.internal', '::1'],
        ['db.internal', 'fe80::1'],
        ['db.internal', 'fd00:ec2::254'],
        ['db.internal', '100.100.100.200'],
        ['db.internal', '168.63.129.16'],
        ['db.internal', '::ffff:169.254.169.254'],
        ['db.internal', '64:ff9b::a9fe:a9fe'],
      ] as const) {
        RESOLVE[h] = [ip];
        const r = await connect(`${h}:443`, as([h]));
        expect(r.status, ip).toBe(FORBIDDEN);
      }
      delete RESOLVE['db.internal'];
    });

    it('refuses names that mean "this machine" and mixed public/private answers', async () => {
      RESOLVE['svc.example.org'] = ['93.184.216.34', '10.0.0.1'];
      await start({ ceiling: ['localhost', 'svc.example.org'] });
      expect((await connect('localhost:443', as(['localhost']))).status).toBe(FORBIDDEN);
      expect((await connect('svc.example.org:443', as(['svc.example.org']))).status).toBe(
        FORBIDDEN,
      );
      delete RESOLVE['svc.example.org'];
    });
  });

  describe('operator ceiling (intersection, never a union)', () => {
    it('refuses a grant entry outside the ceiling even if the grant is validly signed', async () => {
      await start();
      const r = await connect('evil.com:443', as(['evil.com']));
      expect(r.status).toBe(FORBIDDEN);
      expect(proxy.recentDenials().at(-1)).toMatchObject({ reason: 'outside_ceiling' });
    });
    it('an empty ceiling means no step egress at all', async () => {
      await start({ ceiling: [] });
      expect((await connect('a.example.com:443', as(['a.example.com']))).status).toBe(FORBIDDEN);
    });
  });

  it('requires a valid grant for the node: tampered, foreign, expired, missing', async () => {
    await start();
    const good = grant(['a.example.com']);
    for (const auth of [
      undefined,
      { user: 'node-1', pass: 'wrong' },
      { user: 'node-2', pass: good },
      { user: 'node-1', pass: grant(['a.example.com'], 'node-1', 60, 'z'.repeat(40)) },
      { user: 'node-1', pass: grant(['a.example.com'], 'node-1', 1, SECRET, Date.now() - 600_000) },
      { user: '', pass: 'x' },
    ])
      expect((await connect('a.example.com:443', auth)).status).toMatch(/^HTTP\/1.1 407/);
    expect(proxy.recentDenials().every((d) => d.reason === 'unauthenticated')).toBe(true);
  });

  it('refuses malformed targets and plain HTTP requests', async () => {
    await start();
    for (const host of ['example.com', 'example.com:0', 'example.com:99999', 'a b:443'])
      expect(['', 'HTTP/1.1 400 Bad Request']).toContain(
        (await connect(host, as(['a.example.com']))).status,
      );
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(405);
  });

  it('applies the process-wide air-gapped policy on top', async () => {
    const outer = new EgressPolicy({ airgapped: true, allow: parseAllowlist('internal.corp') });
    await start({ outer });
    expect((await connect('a.example.com:443', as(['*.example.com']))).status).toBe(FORBIDDEN);
  });

  it('answers 502 for unresolvable names and when the upstream fails; bounds its denial log', async () => {
    await start({
      resolve: async () => {
        throw new Error('NXDOMAIN');
      },
    });
    expect((await connect('a.example.com:443', as(['*.example.com']))).status).toBe(
      'HTTP/1.1 502 Bad Gateway',
    );
    await proxy.close();
    await start({ connect: () => net.connect({ host: '127.0.0.1', port: 1 }) });
    expect((await connect('a.example.com:443', as(['*.example.com']))).status).toBe(
      'HTTP/1.1 502 Bad Gateway',
    );
    for (let i = 0; i < 110; i++) await connect('x:1');
    expect(proxy.recentDenials().length).toBeLessThanOrEqual(100);
  });

  describe('resource limits', () => {
    it('limits concurrent tunnels per node', async () => {
      await start({
        maxTunnelsPerNode: 1,
        connect: () => net.connect({ host: '127.0.0.1', port: targetPort }),
      });
      // a target that never answers keeps the first tunnel open
      await new Promise<void>((r) => target.close(() => r()));
      const hold = net.createServer(() => undefined);
      await new Promise<void>((r) => hold.listen(0, '127.0.0.1', r));
      const holdPort = (hold.address() as net.AddressInfo).port;
      cleanups.push(async () => void (await new Promise((r) => hold.close(r))));
      await proxy.close();
      proxy = new EgressProxy({
        secret: SECRET,
        ceiling: ['*.example.com'],
        maxTunnelsPerNode: 1,
        resolve: async () => ['93.184.216.34'],
        connect: () => net.connect({ host: '127.0.0.1', port: holdPort }),
      });
      port = (await proxy.listen(0, '127.0.0.1')).port;
      const first = net.connect(port, '127.0.0.1');
      const a = Buffer.from(`node-1:${grant(['*.example.com'])}`).toString('base64');
      first.write(
        `CONNECT a.example.com:443 HTTP/1.1\r\nHost: x\r\nProxy-Authorization: Basic ${a}\r\n\r\n`,
      );
      await new Promise((r) => first.once('data', r));
      const second = await connect('b.example.com:443', as(['*.example.com']));
      expect(second.status).toBe('HTTP/1.1 429 Too Many Requests');
      expect(proxy.recentDenials().at(-1)).toMatchObject({ reason: 'too_many_tunnels' });
      first.destroy();
    });
    it('drops clients that do not send their request in time and caps connections', async () => {
      await start({ headersTimeoutMs: 100, maxConnections: 1 });
      const slow = net.connect(port, '127.0.0.1');
      const closed = new Promise<void>((r) => slow.once('close', () => r()));
      await new Promise((r) => setTimeout(r, 30));
      // a second connection beyond the cap is dropped immediately
      const extra = net.connect(port, '127.0.0.1');
      extra.on('error', () => undefined);
      const extraClosed = new Promise<void>((r) => extra.once('close', () => r()));
      await extraClosed;
      await closed; // the silent client was closed by the header timeout
    });
  });

  it('cannot be started twice and closes cleanly', async () => {
    await start();
    await expect(proxy.listen(0, '127.0.0.1')).rejects.toThrow(/already listening/);
    await proxy.close();
    await proxy.close();
  });
});

describe('per-server egress accounts (ADR 0016 S2)', () => {
  const server = (egress: string[], srv: string, nodeId = 'node-1') => ({
    user: egressAccount(nodeId, srv),
    pass: mintEgressGrant(SECRET, { nodeId, server: srv, egress, ttlSeconds: 60 }),
  });

  it('a server grant is valid only under its own account', () => {
    const g = mintEgressGrant(SECRET, {
      nodeId: 'n1',
      server: 'jira',
      egress: ['a.example.com'],
      ttlSeconds: 60,
    });
    expect(verifyEgressGrant(SECRET, 'n1.jira', g)).toMatchObject({ n: 'n1', s: 'jira' });
    // not under the step's account, another server's account, or another node's
    expect(verifyEgressGrant(SECRET, 'n1', g)).toBeNull();
    expect(verifyEgressGrant(SECRET, 'n1.crm', g)).toBeNull();
    expect(verifyEgressGrant(SECRET, 'n2.jira', g)).toBeNull();
    // and the step's grant is not valid under a server account
    const step = grant(['a.example.com'], 'n1');
    expect(verifyEgressGrant(SECRET, 'n1.jira', step)).toBeNull();
  });

  it('refuses a node id with a dot (it could collide with a server account)', () => {
    for (const nodeId of ['n.jira', 'a.b', ''])
      expect(() => mintEgressGrant(SECRET, { nodeId, egress: [], ttlSeconds: 1 })).toThrow(/dot/);
    // a forged claim with a dotted node id does not verify even under the matching account
    const payload = Buffer.from(JSON.stringify({ n: 'n.jira', e: [], x: 9e9 })).toString(
      'base64url',
    );
    const sig = createHmac('sha256', SECRET).update(`oax-egress.${payload}`).digest('base64url');
    expect(verifyEgressGrant(SECRET, 'n.jira', `${payload}.${sig}`)).toBeNull();
  });

  it('refuses a server name that is not a slug when minting', () => {
    for (const bad of ['', 'A', 'a.b', 'a b', '1a', '../x'])
      expect(() =>
        mintEgressGrant(SECRET, { nodeId: 'n', server: bad, egress: [], ttlSeconds: 1 }),
      ).toThrow(/slug/);
  });

  it('two servers of one node reach only their own hosts, and the proxy counts per account', async () => {
    await start();
    const a = server(['a.example.com'], 'srv-a');
    const b = server(['svc.example.org'], 'srv-b');
    expect((await connect('a.example.com:443', a)).status).toBe(
      'HTTP/1.1 200 Connection Established',
    );
    expect((await connect('svc.example.org:443', b)).status).toBe(
      'HTTP/1.1 200 Connection Established',
    );
    // crossed: each is refused the other's host
    expect((await connect('svc.example.org:443', a)).status).toBe(FORBIDDEN);
    expect((await connect('a.example.com:443', b)).status).toBe(FORBIDDEN);
    // a server grant presented as the step's account is refused (407), whatever it lists
    expect((await connect('a.example.com:443', { user: 'node-1', pass: a.pass })).status).toMatch(
      /407/,
    );
    expect(Object.fromEntries(proxy.connectionCounts())).toEqual({
      'node-1.srv-a': 1,
      'node-1.srv-b': 1,
    });
    expect(proxy.recentDenials().map((d) => d.nodeId)).toEqual([
      'node-1.srv-a',
      'node-1.srv-b',
      '?',
    ]);
  });

  it('the operator ceiling still bounds a server grant', async () => {
    await start();
    const wide = server(['*.com'], 'srv-a');
    expect((await connect('evil.com:443', wide)).status).toBe(FORBIDDEN);
    expect(proxy.recentDenials().at(-1)?.reason).toBe('outside_ceiling');
  });
});
