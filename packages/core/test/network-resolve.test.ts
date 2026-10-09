import { describe, expect, it } from 'vitest';
import {
  EgressPolicy,
  classifyAddress,
  compileNetwork,
  entryCoveredBy,
  entryMatches,
  isMetadataName,
  normalizeTarget,
  parseAllowlist,
  parseHostPattern,
  parseIp,
  parseNetworkConfig,
  parseNoProxy,
  resolveRoute,
  legacyProxyFromEnv,
  type CompileOptions,
  type NetworkPurpose,
  type RouteScope,
} from '../src/index.js';

const doc = {
  proxies: [
    { name: 'corp', url: 'https://proxy.corp.example:3128', authSecret: 'corp-auth' },
    { name: 'insp', url: 'https://insp.corp.example', tlsInspection: true },
    { name: 'partner', url: 'https://proxy.partner.example' },
  ],
  clientCertificates: [{ name: 'gw', certSecret: 'c', keySecret: 'k' }],
  routes: [
    { name: 'blocked', match: { hosts: ['evil.example'] }, via: 'deny' },
    {
      name: 'private',
      match: { hosts: ['*.vpce.amazonaws.com', '.svc.cluster.local'] },
      via: 'direct',
    },
    {
      name: 'gateway',
      match: { hosts: ['llm-gateway.corp.example'] },
      via: 'direct',
      clientCertificate: 'gw',
    },
    {
      name: 'partner',
      match: { hosts: ['*.partner.example'], purposes: ['mcp', 'webhook'] },
      via: 'partner',
    },
    { name: 'inspected', match: { hosts: ['scan.example'] }, via: 'insp' },
    { name: 'default', match: { hosts: ['*'] }, via: 'corp' },
  ],
  tenantSelectable: ['corp'],
  privateAllow: ['10.20.0.0/16'],
};

const mk = (patch: object = {}, opts: CompileOptions = {}) =>
  compileNetwork(parseNetworkConfig({ ...doc, ...patch }).config, opts);
const net = mk();
const r = (url: string, purpose: NetworkPurpose = 'model', scope: RouteScope = {}, n = net) =>
  resolveRoute(url, purpose, scope, n);

describe('route matching and precedence', () => {
  it('first matching route wins, purposes narrow a route', () => {
    expect(r('https://bedrock-runtime.vpce-1.eu.vpce.amazonaws.com')).toMatchObject({
      decision: 'direct',
      routeName: 'private',
    });
    expect(r('https://api.svc.cluster.local:8443/x')).toMatchObject({ decision: 'direct' });
    expect(r('https://a.partner.example', 'mcp')).toMatchObject({
      decision: 'proxy',
      via: 'partner',
    });
    expect(r('https://a.partner.example', 'model')).toMatchObject({
      decision: 'proxy',
      via: 'corp',
      routeName: 'default',
    });
    expect(r('https://api.openai.com/v1')).toMatchObject({
      decision: 'proxy',
      via: 'corp',
      proxy: { url: 'https://proxy.corp.example:3128', authSecret: 'corp-auth' },
    });
  });

  it('attaches the route client certificate and the trust store', () => {
    const x = r('https://llm-gateway.corp.example/v1');
    expect(x).toMatchObject({ decision: 'direct', clientCert: 'gw' });
    expect(x.ca.mode).toBe('system+extra');
    expect(r('https://x.example', 'model', { clientCertificate: 'nope' }).code).toBe(
      'client_certificate_unknown',
    );
  });

  it('a deny route vetoes everything, also a connection selection', () => {
    expect(r('https://evil.example')).toMatchObject({ decision: 'deny', code: 'egress_denied' });
    expect(r('https://evil.example', 'model', { proxy: 'direct' }).code).toBe('egress_denied');
    expect(r('https://evil.example', 'model', { proxyUrl: 'https://p.example' }).code).toBe(
      'egress_denied',
    );
  });

  it('connection selection beats routes; legacy proxyUrl beats routes; routes beat env', () => {
    expect(r('https://llm.example', 'model', { proxy: 'partner' })).toMatchObject({
      via: 'partner',
      routeName: 'connection:partner',
    });
    expect(r('https://llm.example', 'model', { proxy: 'direct' })).toMatchObject({
      decision: 'direct',
    });
    expect(r('https://llm.example', 'model', { proxy: 'nope' }).code).toBe('proxy_unknown');
    expect(r('https://llm.example', 'model', { proxyUrl: 'https://old.example:9' })).toMatchObject({
      routeName: 'legacy-proxyUrl',
      proxy: { host: 'old.example', port: 9 },
    });
    expect(r('https://llm.example', 'model', { proxyUrl: 'ftp://x' }).code).toBe(
      'proxy_url_invalid',
    );
    const env = legacyProxyFromEnv({
      HTTPS_PROXY: 'https://env.example:1',
      NO_PROXY: 'skip.example',
    });
    const withEnv = mk({ routes: [] }, { legacy: env });
    expect(r('https://a.example', 'model', {}, withEnv)).toMatchObject({
      routeName: 'legacy-env',
      proxy: { host: 'env.example' },
    });
    expect(r('https://x.skip.example', 'model', {}, withEnv)).toMatchObject({
      decision: 'direct',
      routeName: 'legacy-env',
    });
    expect(
      r('https://x.skip.example', 'model', { proxyUrl: 'https://old.example' }, withEnv).decision,
    ).toBe('direct');
    expect(r('http://a.example', 'catalog', {}, withEnv).decision).toBe('direct');
    expect(r('https://a.example', 'model', {}, mk({ routes: [] })).routeName).toBe('default');
    // configured route beats env
    expect(r('https://a.example', 'model', {}, mk({}, { legacy: env })).via).toBe('corp');
  });

  it('http env proxy is used for http targets only when set', () => {
    const env = legacyProxyFromEnv({ HTTP_PROXY: 'https://h.example' });
    const n = mk({ routes: [] }, { legacy: env });
    expect(r('http://catalog.example', 'catalog', {}, n).via).toBe('env:http');
    expect(r('https://a.example', 'model', {}, n).via).toBe('env:http');
  });
});

describe('safety rules', () => {
  it('never reaches metadata addresses or names, in any spelling', () => {
    for (const u of [
      'http://169.254.169.254/latest',
      'http://[::ffff:169.254.169.254]/',
      'http://[::ffff:a9fe:a9fe]/',
      'http://metadata.google.internal/',
      'https://169.254.170.2/',
      'http://[fd00:ec2::254]/',
      'http://2852039166/',
    ])
      expect(r(u, 'probe').code, u).toBe('metadata_destination');
    // a range covering link-local space is refused at validation; the veto holds regardless
    expect(() => mk({ privateAllow: ['169.254.0.0/16'] })).toThrow(/link-local/);
    const patched = { ...net, privateAllow: [parseHostPattern('169.254.0.0/16')] };
    expect(r('http://169.254.169.254', 'probe', {}, patched).code).toBe('metadata_destination');
  });

  it('tenant destinations must be public unless the operator opened the range', () => {
    const t: RouteScope = { origin: 'tenant', tenantId: 't1' };
    for (const u of [
      'https://localhost/',
      'https://a.localhost/',
      'https://127.0.0.1/',
      'https://10.0.0.5/',
      'https://[::1]/',
      'https://192.168.1.1/',
      'https://[fd00::1]/',
      'https://[::ffff:10.0.0.1]/',
    ])
      expect(r(u, 'webhook', t).code, u).toBe('destination_not_public');
    expect(r('https://10.20.1.1/', 'webhook', t).decision).not.toBe('deny');
    expect(r('https://example.org/', 'webhook', { ...t, proxy: 'corp' }).decision).toBe('proxy');
    // platform origin may use private endpoints
    expect(r('https://10.0.0.5/', 'model').decision).not.toBe('deny');
  });

  it('refuses plain http for TLS-only purposes except loopback/private allow', () => {
    for (const p of ['model', 'identity', 'git', 'webhook'] as const)
      expect(r('http://api.example/', p).code).toBe('plain_http_refused');
    expect(r('http://localhost:11434/', 'model').decision).toBe('direct');
    expect(r('http://[::1]:8080/', 'model').routeName).toBe('loopback');
    expect(r('http://10.20.0.4/', 'model').decision).not.toBe('deny');
    expect(r('http://api.example/', 'catalog').decision).not.toBe('deny');
    expect(r('ws://api.example/', 'model').code).toBe('plain_http_refused');
  });

  it('rejects unusable targets and purposes', () => {
    expect(r('not a url').code).toBe('invalid_target');
    expect(r('file:///etc/passwd').code).toBe('invalid_target');
    expect(r('https://./').code).toBe('invalid_target');
    expect(r('https://a.example', 'bogus' as NetworkPurpose).code).toBe('invalid_purpose');
  });

  it('tenants may only select tenantSelectable proxies and direct only when enabled', () => {
    const t: RouteScope = { origin: 'tenant' };
    expect(r('https://a.example', 'model', { ...t, proxy: 'corp' })).toMatchObject({ via: 'corp' });
    expect(r('https://a.example', 'model', { ...t, proxy: 'partner' }).code).toBe(
      'proxy_not_selectable',
    );
    expect(r('https://a.example', 'model', { ...t, proxy: 'direct' }).code).toBe(
      'proxy_not_selectable',
    );
    expect(
      r('https://a.example', 'model', { ...t, proxy: 'direct' }, mk({ tenantDirect: true }))
        .decision,
    ).toBe('direct');
    expect(
      r('https://a.example', 'model', { ...t, proxy: 'corp', proxyUrl: 'https://x.example' }).code,
    ).toBe('proxy_url_not_allowed');
  });

  it('refuses a tenant proxyUrl unless grandfathered', () => {
    const t: RouteScope = { origin: 'tenant', proxyUrl: 'https://old.example' };
    expect(r('https://a.example', 'model', t).code).toBe('proxy_url_not_allowed');
    expect(r('https://a.example', 'model', { ...t, proxyUrlGrandfathered: true })).toMatchObject({
      routeName: 'legacy-proxyUrl',
    });
  });

  it('caps classification on inspecting proxies', () => {
    expect(r('https://scan.example', 'model', { classification: 'confidential' }).code).toBe(
      'classification_exceeds_route',
    );
    expect(r('https://scan.example', 'model', { classification: 'internal' }).via).toBe('insp');
    expect(r('https://scan.example', 'model').via).toBe('insp');
    expect(r('https://x.example', 'model', { classification: 'restricted' }).via).toBe('corp');
  });

  it('enforces the air-gapped allowlist on target and proxy host', () => {
    const policy = (a: string) =>
      new EgressPolicy({ airgapped: true, allow: parseAllowlist(a), implicit: [] });
    const n = (a: string) => mk({}, { egress: policy(a) });
    expect(r('https://api.openai.com', 'model', {}, n('proxy.corp.example')).code).toBe(
      'egress_denied',
    );
    expect(r('https://llm.corp.example', 'model', {}, n('llm.corp.example')).code).toBe(
      'proxy_not_allowlisted',
    );
    expect(
      r('https://llm.corp.example', 'model', {}, n('llm.corp.example,proxy.corp.example')).via,
    ).toBe('corp');
  });

  it('is pure and never leaks userinfo or secrets', () => {
    const x = r('https://user:pw@api.example/p?token=abc', 'model');
    expect(JSON.stringify(x)).not.toMatch(/pw|token|abc/);
    expect(x.target).toEqual({ scheme: 'https', host: 'api.example', port: 443 });
    expect(JSON.stringify(x)).not.toMatch(/corp-auth-value/);
  });
});

describe('hosts and ip helpers', () => {
  it('normalizes targets', () => {
    expect(normalizeTarget('HTTPS://API.Example.:8443/x')).toMatchObject({
      host: 'api.example',
      port: 8443,
    });
    expect(normalizeTarget('https://münchen.example')?.host).toBe('xn--mnchen-3ya.example');
    expect(normalizeTarget('http://[::ffff:7f00:1]/')?.host).toBe('127.0.0.1');
    expect(normalizeTarget('ldaps://dir.example')?.port).toBe(636);
    expect(normalizeTarget(new URL('wss://a.example'))?.port).toBe(443);
  });

  it('parses patterns', () => {
    expect(parseHostPattern('*').kind).toBe('any');
    expect(parseHostPattern('*:8443')).toMatchObject({ kind: 'any', port: 8443 });
    expect(parseHostPattern('0.0.0.0/0').kind).toBe('cidr');
    expect(parseHostPattern('::/0:443')).toMatchObject({ kind: 'cidr', port: 443 });
    expect(parseHostPattern('*.corp.example').kind).toBe('suffix');
    for (const bad of ['', 'a b', 'a,b', 'a*b', '*.*.x', 'h:99999', '10.0.0.0/33'])
      expect(() => parseHostPattern(bad), bad).toThrow();
  });

  it('parses NO_PROXY leniently', () => {
    const p = parseNoProxy('localhost, .a.example http://b.example:8080 10.0.0.0/8 bad pattern* *');
    expect(p.length).toBeGreaterThan(4);
    expect(parseNoProxy(undefined)).toEqual([]);
    const t = normalizeTarget('https://x.b.example:8080')!;
    expect(p.some((x) => x.kind === 'suffix' && x.suffix === 'b.example')).toBe(true);
    expect(t.port).toBe(8080);
  });

  it('classifies addresses', () => {
    const c = (s: string) => classifyAddress(parseIp(s)!);
    expect(c('8.8.8.8')).toBe('public');
    expect(c('10.1.1.1')).toBe('private');
    expect(c('100.64.0.1')).toBe('shared');
    expect(c('127.0.0.1')).toBe('loopback');
    expect(c('0.0.0.0')).toBe('unspecified');
    expect(c('169.254.1.1')).toBe('link-local');
    expect(c('224.0.0.1')).toBe('multicast');
    expect(c('240.0.0.1')).toBe('reserved');
    expect(c('::1')).toBe('loopback');
    expect(c('::')).toBe('unspecified');
    expect(c('fd12::1')).toBe('private');
    expect(c('fe80::1')).toBe('link-local');
    expect(c('ff02::1')).toBe('multicast');
    expect(c('2001:db8::1')).toBe('reserved');
    expect(c('2606:4700::1')).toBe('public');
    expect(c('64:ff9b::a00:1')).toBe('private');
    expect(c('64:ff9b::808:808')).toBe('public');
    expect(c('::10.0.0.1')).toBe('private');
    expect(c('fd00:ec2::254')).toBe('metadata');
    expect(c('::ffff:100.100.100.200')).toBe('metadata');
    expect(parseIp('fe80::1%eth0')).toBeNull();
    expect(parseIp('example.com')).toBeNull();
    expect(parseIp('1:2:3:4:5:6:7:8')).not.toBeNull();
    expect(isMetadataName('metadata.goog')).toBe(true);
    expect(isMetadataName('example.com')).toBe(false);
  });

  it('entryMatches and entryCoveredBy', () => {
    const [h] = parseAllowlist('a.example:443');
    expect(entryMatches(h!, 'A.example', 443)).toBe(true);
    expect(entryMatches(h!, 'a.example', 80)).toBe(false);
    const [cidr] = parseAllowlist('10.0.0.0/8');
    expect(entryMatches(cidr!, '10.2.3.4')).toBe(true);
    expect(entryMatches(cidr!, 'example.com')).toBe(false);
    const allow = parseAllowlist('.corp.example, 10.0.0.0/8, ip.example:8443');
    const cov = (t: string) => entryCoveredBy(parseHostPattern(t) as never, allow);
    expect(cov('a.corp.example')).toBe(true);
    expect(cov('*.corp.example')).toBe(true);
    expect(cov('10.1.0.0/16')).toBe(true);
    expect(cov('11.0.0.0/8')).toBe(false);
    expect(cov('other.example')).toBe(false);
    expect(cov('localhost')).toBe(true);
    expect(cov('x.localhost')).toBe(true);
    expect(cov('ip.example:9')).toBe(false);
  });
});

describe('allowPlainHttp compatibility switch', () => {
  it('lets platform destinations use plain http, never tenants', () => {
    expect(r('http://ollama.internal:11434/', 'model').code).toBe('plain_http_refused');
    expect(r('http://ollama.internal:11434/', 'model', { allowPlainHttp: true }).decision).toBe(
      'direct',
    );
    expect(
      r('http://tenant.example.org/', 'model', { origin: 'tenant', allowPlainHttp: true }).code,
    ).toBe('plain_http_refused');
  });
});
