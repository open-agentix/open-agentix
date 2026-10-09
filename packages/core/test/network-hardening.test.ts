import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  classifyAddress,
  compileNetwork,
  legacyProxyFromEnv,
  loadNetworkSettings,
  normalizeTarget,
  parseAllowlist,
  parseIp,
  parseNetworkConfig,
  privateAllowIssue,
  readConfigFile,
  resolveRoute,
  type CompileOptions,
  type NetworkPurpose,
  type RouteScope,
} from '../src/index.js';

const doc = {
  proxies: [
    { name: 'corp', url: 'https://proxy.corp.example:3128' },
    { name: 'partner', url: 'https://proxy.partner.example' },
  ],
  clientCertificates: [
    { name: 'gw', certSecret: 'c', keySecret: 'k' },
    { name: 'other', certSecret: 'c2', keySecret: 'k2' },
  ],
  routes: [
    {
      name: 'gateway',
      match: { hosts: ['gw.corp.example'] },
      via: 'direct',
      clientCertificate: 'gw',
    },
    { name: 'wide', match: { hosts: ['*.example'] }, via: 'direct' },
    { name: 'blocked', match: { hosts: ['evil.example'] }, via: 'deny' },
    { name: 'all', match: { hosts: ['*'] }, via: 'corp' },
  ],
  tenantSelectable: ['corp'],
  tenantSelectableCertificates: ['other'],
  privateAllow: ['10.20.0.0/16'],
};
const mk = (patch: object = {}, opts: CompileOptions = {}) =>
  compileNetwork(parseNetworkConfig({ ...doc, ...patch }).config, opts);
const net = mk();
const r = (url: string, purpose: NetworkPurpose = 'model', scope: RouteScope = {}, n = net) =>
  resolveRoute(url, purpose, scope, n);
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as { code: string }).code;
  }
  return 'none';
};
const tenant: RouteScope = { origin: 'tenant' };

describe('privateAllow validation applies to the file and to the environment', () => {
  it('rejects wildcards, names, wide ranges and forbidden space in the environment variable', () => {
    for (const v of ['*', 'host.example', '.corp.example', '0.0.0.0/1', '128.0.0.0/1', '::/0'])
      expect(code(() => loadNetworkSettings({ OAX_NETWORK_PRIVATE_ALLOW: v }))).toBe(
        'network_config_invalid',
      );
    expect(
      loadNetworkSettings({ OAX_NETWORK_PRIVATE_ALLOW: '10.0.0.0/8,fd00::/8' }).net.privateAllow,
    ).toHaveLength(2);
  });

  it('a wildcard in the environment cannot make a public or loopback tenant target private', () => {
    expect(() => loadNetworkSettings({ OAX_NETWORK_PRIVATE_ALLOW: '*' })).toThrow();
  });

  it('refuses loopback, link-local, unspecified and multicast space, and wide prefixes', () => {
    for (const v of [
      '127.0.0.0/8',
      '127.0.0.1',
      '127.0.0.0/7',
      '169.254.0.0/16',
      '169.254.169.254',
      '0.0.0.0',
      '0.0.0.0/8',
      '224.0.0.0/4',
      '10.0.0.0/7',
      '10.0.0.0/4',
      '::1',
      '::/8',
      'fe80::/10',
      'ff00::/8',
      '::/0',
    ])
      expect(privateAllowIssue(v), v).not.toBeNull();
    for (const v of ['10.0.0.0/8', '192.168.1.5', 'fd00::/8', '172.16.0.0/12', '100.64.0.0/10'])
      expect(privateAllowIssue(v), v).toBeNull();
  });

  it('a configured wide list does not make loopback targets reachable for tenants', () => {
    const wide = { ...net, privateAllow: [] };
    expect(r('http://127.0.0.1:5432', 'catalog', tenant, wide).code).toBe('destination_not_public');
    // even if a pattern reached the compiled list, the resolver ignores forbidden space
    const loose = mk({ privateAllow: [] });
    const patched = {
      ...loose,
      privateAllow: [
        {
          kind: 'cidr' as const,
          version: 4 as const,
          base: 0n,
          bits: 1,
          total: 32,
          port: null,
          raw: 'x',
        },
      ],
    };
    for (const u of [
      'http://127.0.0.1:5432',
      'http://169.254.1.1',
      'http://0.0.0.0',
      'http://224.0.0.1',
    ])
      expect(r(u, 'catalog', tenant, patched).code, u).toBe('destination_not_public');
    expect(r('http://10.1.1.1', 'catalog', tenant, patched).decision).not.toBe('deny');
  });
});

describe('ldap(s) host normalisation', () => {
  it('collapses numeric spellings and refuses non-canonical ones', () => {
    for (const h of [
      '0xa9fea9fe',
      '2852039166',
      '0251.0376.0251.0376',
      '169.254.169.254.',
      '0xA9.0xFE.0xA9.0xFE',
    ])
      for (const scheme of ['ldap', 'ldaps']) {
        const t = normalizeTarget(`${scheme}://${h}/`);
        expect(t === null || t.host === '169.254.169.254', `${scheme}://${h}`).toBe(true);
      }
    expect(normalizeTarget('ldap://0xa9fea9fe')).toBeNull();
    expect(normalizeTarget('ldaps://2852039166:636')).toBeNull();
    expect(normalizeTarget('ldap://%31%32%37.0.0.1')).toBeNull();
    expect(normalizeTarget('ldap://[::FFFF:169.254.169.254]')?.host).toBe('169.254.169.254');
    expect(normalizeTarget('ldap://Dir.Example.:636')).toMatchObject({
      host: 'dir.example',
      port: 636,
    });
  });

  it('the metadata veto and tenant checks apply to ldap targets', () => {
    expect(r('ldaps://0xa9fea9fe', 'identity').code).toBe('invalid_target');
    expect(r('ldaps://169.254.169.254', 'identity').code).toBe('metadata_destination');
    expect(r('ldaps://127.0.0.1', 'identity', tenant).code).toBe('destination_not_public');
    expect(r('ldaps://0177.0.0.1', 'identity', tenant).code).toBe('invalid_target');
  });
});

describe('client certificates for tenants', () => {
  it('a tenant may only name a tenant-selectable certificate', () => {
    expect(r('https://x.example', 'model', { ...tenant, clientCertificate: 'gw' }).code).toBe(
      'client_certificate_not_selectable',
    );
    expect(r('https://x.example', 'model', { ...tenant, clientCertificate: 'nope' }).code).toBe(
      'client_certificate_not_selectable',
    );
    expect(
      r('https://x.example', 'model', { ...tenant, clientCertificate: 'other' }),
    ).toMatchObject({
      decision: 'direct',
      clientCert: 'other',
    });
  });

  it('the tenant choice never overrides the certificate of the route', () => {
    expect(
      r('https://gw.corp.example', 'model', { ...tenant, clientCertificate: 'other' }).clientCert,
    ).toBe('gw');
    expect(r('https://gw.corp.example', 'model', { clientCertificate: 'other' }).clientCert).toBe(
      'other',
    );
  });

  it('validates the list against the configured certificates', () => {
    expect(
      code(() => parseNetworkConfig({ ...doc, tenantSelectableCertificates: ['missing'] })),
    ).toBe('network_config_invalid');
    expect(
      code(() => parseNetworkConfig({ ...doc, tenantSelectableCertificates: ['gw', 'gw'] })),
    ).toBe('network_config_invalid');
  });
});

describe('legacy environment and proxies', () => {
  it('reads a scheme-less host:port as http with a warning, still refuses socks', () => {
    const warnings: string[] = [];
    const l = legacyProxyFromEnv({ HTTPS_PROXY: 'proxy.corp:3128' }, warnings);
    expect(l.httpsProxy).toMatchObject({ host: 'proxy.corp', port: 3128, scheme: 'http' });
    expect(warnings.join()).toMatch(/no scheme/);
    expect(loadNetworkSettings({ http_proxy: '10.0.0.1:8080' }).warnings.join()).toMatch(
      /no scheme/,
    );
    expect(code(() => legacyProxyFromEnv({ HTTPS_PROXY: 'socks5://x:1' }))).toBe(
      'network_config_invalid',
    );
    expect(code(() => loadNetworkSettings({ NODE_TLS_REJECT_UNAUTHORIZED: '0' }))).toBe(
      'tls_insecure',
    );
  });

  it('an empty upper-case variable does not shadow the lower-case one', () => {
    const l = legacyProxyFromEnv({ HTTPS_PROXY: '  ', https_proxy: 'https://lower.example:1' });
    expect(l.httpsProxy?.host).toBe('lower.example');
    expect(
      legacyProxyFromEnv({ HTTPS_PROXY: 'https://up.example', https_proxy: 'https://lo.example' })
        .httpsProxy?.host,
    ).toBe('up.example');
  });

  it('the digest covers environment proxies and NO_PROXY', () => {
    const d = (env: Record<string, string>) => loadNetworkSettings(env, {}).net.digest;
    const base = d({});
    expect(d({ HTTPS_PROXY: 'https://p.example' })).not.toBe(base);
    expect(d({ NO_PROXY: 'a.example' })).not.toBe(base);
    expect(d({ NO_PROXY: 'a.example' })).not.toBe(d({ NO_PROXY: 'b.example' }));
    expect(d({ HTTPS_PROXY: 'https://p.example' })).toBe(d({ https_proxy: 'https://p.example' }));
  });

  it('rejects metadata and non-public proxyUrl hosts for tenants, also grandfathered', () => {
    for (const grandfathered of [false, true])
      for (const proxyUrl of [
        'http://169.254.169.254:80',
        'http://127.0.0.1:3128',
        'http://10.5.5.5:3128',
        'http://localhost:3128',
        'http://metadata.google.internal',
        'http://[::1]:3128',
      ])
        expect(
          r('https://api.other.test', 'model', {
            ...tenant,
            proxyUrl,
            proxyUrlGrandfathered: grandfathered,
          }).code,
          `${proxyUrl} ${grandfathered}`,
        ).toBe('proxy_url_not_allowed');
    expect(
      r('https://api.other.test', 'model', {
        ...tenant,
        proxyUrl: 'https://proxy.public.test:8080',
        proxyUrlGrandfathered: true,
      }).decision,
    ).toBe('proxy');
    // an operator-opened private range can host a grandfathered proxy
    expect(
      r('https://api.other.test', 'model', {
        ...tenant,
        proxyUrl: 'http://10.20.1.1:3128',
        proxyUrlGrandfathered: true,
      }).decision,
    ).toBe('proxy');
    // platform-origin proxyUrl is operator input
    expect(
      r('https://api.other.test', 'model', { proxyUrl: 'http://10.5.5.5:3128' }).decision,
    ).toBe('proxy');
  });
});

describe('address classification', () => {
  const c = (s: string) => classifyAddress(parseIp(s)!);
  it('classifies tunnelling prefixes and extra metadata addresses', () => {
    expect(c('2002:a9fe:a9fe::')).toBe('metadata');
    expect(c('2002:7f00:1::1')).toBe('loopback');
    expect(c('2002:0a00:0001::')).toBe('private');
    expect(c('2002:0808:0808::')).toBe('public');
    expect(c('2001::1')).toBe('reserved');
    expect(c('2001:0:4136:e378:8000:63bf:3fff:fdd2')).toBe('reserved');
    expect(c('fec0::1')).toBe('private');
    expect(c('64:ff9b:1::1')).toBe('reserved');
    expect(c('64:ff9b::a9fe:a9fe')).toBe('metadata');
    expect(c('2001:4860:4860::8888')).toBe('public');
    expect(c('169.254.170.23')).toBe('metadata');
    expect(c('192.0.0.192')).toBe('metadata');
    expect(c('192.0.0.8')).toBe('reserved');
  });
});

describe('deny routes', () => {
  it('veto regardless of order, with the ADR code', () => {
    const x = r('https://evil.example');
    expect(x).toMatchObject({ decision: 'deny', code: 'egress_denied', routeName: 'blocked' });
    expect(r('https://evil.example', 'model', { proxy: 'corp' }).code).toBe('egress_denied');
    expect(r('https://fine.example').decision).toBe('direct');
  });
});

describe('ldap and plain-text purposes', () => {
  it('ldap is never sent through an HTTP proxy', () => {
    const viaRoute = mk({ routes: [{ name: 'all', match: { hosts: ['*'] }, via: 'corp' }] });
    expect(r('ldaps://dir.example', 'identity', {}, viaRoute).code).toBe(
      'proxy_unsupported_scheme',
    );
    expect(r('ldaps://dir.example', 'identity', { proxy: 'corp' }, viaRoute).code).toBe(
      'proxy_unsupported_scheme',
    );
    expect(
      r('ldaps://dir.example', 'identity', { proxyUrl: 'https://p.example' }, viaRoute).code,
    ).toBe('proxy_unsupported_scheme');
    const env = mk(
      { routes: [] },
      { legacy: legacyProxyFromEnv({ HTTP_PROXY: 'http://env.example' }) },
    );
    expect(r('ldaps://dir.example', 'identity', {}, env)).toMatchObject({ decision: 'direct' });
    expect(r('ldaps://dir.example', 'identity', {}, env).reasons.join()).toMatch(/never sent/);
  });

  it('identity refuses plain ldap://, mcp is TLS-only for tenants only', () => {
    const n = mk({ routes: [] });
    expect(r('ldap://dir.example', 'identity', {}, n).code).toBe('plain_http_refused');
    expect(r('ldap://10.20.1.1', 'identity', {}, n).decision).toBe('direct'); // privateAllow
    expect(r('ldap://localhost', 'identity', {}, n).decision).toBe('direct');
    expect(r('ldap://dir.example', 'catalog', {}, n).decision).toBe('direct');
    expect(r('http://mcp.example/x', 'mcp').decision).toBe('direct');
    expect(r('http://mcp.example/x', 'mcp', tenant).code).toBe('plain_http_refused');
    expect(r('https://mcp.example/x', 'mcp', tenant).decision).toBe('direct');
  });
});

describe('allowlist CIDR parsing', () => {
  it('rejects /0, empty, signed and non-digit prefixes', () => {
    for (const v of [
      '10.0.0.0/0',
      '10.0.0.0/',
      '10.0.0.0/-1',
      '10.0.0.0/+8',
      '10.0.0.0/8x',
      '10.0.0.0/0008x',
      '10.0.0.0/1e1',
      '10.0.0.0/33',
      'fd00::/0',
      'fd00::/129',
      '10.0.0.0/ 8',
    ])
      expect(() => parseAllowlist(v), v).toThrow();
    expect(parseAllowlist('10.0.0.0/8,fd00::/8')).toHaveLength(2);
  });
});

describe('bounded config file reads', () => {
  it('reads regular files and refuses devices, FIFOs, directories and oversized files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oax-net-'));
    try {
      const ok = join(dir, 'ok.yaml');
      writeFileSync(ok, 'proxies: []\n');
      expect(readConfigFile(ok)).toBe('proxies: []\n');
      expect(() => readConfigFile('/dev/zero')).toThrow(/regular file/);
      expect(() => readConfigFile(dir)).toThrow(/regular file/);
      const fifo = join(dir, 'fifo');
      execFileSync('mkfifo', [fifo]);
      expect(() => readConfigFile(fifo)).toThrow(/regular file/);
      const big = join(dir, 'big.yaml');
      writeFileSync(big, Buffer.alloc(1024 * 1024 + 1, 0x20));
      expect(() => readConfigFile(big)).toThrow(/larger than 1 MiB/);
      expect(() => loadNetworkSettings({ OAX_NETWORK_CONFIG_FILE: '/dev/zero' })).toThrow(
        /cannot read/,
      );
      writeFileSync(join(dir, 'exact.yaml'), Buffer.alloc(1024 * 1024, 0x20));
      expect(readConfigFile(join(dir, 'exact.yaml'))).toHaveLength(1024 * 1024);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
