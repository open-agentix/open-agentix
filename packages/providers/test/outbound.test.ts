import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TLSSocket } from 'node:tls';
import {
  OaxError,
  compileNetwork,
  parseNetworkConfig,
  type NetworkConfig,
} from '@openagentix/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createGuardedFetch,
  createOutboundDispatcher,
  legacyNetwork,
  proxyAuthorization,
  type RouteAudit,
} from '../src/index.js';

const listen = (s: net.Server) =>
  new Promise<number>((r) =>
    s.listen(0, '127.0.0.1', () => r((s.address() as net.AddressInfo).port)),
  );
const close = (s: net.Server) => new Promise<void>((r) => s.close(() => r()));

let dir: string;
let caPem: string;
let tlsKey: string;
let tlsCert: string;
let plain: http.Server;
let secure: https.Server;
let proxy: http.Server;
let plainPort: number;
let securePort: number;
let proxyPort: number;
const connects: { target: string; auth: string | undefined }[] = [];
const proxied: { url: string; auth: string | undefined }[] = [];

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'oax-outbound-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout',
      path.join(dir, 'k.pem'),
      '-out',
      path.join(dir, 'c.pem'),
    ],
    { stdio: 'ignore' },
  );
  tlsKey = readFileSync(path.join(dir, 'k.pem'), 'utf8');
  tlsCert = readFileSync(path.join(dir, 'c.pem'), 'utf8');
  caPem = tlsCert;
  plain = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/ok' }).end();
    } else if (req.url === '/big') {
      res.writeHead(200).end('x'.repeat(5000));
    } else {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('plain-ok');
    }
  });
  secure = https.createServer({ key: tlsKey, cert: tlsCert }, (_req, res) => res.end('tls-ok'));
  proxy = http.createServer((req, res) => {
    proxied.push({ url: req.url ?? '', auth: req.headers['proxy-authorization'] as string });
    res.end('via-proxy');
  });
  proxy.on('connect', (req, socket) => {
    connects.push({ target: req.url ?? '', auth: req.headers['proxy-authorization'] as string });
    const [h = '', p = ''] = (req.url ?? '').split(':');
    // names ending in .example are test destinations served by the plain server
    const up = (
      h.endsWith('.example') ? net.connect(plainPort, '127.0.0.1') : net.connect(Number(p), h)
    ).on('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  [plainPort, securePort, proxyPort] = await Promise.all([
    listen(plain),
    listen(secure),
    listen(proxy),
  ]);
});

afterAll(async () => {
  plain.closeAllConnections();
  secure.closeAllConnections();
  proxy.closeAllConnections();
  await Promise.all([close(plain), close(secure), close(proxy)]);
  rmSync(dir, { recursive: true, force: true });
});

const netOf = (doc: Record<string, unknown>): ReturnType<typeof compileNetwork> =>
  compileNetwork(parseNetworkConfig(doc as unknown as NetworkConfig).config);
const secrets = (m: Record<string, string>) => (ref: string) => m[ref];

describe('createOutboundDispatcher: direct', () => {
  it('fetches directly and reports the decision without secrets', async () => {
    const audits: RouteAudit[] = [];
    const d = createOutboundDispatcher({ onRoute: (a) => audits.push(a) });
    const res = await d.fetch(`http://127.0.0.1:${plainPort}/x?token=secret`, undefined, {
      purpose: 'model',
    });
    expect(await res.text()).toBe('plain-ok');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ decision: 'direct', via: 'direct', pinned: false });
    expect(JSON.stringify(audits)).not.toMatch(/secret|token|\/x/);
    await d.close();
  });

  it('never follows redirects', async () => {
    const d = createOutboundDispatcher();
    await expect(
      d.fetch(`http://127.0.0.1:${plainPort}/redirect`, undefined, { purpose: 'model' }),
    ).rejects.toThrow();
    await d.close();
  });

  it('enforces the response size limit', async () => {
    const d = createOutboundDispatcher({ limits: { maxResponseBytes: 1000 } });
    const res = await d.fetch(`http://127.0.0.1:${plainPort}/big`, undefined, { purpose: 'model' });
    await expect(res.text()).rejects.toThrow();
    await d.close();
  });

  it('applies the per-request timeout', async () => {
    const slow = http.createServer(() => undefined);
    const port = await listen(slow);
    const d = createOutboundDispatcher();
    await expect(
      d.fetch(`http://127.0.0.1:${port}/`, undefined, { purpose: 'model', timeoutMs: 100 }),
    ).rejects.toThrow();
    slow.closeAllConnections();
    await close(slow);
    await d.close();
  });

  it('turns deny routes and vetoes into egress_denied with a code', async () => {
    const audits: RouteAudit[] = [];
    const d = createOutboundDispatcher({
      network: netOf({
        routes: [{ name: 'blocked', match: { hosts: ['*.blocked.example'] }, via: 'deny' }],
      }),
      onRoute: (a) => audits.push(a),
    });
    const err = await d
      .fetch('https://api.blocked.example/v1', undefined, { purpose: 'model' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OaxError);
    expect((err as OaxError).code).toBe('egress_denied');
    expect(audits[0]).toMatchObject({
      decision: 'deny',
      code: 'egress_denied',
      routeName: 'blocked',
    });
    const meta = await d
      .fetch('http://169.254.169.254/latest', undefined, { purpose: 'model' })
      .catch((e: unknown) => e);
    expect((meta as OaxError).code).toBe('egress_denied');
    expect(audits[1]?.code).toBe('metadata_destination');
  });

  it('refuses plain http for models unless compatibility mode is on', async () => {
    const strict = createOutboundDispatcher({ network: legacyNetwork({}) });
    await expect(
      strict.fetch('http://ollama.internal:11434/x', undefined, { purpose: 'model' }),
    ).rejects.toThrow(/plain_http_refused/);
    const audits: RouteAudit[] = [];
    const compat = createOutboundDispatcher({
      allowPlainHttpForPlatform: true,
      onRoute: (a) => audits.push(a),
      fetchImpl: async () => new Response('ok'),
    });
    expect(
      await (
        await compat.fetch('http://ollama.internal:11434/x', undefined, { purpose: 'model' })
      ).text(),
    ).toBe('ok');
    // tenants never get the compatibility switch
    await expect(
      compat.fetch('http://example.org/x', undefined, {
        purpose: 'model',
        scope: { origin: 'tenant' },
      }),
    ).rejects.toThrow(/plain_http_refused/);
  });
});

describe('createOutboundDispatcher: DNS pinning', () => {
  it('rejects a name that resolves to a private address at connect time', async () => {
    const d = createOutboundDispatcher({ allowPlainHttpForPlatform: true });
    await expect(
      d.fetch('http://rebind.example.org/x', undefined, {
        purpose: 'model',
        pin: { lookup: async () => [{ address: '10.0.0.7' }] },
      }),
    ).rejects.toThrow();
    await d.close();
  });

  it('connects to the validated address only (no second resolution)', async () => {
    let lookups = 0;
    const d = createOutboundDispatcher({ allowPlainHttpForPlatform: true });
    const res = await d.fetch(`http://pinned.example.org:${plainPort}/x`, undefined, {
      purpose: 'model',
      // 127.0.0.1 is only reachable here because the test lists it as allowed
      pin: {
        allow: ['127.0.0.1'],
        lookup: async () => {
          lookups++;
          return [{ address: '127.0.0.1' }];
        },
      },
    });
    expect(await res.text()).toBe('plain-ok');
    expect(lookups).toBe(1);
    await d.close();
  });

  it('pins tenant-origin requests without being asked', async () => {
    const audits: RouteAudit[] = [];
    const d = createOutboundDispatcher({ onRoute: (a) => audits.push(a) });
    await expect(
      d.fetch('https://tenant.example.org/x', undefined, {
        purpose: 'model',
        scope: { origin: 'tenant' },
        pin: { lookup: async () => [{ address: '192.168.1.5' }] },
      }),
    ).rejects.toThrow();
    expect(audits[0]?.pinned).toBe(true);
    await d.close();
  });
});

describe('createOutboundDispatcher: proxies, trust and certificates', () => {
  const doc = (extra: Record<string, unknown> = {}) => ({
    proxies: [{ name: 'corp', url: `http://127.0.0.1:${proxyPort}`, authSecret: 'proxy.auth' }],
    trust: { bundles: [{ name: 'internal', file: path.join('/', 'etc', 'oax-test-ca.pem') }] },
    routes: [{ name: 'internal-tls', match: { hosts: ['localhost'] }, via: 'corp' }],
    ...extra,
  });

  it('tunnels https through the proxy with CONNECT, Proxy-Authorization and the trust bundle', async () => {
    connects.length = 0;
    const audits: RouteAudit[] = [];
    const d = createOutboundDispatcher({
      network: netOf(doc()),
      secrets: secrets({ 'proxy.auth': 'user:pass' }),
      readFile: () => caPem,
      onRoute: (a) => audits.push(a),
    });
    const res = await d.fetch(`https://localhost:${securePort}/`, undefined, {
      purpose: 'model',
      scope: { proxy: 'corp' },
    });
    expect(await res.text()).toBe('tls-ok');
    expect(connects).toEqual([
      {
        target: `localhost:${securePort}`,
        auth: `Basic ${Buffer.from('user:pass').toString('base64')}`,
      },
    ]);
    expect(audits[0]).toMatchObject({
      decision: 'proxy',
      via: 'corp',
      proxyResolves: true,
      pinned: false,
    });
    expect(JSON.stringify(audits)).not.toContain('pass');
    expect(audits[0]?.trust.bundles).toEqual(['internal']);
    await d.close();
  });

  it('fails TLS verification without the bundle (no way to switch it off)', async () => {
    const d = createOutboundDispatcher({
      network: netOf({ proxies: doc().proxies }),
      secrets: secrets({ 'proxy.auth': 'user:pass' }),
    });
    await expect(
      d.fetch(`https://localhost:${securePort}/`, undefined, {
        purpose: 'model',
        scope: { proxy: 'corp' },
      }),
    ).rejects.toThrow();
    await d.close();
  });

  it('sends plain http requests through the proxy', async () => {
    connects.length = 0;
    const d = createOutboundDispatcher({
      network: netOf({ proxies: doc().proxies }),
      secrets: secrets({ 'proxy.auth': 'Bearer abc' }),
      allowPlainHttpForPlatform: true,
    });
    const res = await d.fetch('http://app.internal.example/x', undefined, {
      purpose: 'mcp',
      scope: { proxy: 'corp' },
    });
    expect(await res.text()).toBe('plain-ok');
    // undici tunnels (CONNECT) even plain http: the proxy never sees path or query
    expect(connects[0]).toEqual({ target: 'app.internal.example:80', auth: 'Bearer abc' });
    await d.close();
  });

  it('fails closed when a referenced secret is missing', async () => {
    const d = createOutboundDispatcher({ network: netOf(doc()), readFile: () => caPem });
    const err = await d
      .fetch(`https://localhost:${securePort}/`, undefined, {
        purpose: 'model',
        scope: { proxy: 'corp' },
      })
      .catch((e: unknown) => e);
    expect((err as OaxError).code).toBe('network_secret_unavailable');
    expect(String((err as Error).message)).not.toMatch(/pass/);
  });

  it('uses the legacy environment proxy and its userinfo', async () => {
    connects.length = 0;
    const env = { HTTP_PROXY: `http://u:p%40ss@127.0.0.1:${proxyPort}` };
    const d = createOutboundDispatcher({ env, allowPlainHttpForPlatform: true });
    const res = await d.fetch('http://legacy.internal.example/y', undefined, { purpose: 'model' });
    expect(await res.text()).toBe('plain-ok');
    expect(connects[0]?.auth).toBe(`Basic ${Buffer.from('u:p@ss').toString('base64')}`);
    await d.close();
  });

  it('honours NO_PROXY and loopback-direct', async () => {
    proxied.length = 0;
    const env = { HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, NO_PROXY: 'bypass.example' };
    const audits: RouteAudit[] = [];
    const d = createOutboundDispatcher({
      env,
      allowPlainHttpForPlatform: true,
      onRoute: (a) => audits.push(a),
      fetchImpl: async () => new Response('ok'),
    });
    await d.fetch('http://bypass.example/x', undefined, { purpose: 'model' });
    await d.fetch(`http://127.0.0.1:${plainPort}/x`, undefined, { purpose: 'model' });
    expect(audits.map((a) => a.decision)).toEqual(['direct', 'direct']);
  });

  it('uses a client certificate from secrets and caches dispatchers per route', async () => {
    const mtls = https.createServer(
      { key: tlsKey, cert: tlsCert, requestCert: true, rejectUnauthorized: false, ca: caPem },
      (req, res) =>
        res.end((req.socket as TLSSocket).getPeerCertificate().subject ? 'cert' : 'nocert'),
    );
    const port = await listen(mtls);
    const d = createOutboundDispatcher({
      network: netOf({
        trust: doc().trust,
        clientCertificates: [{ name: 'gw', certSecret: 'gw.cert', keySecret: 'gw.key' }],
      }),
      secrets: secrets({ 'gw.cert': tlsCert, 'gw.key': tlsKey }),
      readFile: () => caPem,
    });
    const ctx = { purpose: 'model' as const, scope: { clientCertificate: 'gw' } };
    const url = `https://localhost:${port}/`;
    expect(await (await d.fetch(url, undefined, ctx)).text()).toBe('cert');
    expect(d.plan(url, ctx).dispatcher).toBe(d.plan(url, ctx).dispatcher);
    expect(d.plan(url, ctx).audit.clientCertificate).toBe('gw');
    mtls.closeAllConnections();
    await close(mtls);
    await d.close();
  });

  it('reads trust bundles from secrets and supports extra-only mode', async () => {
    const d = createOutboundDispatcher({
      network: netOf({
        trust: { mode: 'extra-only', bundles: [{ name: 'pki', secret: 'pki.ca' }] },
      }),
      secrets: secrets({ 'pki.ca': caPem }),
    });
    const res = await d.fetch(`https://localhost:${securePort}/`, undefined, { purpose: 'model' });
    expect(await res.text()).toBe('tls-ok');
    await d.close();
  });

  it('pins a tenant-chosen proxy host and refuses a non-public one', async () => {
    const d = createOutboundDispatcher({ allowPlainHttpForPlatform: true });
    const err = await d
      .fetch('https://api.example.org/x', undefined, {
        purpose: 'model',
        scope: {
          origin: 'tenant',
          proxyUrl: `http://127.0.0.1:${proxyPort}`,
          proxyUrlGrandfathered: true,
        },
      })
      .catch((e: unknown) => e);
    expect((err as OaxError).code).toBe('egress_denied');
    await d.close();
  });

  it('provides node agents with the same routing', () => {
    const d = createOutboundDispatcher({
      network: netOf({ proxies: doc().proxies }),
      secrets: secrets({ 'proxy.auth': 'user:pass' }),
    });
    const viaProxy = d.nodeAgents('https://bedrock-runtime.eu-central-1.amazonaws.com', {
      purpose: 'model',
      scope: { proxy: 'corp' },
    });
    expect(viaProxy.audit.decision).toBe('proxy');
    expect(viaProxy.httpAgent).toBeUndefined();
    const direct = createOutboundDispatcher().nodeAgents(
      'https://bedrock-runtime.eu-central-1.amazonaws.com',
      {
        purpose: 'model',
        pin: { lookup: async () => [{ address: '8.8.8.8' }] },
      },
    );
    expect(direct.audit).toMatchObject({ decision: 'direct', pinned: true });
    expect(direct.httpAgent).toBeDefined();
    expect(() => d.nodeAgents('http://169.254.169.254', { purpose: 'model' })).toThrow(
      /egress_denied|refused/,
    );
  });
});

describe('helpers and createGuardedFetch integration', () => {
  it('builds Proxy-Authorization from user:password or a full value', () => {
    expect(proxyAuthorization('a:b')).toBe(`Basic ${Buffer.from('a:b').toString('base64')}`);
    expect(proxyAuthorization('Bearer tok')).toBe('Bearer tok');
  });

  it('routes the guarded fetch through the factory (explicit proxyUrl, redirects refused)', async () => {
    connects.length = 0;
    const f = createGuardedFetch({
      allowedOrigins: ['http://model.internal.example'],
      proxyUrl: `http://127.0.0.1:${proxyPort}`,
    });
    expect(await (await f('http://model.internal.example/v1')).text()).toBe('plain-ok');
    expect(connects[0]?.target).toBe('model.internal.example:80');
    const direct = createGuardedFetch({ allowedOrigins: [`http://127.0.0.1:${plainPort}`] });
    await expect(direct(`http://127.0.0.1:${plainPort}/redirect`)).rejects.toThrow();
  });

  it('writes nothing secret into the audit of a legacy proxy URL', () => {
    const audits: RouteAudit[] = [];
    const d = createOutboundDispatcher({
      env: { HTTPS_PROXY: 'http://user:topsecret@127.0.0.1:3128' },
      onRoute: (a) => audits.push(a),
    });
    d.plan('https://api.example.org/x?k=1', { purpose: 'model' });
    expect(JSON.stringify(audits)).not.toMatch(/topsecret|user:|k=1/);
    writeFileSync(path.join(dir, 'noop'), '');
  });
});
