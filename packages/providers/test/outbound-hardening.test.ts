import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import {
  OaxError,
  compileNetwork,
  parseNetworkConfig,
  type NetworkConfig,
} from '@openagentix/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  OpenAIStreamTransport,
  ProviderError,
  createGuardedFetch,
  createOutboundDispatcher,
  findOaxError,
  postJson,
  sharedOutboundDispatcher,
  type NodeAgents,
} from '../src/index.js';

const listen = (s: net.Server) =>
  new Promise<number>((r) =>
    s.listen(0, '127.0.0.1', () => r((s.address() as net.AddressInfo).port)),
  );
const close = (s: net.Server) => new Promise<void>((r) => s.close(() => r()));

let dir: string;
let targetCert: string;
let targetKey: string;
let proxyCert: string;
let proxyKey: string;
let plain: http.Server;
let mtls: https.Server;
let httpProxy: http.Server;
let tlsProxy: https.Server;
let plainPort: number;
let mtlsPort: number;
let httpProxyPort: number;
let tlsProxyPort: number;
/** Client certificate subject seen by the TLS proxy on its own handshake (empty = none sent). */
const proxySawClientCert: (string | undefined)[] = [];

const selfSigned = (name: string) => {
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
      `/CN=${name}`,
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout',
      path.join(dir, `${name}.key`),
      '-out',
      path.join(dir, `${name}.crt`),
    ],
    { stdio: 'ignore' },
  );
  return [
    readFileSync(path.join(dir, `${name}.crt`), 'utf8'),
    readFileSync(path.join(dir, `${name}.key`), 'utf8'),
  ] as const;
};

const sockets = new Set<net.Socket>();
const tunnel = (req: http.IncomingMessage, socket: Duplex) => {
  const [h = '', p = ''] = (req.url ?? '').split(':');
  // names ending in .example are test destinations served by the plain server
  const up = (
    h.endsWith('.example') ? net.connect(plainPort, '127.0.0.1') : net.connect(Number(p), h)
  ).on('connect', () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    up.pipe(socket);
    socket.pipe(up);
  });
  sockets.add(up).add(socket as net.Socket);
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
};

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'oax-outbound-h-'));
  [targetCert, targetKey] = selfSigned('target');
  [proxyCert, proxyKey] = selfSigned('proxy');
  plain = http.createServer((_req, res) => res.end('plain-ok'));
  // reports whether the client presented a certificate
  mtls = https.createServer(
    { key: targetKey, cert: targetCert, requestCert: true, rejectUnauthorized: false },
    (req, res) =>
      res.end((req.socket as TLSSocket).getPeerCertificate().subject ? 'cert' : 'nocert'),
  );
  httpProxy = http.createServer();
  httpProxy.on('connect', tunnel);
  tlsProxy = https.createServer({
    key: proxyKey,
    cert: proxyCert,
    requestCert: true,
    rejectUnauthorized: false,
  });
  tlsProxy.on('connect', (req, socket) => {
    proxySawClientCert.push(
      (socket as TLSSocket).getPeerCertificate().subject?.CN as string | undefined,
    );
    tunnel(req, socket);
  });
  [plainPort, mtlsPort, httpProxyPort, tlsProxyPort] = await Promise.all([
    listen(plain),
    listen(mtls),
    listen(httpProxy),
    listen(tlsProxy),
  ]);
});

afterAll(async () => {
  for (const s of sockets) s.destroy();
  for (const s of [plain, mtls, httpProxy, tlsProxy]) s.closeAllConnections();
  await Promise.all([plain, mtls, httpProxy, tlsProxy].map(close));
  rmSync(dir, { recursive: true, force: true });
});

const netOf = (doc: Record<string, unknown>) =>
  compileNetwork(parseNetworkConfig(doc as unknown as NetworkConfig).config);
const secrets = (m: Record<string, string>) => (ref: string) => m[ref];
const code = (e: unknown) => (e as OaxError).code;

/** GET through the given node agent (what the AWS SDK handler does). */
const nodeGet = (url: string, agents: NodeAgents) =>
  new Promise<string>((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const agent = target.protocol === 'https:' ? agents.httpsAgent : agents.httpAgent;
    lib
      .get(url, { agent }, (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => resolve(body));
      })
      .on('error', reject);
  });

describe('H1: legacy proxyUrl of a platform connection', () => {
  it('is not pinned: a proxy host that resolves to a private address works', async () => {
    // The injected lookup would reject the proxy host (10.0.0.7) if the proxy connect were pinned.
    const d = createOutboundDispatcher({ allowPlainHttpForPlatform: true });
    const res = await d.fetch('http://model.internal.example/v1', undefined, {
      purpose: 'model',
      scope: { proxyUrl: `http://localhost:${httpProxyPort}` },
      pin: { lookup: async () => [{ address: '10.0.0.7' }] },
    });
    expect(res.status).toBe(200);
    await d.close();
  });

  it('works with an IP-literal private proxy as well', async () => {
    const d = createOutboundDispatcher({ allowPlainHttpForPlatform: true });
    const f = createGuardedFetch({
      allowedOrigins: ['http://model.internal.example'],
      proxyUrl: `http://127.0.0.1:${httpProxyPort}`,
      outbound: { dispatcher: d },
    });
    expect(await (await f('http://model.internal.example/v1')).text()).toBe('plain-ok');
    const plan = d.plan('http://model.internal.example/v1', {
      purpose: 'model',
      scope: { proxyUrl: `http://127.0.0.1:${httpProxyPort}` },
    });
    expect(plan.audit).toMatchObject({ decision: 'proxy', routeName: 'legacy-proxyUrl' });
    await d.close();
  });

  it('is pinned for a tenant: a proxy host resolving to a private address is refused', async () => {
    const d = createOutboundDispatcher({ allowPlainHttpForPlatform: true });
    const err = await d
      .fetch('https://api.example.org/x', undefined, {
        purpose: 'model',
        scope: {
          origin: 'tenant',
          proxyUrl: 'http://proxy.example.org:3128',
          proxyUrlGrandfathered: true,
        },
        pin: { lookup: async () => [{ address: '10.0.0.7' }] },
      })
      .catch((e: unknown) => e);
    expect(findOaxError(err)?.code).toBe('egress_denied');
    await d.close();
  });

  it('keeps a tenant proxyUrl denied unless the connection metadata grandfathers it (M1)', () => {
    const d = createOutboundDispatcher();
    const base = { origin: 'tenant' as const, proxyUrl: 'http://proxy.example.org:3128' };
    expect(() => d.plan('https://api.example.org/x', { purpose: 'model', scope: base })).toThrow(
      /refused/,
    );
    // the guarded fetch does not invent the grandfather flag from "proxyUrl is set"
    const f = createGuardedFetch({
      allowedOrigins: ['https://api.example.org'],
      proxyUrl: 'http://proxy.example.org:3128',
      outbound: { dispatcher: d, scope: { origin: 'tenant' } },
    });
    return expect(f('https://api.example.org/x')).rejects.toMatchObject({ code: 'egress_denied' });
  });
});

describe('H2: node agents behind a proxy', () => {
  const bundles = [
    { name: 'target', secret: 'ca.target' },
    { name: 'proxyca', secret: 'ca.proxy' },
  ];
  const proxyList = () => [
    { name: 'plainproxy', url: `http://127.0.0.1:${httpProxyPort}` },
    { name: 'tlsproxy', url: `https://localhost:${tlsProxyPort}`, caBundle: 'proxyca' },
  ];
  const trusted = () => ({
    trust: { mode: 'extra-only', bundles },
    proxies: proxyList(),
    clientCertificates: [{ name: 'gw', certSecret: 'gw.cert', keySecret: 'gw.key' }],
  });
  const make = (doc: Record<string, unknown>) =>
    createOutboundDispatcher({
      network: netOf(doc),
      secrets: secrets({
        'ca.target': targetCert,
        'ca.proxy': proxyCert,
        'gw.cert': targetCert,
        'gw.key': targetKey,
      }),
    });

  it('verifies the destination against the extra-only bundle through a CONNECT proxy', async () => {
    const d = make({
      trust: { mode: 'extra-only', bundles: [bundles[0]] },
      proxies: [proxyList()[0]],
    });
    const agents = d.nodeAgents(`https://localhost:${mtlsPort}/`, {
      purpose: 'model',
      scope: { proxy: 'plainproxy' },
    });
    expect(await nodeGet(`https://localhost:${mtlsPort}/`, agents)).toBe('nocert');
    await d.close();
  });

  it('does not trust the destination without the bundle (verification stays on)', async () => {
    const d = createOutboundDispatcher({
      network: netOf({ proxies: [proxyList()[0]] }),
    });
    const agents = d.nodeAgents(`https://localhost:${mtlsPort}/`, {
      purpose: 'model',
      scope: { proxy: 'plainproxy' },
    });
    await expect(nodeGet(`https://localhost:${mtlsPort}/`, agents)).rejects.toThrow(
      /self.signed|certificate/i,
    );
    await d.close();
  });

  it('trusts the proxy CA for the proxy hop only and keeps the client certificate from the proxy', async () => {
    proxySawClientCert.length = 0;
    const d = make(trusted());
    const agents = d.nodeAgents(`https://localhost:${mtlsPort}/`, {
      purpose: 'model',
      scope: { proxy: 'tlsproxy', clientCertificate: 'gw' },
    });
    expect(agents.audit).toMatchObject({ decision: 'proxy', via: 'tlsproxy' });
    // the destination received the mTLS certificate ...
    expect(await nodeGet(`https://localhost:${mtlsPort}/`, agents)).toBe('cert');
    // ... the TLS proxy saw a handshake without one
    expect(proxySawClientCert).toEqual([undefined]);
    await d.close();
  });

  it('sets rejectUnauthorized on every agent and refuses a disabled verification (M2)', () => {
    const d = make(trusted());
    const direct = d.nodeAgents('https://bedrock-runtime.eu-central-1.amazonaws.com', {
      purpose: 'model',
      pin: { lookup: async () => [{ address: '8.8.8.8' }] },
    });
    expect((direct.httpsAgent.options as { rejectUnauthorized?: boolean }).rejectUnauthorized).toBe(
      true,
    );
    const env = { NODE_TLS_REJECT_UNAUTHORIZED: '0' };
    expect(() => createOutboundDispatcher({ env })).toThrow(/tls_insecure|disables certificate/);
    try {
      createOutboundDispatcher({ network: netOf(trusted()), env });
      expect.unreachable();
    } catch (e) {
      expect(code(e)).toBe('tls_insecure');
    }
    // legacy path and a flipped environment later on
    const live: Record<string, string | undefined> = {};
    const late = createOutboundDispatcher({ env: live });
    live.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    expect(() => late.plan('https://api.example.org', { purpose: 'model' })).toThrow(
      /certificate verification/,
    );
  });
});

describe('M3: policy errors are final', () => {
  const wrapped = (inner: OaxError) =>
    Object.assign(new TypeError('fetch failed'), { cause: inner });

  it.each([
    'egress_denied',
    'network_secret_unavailable',
    'client_certificate_unknown',
    'network_config_invalid',
    'tls_insecure',
  ])('postJson does not retry %s (also behind a fetch failed cause)', async (c) => {
    let calls = 0;
    const err = await postJson(
      async () => {
        calls++;
        throw wrapped(new OaxError(c, 'blocked'));
      },
      'https://api.example.org/x',
      {},
      { maxRetries: 3, backoffMs: 1 },
    ).catch((e: unknown) => e);
    expect(calls).toBe(1);
    expect(err).toBeInstanceOf(OaxError);
    expect(err).not.toBeInstanceOf(ProviderError);
    expect(code(err)).toBe(c);
  });

  it('still retries plain network errors', async () => {
    let calls = 0;
    await postJson(
      async () => {
        calls++;
        throw new TypeError('fetch failed');
      },
      'https://api.example.org/x',
      {},
      { maxRetries: 1, backoffMs: 1 },
    ).catch(() => undefined);
    expect(calls).toBe(2);
  });

  it('the SSE stream opener does not retry them either', async () => {
    let calls = 0;
    const t = new OpenAIStreamTransport({
      baseUrl: 'https://api.example.org/v1',
      apiKey: 'sk-test-0123456789',
      backoffMs: 1,
      maxRetries: 3,
      fetchImpl: async () => {
        calls++;
        throw wrapped(new OaxError('egress_denied', 'pinned lookup refused'));
      },
    });
    const err = await t.open({ body: { model: 'x', messages: [] } }, {}).catch((e: unknown) => e);
    expect(calls).toBe(1);
    expect(code(err)).toBe('egress_denied');
    expect(err).not.toBeInstanceOf(ProviderError);
  });

  it('findOaxError walks the cause chain and ignores provider errors', () => {
    expect(findOaxError(new Error('x'))).toBeUndefined();
    expect(findOaxError(new ProviderError('x', 500, true))).toBeUndefined();
    expect(findOaxError({ cause: { cause: new OaxError('a', 'b') } })?.code).toBe('a');
  });
});

describe('M4: tenant destination behind a proxy is pre-checked', () => {
  it('resolves the name once and refuses a private answer before sending', async () => {
    let sent = 0;
    const d = createOutboundDispatcher({
      network: netOf({
        proxies: [{ name: 'corp', url: `http://127.0.0.1:${httpProxyPort}` }],
        tenantSelectable: ['corp'],
      }),
      fetchImpl: async () => {
        sent++;
        return new Response('ok');
      },
    });
    const ctx = (address: string) => ({
      purpose: 'model' as const,
      scope: { origin: 'tenant' as const, proxy: 'corp' },
      pin: { lookup: async () => [{ address }] },
    });
    const err = await d
      .fetch('https://rebind.example.org/x', undefined, ctx('10.1.2.3'))
      .catch((e: unknown) => e);
    expect(code(err)).toBe('egress_denied');
    expect(sent).toBe(0);
    await d.fetch('https://public.example.org/x', undefined, ctx('93.184.216.34'));
    expect(sent).toBe(1);
    await d.close();
  });
});

describe('L1, L4, L7, L8', () => {
  it('bounds the dispatcher cache and keeps userinfo out of the cache key', async () => {
    const d = createOutboundDispatcher({ allowPlainHttpForPlatform: true });
    const first = d.plan('http://a.example.org/', {
      purpose: 'model',
      scope: { proxyUrl: 'http://u:topsecret@127.0.0.1:3128' },
    }).dispatcher;
    for (let i = 0; i < 70; i++)
      d.plan('http://a.example.org/', {
        purpose: 'model',
        scope: { proxyUrl: `http://127.0.0.1:${4000 + i}` },
      });
    const again = d.plan('http://a.example.org/', {
      purpose: 'model',
      scope: { proxyUrl: 'http://u:topsecret@127.0.0.1:3128' },
    }).dispatcher;
    expect(again).not.toBe(first); // evicted (LRU, 64)
    await d.close();
  });

  it('reports the size limit as response_too_large', async () => {
    const d = createOutboundDispatcher({
      limits: { maxResponseBytes: 10 },
      fetchImpl: async () => new Response('x'.repeat(100)),
    });
    const res = await d.fetch(`http://127.0.0.1:${plainPort}/`, undefined, { purpose: 'model' });
    const err = await res.text().catch((e: unknown) => e);
    expect(findOaxError(err)?.code).toBe('response_too_large');
    const declared = createOutboundDispatcher({
      limits: { maxResponseBytes: 10 },
      fetchImpl: async () => new Response('x', { headers: { 'content-length': '999' } }),
    });
    await expect(
      declared.fetch(`http://127.0.0.1:${plainPort}/`, undefined, { purpose: 'model' }),
    ).rejects.toMatchObject({ code: 'response_too_large' });
  });

  it('refuses invalid percent-encoding in proxy credentials instead of dropping them', () => {
    const d = createOutboundDispatcher({
      env: { HTTPS_PROXY: 'http://user:p%zz@127.0.0.1:3128' },
    });
    try {
      d.plan('https://api.example.org/', { purpose: 'model' });
      expect.unreachable();
    } catch (e) {
      expect(code(e)).toBe('network_config_invalid');
      expect(String((e as Error).message)).not.toMatch(/p%zz/);
    }
  });

  it('shares one factory per proxy environment', () => {
    const env = { HTTPS_PROXY: 'http://127.0.0.1:3128' };
    expect(sharedOutboundDispatcher(env)).toBe(sharedOutboundDispatcher({ ...env }));
    expect(sharedOutboundDispatcher({})).not.toBe(sharedOutboundDispatcher(env));
  });
});
