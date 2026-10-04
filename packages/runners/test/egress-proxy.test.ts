import * as net from 'node:net';
import { EgressPolicy, parseAllowlist } from '@openagentix/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EgressProxy, isForbiddenAddress } from '../src/index.js';

let proxy: EgressProxy;
let port: number;
let target: net.Server;
let targetPort: number;
const cleanups: (() => Promise<void>)[] = [];

beforeEach(async () => {
  // A local "internet" server that answers every connection with a banner.
  target = net.createServer((s) => s.end('hello from target'));
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  targetPort = (target.address() as net.AddressInfo).port;
  cleanups.push(async () => void (await new Promise((r) => target.close(r))));
});
afterEach(async () => {
  await proxy?.close();
  for (const c of cleanups.splice(0)) await c();
});

async function start(opts: ConstructorParameters<typeof EgressProxy>[0] = {}) {
  proxy = new EgressProxy({
    // Names resolve to a public-looking address, except where a test says otherwise.
    resolve: async (h) => (h === 'rebind.example' ? ['127.0.0.1'] : ['93.184.216.34']),
    ...opts,
  });
  port = (await proxy.listen(0, '127.0.0.1')).port;
}

/** Sends CONNECT through the proxy and returns the status line and what follows. */
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

describe('isForbiddenAddress', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.1.2.3', true],
    ['::1', true],
    ['0.0.0.0', true],
    ['169.254.169.254', true],
    ['fe80::1', true],
    ['::', true],
    ['224.0.0.1', true],
    ['ff02::1', true],
    ['::ffff:127.0.0.1', true],
    ['not-an-ip', true],
    ['93.184.216.34', false],
    ['10.0.0.5', false],
    ['2606:2800:220:1::1', false],
  ])('%s -> %s', (addr, expected) => {
    expect(isForbiddenAddress(addr)).toBe(expected);
  });
});

describe('egress proxy', () => {
  it('relays bytes to an allowed host and records nothing as denied', async () => {
    const dialed: { host: string; port: number }[] = [];
    await start({
      connect: (t) => {
        dialed.push(t);
        return net.connect({ host: '127.0.0.1', port: targetPort }); // the local "internet"
      },
    });
    const { password } = proxy.register('node-1', ['svc.example']);
    const r = await connect('svc.example:443', { user: 'node-1', pass: password });
    expect(r.status).toBe('HTTP/1.1 200 Connection Established');
    expect(r.rest).toContain('hello from target');
    // it dials the address it resolved and checked, not the name
    expect(dialed).toEqual([{ host: '93.184.216.34', port: 443 }]);
    expect(proxy.recentDenials()).toHaveLength(0);
  });
  it('answers 502 when the upstream connection fails', async () => {
    await start({ connect: () => net.connect({ host: '127.0.0.1', port: 1 }) });
    const { password } = proxy.register('node-1', ['svc.example']);
    const r = await connect('svc.example:443', { user: 'node-1', pass: password });
    expect(r.status).toBe('HTTP/1.1 502 Bad Gateway');
  });
  it('denies everything for a node without egress entries (deny by default)', async () => {
    await start();
    const { password } = proxy.register('node-1', []);
    const r = await connect('example.com:443', { user: 'node-1', pass: password });
    expect(r.status).toBe('HTTP/1.1 403 Forbidden');
    expect(proxy.recentDenials().at(-1)).toMatchObject({ nodeId: 'node-1', reason: 'not_allowed' });
  });
  it('denies hosts outside the node list, including look-alike suffixes', async () => {
    await start();
    const { password } = proxy.register('node-1', ['jira.example.com', '*.corp.example']);
    for (const host of ['evil.com:443', 'jira.example.com.evil.com:443', 'xcorp.example:443'])
      expect((await connect(host, { user: 'node-1', pass: password })).status).toBe(
        'HTTP/1.1 403 Forbidden',
      );
  });
  it('never reaches loopback or metadata addresses, even when listed', async () => {
    await start();
    const { password } = proxy.register('node-1', [
      '127.0.0.1',
      '169.254.169.254',
      'localhost',
      'rebind.example',
    ]);
    for (const host of [
      `127.0.0.1:${targetPort}`,
      '169.254.169.254:80',
      `localhost:${targetPort}`,
      `rebind.example:${targetPort}`,
    ]) {
      const r = await connect(host, { user: 'node-1', pass: password });
      expect(r.status, host).toBe('HTTP/1.1 403 Forbidden');
    }
  });
  it('requires valid, node-specific credentials', async () => {
    await start();
    const a = proxy.register('node-a', ['example.com']);
    proxy.register('node-b', ['example.com']);
    for (const auth of [
      undefined,
      { user: 'node-a', pass: 'wrong' },
      { user: 'node-b', pass: a.password },
      { user: 'unknown', pass: a.password },
      { user: '', pass: 'x' },
    ])
      expect((await connect('example.com:443', auth)).status).toMatch(/^HTTP\/1.1 407/);
    expect(proxy.recentDenials().every((d) => d.reason === 'unauthenticated')).toBe(true);
  });
  it('stops serving a node as soon as it is unregistered', async () => {
    await start();
    const { password } = proxy.register('node-1', ['example.com']);
    proxy.unregister('node-1');
    expect((await connect('example.com:443', { user: 'node-1', pass: password })).status).toMatch(
      /^HTTP\/1.1 407/,
    );
  });
  it('refuses malformed targets and plain HTTP requests', async () => {
    await start();
    const { password } = proxy.register('node-1', ['example.com']);
    // Either our 400 or the HTTP parser dropping the connection: nothing is ever tunnelled.
    for (const host of ['example.com', 'example.com:0', 'example.com:99999', 'a b:443'])
      expect(['', 'HTTP/1.1 400 Bad Request']).toContain(
        (await connect(host, { user: 'node-1', pass: password })).status,
      );
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(405);
  });
  it('applies the process-wide air-gapped policy on top of the node list', async () => {
    const outer = new EgressPolicy({ airgapped: true, allow: parseAllowlist('internal.corp') });
    await start({ outer });
    const { password } = proxy.register('node-1', ['internal.corp', 'example.com']);
    expect((await connect('example.com:443', { user: 'node-1', pass: password })).status).toBe(
      'HTTP/1.1 403 Forbidden',
    );
  });
  it('answers 502 for unresolvable names and bounds its denial log', async () => {
    await start({
      resolve: async () => {
        throw new Error('NXDOMAIN');
      },
    });
    const { password } = proxy.register('node-1', ['gone.example']);
    expect((await connect('gone.example:443', { user: 'node-1', pass: password })).status).toBe(
      'HTTP/1.1 502 Bad Gateway',
    );
    for (let i = 0; i < 110; i++) await connect('x:1');
    expect(proxy.recentDenials().length).toBeLessThanOrEqual(100);
  });
  it('cannot be started twice and closes cleanly', async () => {
    await start();
    await expect(proxy.listen(0, '127.0.0.1')).rejects.toThrow(/already listening/);
    await proxy.close();
    await proxy.close();
  });
});
