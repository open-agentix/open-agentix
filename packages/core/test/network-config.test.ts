import { describe, expect, it } from 'vitest';
import {
  EgressPolicy,
  assertTlsVerificationOn,
  checkNetworkAirgap,
  compileNetwork,
  compileProxyUrl,
  loadNetworkSettings,
  parseAllowlist,
  parseNetworkConfig,
  scanForbiddenKeys,
} from '../src/index.js';

const base = {
  proxies: [
    { name: 'corp', url: 'https://proxy.corp.example:3128', authSecret: 'platform.corp-auth' },
    { name: 'partner', url: 'https://proxy.partner.example' },
  ],
  trust: { mode: 'system+extra', bundles: [{ name: 'corp-ca', file: '/etc/ca/corp.pem' }] },
  clientCertificates: [{ name: 'gw', certSecret: 'c', keySecret: 'k' }],
  routes: [
    { name: 'private', match: { hosts: ['*.vpce.amazonaws.com'] }, via: 'direct' },
    { match: { hosts: ['*'] }, via: 'corp' },
  ],
  tenantSelectable: ['corp'],
};

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as { code: string }).code;
  }
  return 'none';
};

describe('parseNetworkConfig', () => {
  it('accepts a full valid document and defaults optional parts', () => {
    const { config, warnings } = parseNetworkConfig(base);
    expect(config.proxies).toHaveLength(2);
    expect(config.tenantDirect).toBe(false);
    expect(warnings).toEqual([]);
    expect(parseNetworkConfig(null).config.routes).toEqual([]);
  });

  it('refuses plain http proxies in production with a dedicated code, warns otherwise', () => {
    const doc = { proxies: [{ name: 'p', url: 'http://proxy.example:3128' }] };
    expect(code(() => parseNetworkConfig(doc, { production: true }))).toBe('proxy_plain_http');
    expect(parseNetworkConfig(doc).warnings[0]).toMatch(/plain http/);
  });

  it('refuses credentials in URLs, paths and non-http schemes', () => {
    for (const url of [
      'https://user:pw@proxy.example',
      'https://proxy.example/path',
      'https://proxy.example/?a=1',
      'socks5://proxy.example',
      'not a url',
    ])
      expect(code(() => parseNetworkConfig({ proxies: [{ name: 'p', url }] }))).toBe(
        'network_config_invalid',
      );
  });

  it('never echoes a credential from a URL in the error message', () => {
    try {
      parseNetworkConfig({ proxies: [{ name: 'p', url: 'https://u:s3cret-value@proxy.example' }] });
    } catch (e) {
      expect((e as Error).message).not.toContain('s3cret-value');
    }
  });

  it('refuses keys that disable TLS verification and prototype keys anywhere', () => {
    expect(code(() => parseNetworkConfig({ ...base, insecure: true }))).toBe(
      'network_config_invalid',
    );
    expect(
      code(() =>
        parseNetworkConfig({
          proxies: [{ name: 'p', url: 'https://p.example', rejectUnauthorized: false }],
        }),
      ),
    ).toBe('network_config_invalid');
    const issues = scanForbiddenKeys(JSON.parse('{"a":{"__proto__":{}},"verify_tls":false}'));
    expect(issues.map((i) => i.path).sort()).toEqual(['a.__proto__', 'verify_tls']);
    let deep: unknown = {};
    for (let i = 0; i < 30; i++) deep = { x: deep };
    expect(scanForbiddenKeys(deep)[0]?.message).toMatch(/nested/);
  });

  it('rejects unknown keys and bad names', () => {
    expect(code(() => parseNetworkConfig({ extra: 1 }))).toBe('network_config_invalid');
    expect(
      code(() => parseNetworkConfig({ proxies: [{ name: 'a b', url: 'https://p.example' }] })),
    ).toBe('network_config_invalid');
  });

  it('checks cross references and uniqueness', () => {
    const bad = (patch: object) => code(() => parseNetworkConfig({ ...base, ...patch }));
    expect(bad({ routes: [{ match: { hosts: ['a.example'] }, via: 'nope' }] })).toBe(
      'network_config_invalid',
    );
    expect(bad({ tenantSelectable: ['nope'] })).toBe('network_config_invalid');
    expect(bad({ tenantSelectable: ['corp', 'corp'] })).toBe('network_config_invalid');
    expect(bad({ proxies: [...base.proxies, { name: 'corp', url: 'https://x.example' }] })).toBe(
      'network_config_invalid',
    );
    expect(bad({ proxies: [{ name: 'direct', url: 'https://x.example' }] })).toBe(
      'network_config_invalid',
    );
    expect(bad({ proxies: [{ name: 'p', url: 'https://x.example', caBundle: 'missing' }] })).toBe(
      'network_config_invalid',
    );
    expect(bad({ proxies: [{ name: 'p', url: 'http://x.example', caBundle: 'corp-ca' }] })).toBe(
      'network_config_invalid',
    );
    expect(
      bad({
        routes: [{ match: { hosts: ['a.example'] }, via: 'direct', clientCertificate: 'nope' }],
      }),
    ).toBe('network_config_invalid');
    expect(
      bad({ routes: [{ match: { hosts: ['a.example'] }, via: 'deny', clientCertificate: 'gw' }] }),
    ).toBe('network_config_invalid');
    expect(bad({ routes: [{ match: { hosts: ['bad pattern'] }, via: 'direct' }] })).toBe(
      'network_config_invalid',
    );
    expect(bad({ trust: { mode: 'extra-only', bundles: [] } })).toBe('network_config_invalid');
    expect(bad({ trust: { bundles: [{ name: 'x' }] } })).toBe('network_config_invalid');
    expect(bad({ trust: { bundles: [{ name: 'x', file: '/a', secret: 's' }] } })).toBe(
      'network_config_invalid',
    );
    expect(bad({ trust: { bundles: [{ name: 'x', file: 'relative.pem' }] } })).toBe(
      'network_config_invalid',
    );
    expect(
      bad({ proxies: [{ name: 'p', url: 'https://x.example', authSecret: 'user:password' }] }),
    ).toBe('network_config_invalid');
  });

  it('validates privateAllow as IPs and CIDRs only', () => {
    expect(
      parseNetworkConfig({ privateAllow: ['10.0.0.0/8', 'fd00::/8', '192.168.1.5'] }).config
        .privateAllow,
    ).toHaveLength(3);
    for (const v of ['*', '.corp.example', 'host.example', '0.0.0.0/0', '10.0.0.0/99'])
      expect(code(() => parseNetworkConfig({ privateAllow: [v] }))).toBe('network_config_invalid');
  });

  it('warns about unreachable routes behind a catch-all', () => {
    const { warnings } = parseNetworkConfig({
      proxies: [{ name: 'p', url: 'https://p.example' }],
      routes: [
        { match: { hosts: ['*'] }, via: 'p' },
        { match: { hosts: ['a.example'] }, via: 'direct' },
      ],
    });
    expect(warnings[0]).toMatch(/unreachable/);
  });
});

describe('compileNetwork and legacy environment', () => {
  it('compiles proxies without credentials and sets inspection defaults', () => {
    const cfg = parseNetworkConfig({
      proxies: [
        { name: 'insp', url: 'https://[2001:db8::1]:8443', tlsInspection: true },
        { name: 'plain', url: 'https://p.example', maxClassification: 'confidential' },
      ],
    }).config;
    const net = compileNetwork(cfg);
    expect(net.proxies.get('insp')).toMatchObject({
      url: 'https://[2001:db8::1]:8443',
      maxClassification: 'internal',
    });
    expect(net.proxies.get('plain')).toMatchObject({
      url: 'https://p.example',
      port: 443,
      maxClassification: 'confidential',
    });
    expect(net.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(compileNetwork(cfg).digest).toBe(net.digest);
  });

  it('refuses to compile an invalid configuration', () => {
    expect(
      code(() => compileNetwork({ ...parseNetworkConfig({}).config, tenantSelectable: ['x'] })),
    ).toBe('network_config_invalid');
  });

  it('compileProxyUrl flags userinfo without keeping it', () => {
    const p = compileProxyUrl('http://u:pw@proxy.example:8080', 'x', 'env');
    expect(p).toMatchObject({ url: 'http://proxy.example:8080', envUserinfo: true });
    expect(JSON.stringify(p)).not.toContain('pw');
    expect(compileProxyUrl('ftp://x', 'x', 'env')).toBeNull();
    expect(compileProxyUrl('garbage', 'x', 'env')).toBeNull();
  });

  it('loads defaults, inline JSON and a file; maps the legacy environment', () => {
    const none = loadNetworkSettings({});
    expect(none).toMatchObject({ source: 'none', testEnabled: true });
    const env = loadNetworkSettings({
      OAX_NETWORK_CONFIG: JSON.stringify(base),
      HTTPS_PROXY: 'http://legacy.example:3128',
      NO_PROXY: 'localhost,.internal.example',
      OAX_NETWORK_TEST_ENABLED: 'false',
      OAX_NETWORK_PRIVATE_ALLOW: '10.0.0.0/8, 172.16.0.0/12',
    });
    expect(env.source).toBe('env');
    expect(env.testEnabled).toBe(false);
    expect(env.net.legacy.httpsProxy?.host).toBe('legacy.example');
    expect(env.net.privateAllow).toHaveLength(2);
    expect(env.warnings.join()).toMatch(/plain http/);
    const file = loadNetworkSettings(
      { OAX_NETWORK_CONFIG_FILE: '/etc/oax/network.yaml' },
      {
        readFile: () =>
          'proxies:\n  - name: corp\n    url: https://p.example\nroutes:\n  - match: {hosts: ["*"]}\n    via: corp\n',
      },
    );
    expect(file.source).toBe('file');
    expect(file.net.routes[0]?.via).toBe('corp');
  });

  it('fails closed on bad sources', () => {
    const c = (env: Record<string, string>, readFile?: (p: string) => string) =>
      code(() => loadNetworkSettings(env, readFile ? { readFile } : {}));
    expect(c({ OAX_NETWORK_CONFIG_FILE: '/a', OAX_NETWORK_CONFIG: '{}' })).toBe(
      'network_config_invalid',
    );
    expect(c({ OAX_NETWORK_CONFIG: '{not json' })).toBe('network_config_invalid');
    expect(c({ OAX_NETWORK_CONFIG_FILE: '/a' }, () => ': : :\n- [')).toBe('network_config_invalid');
    expect(
      c({ OAX_NETWORK_CONFIG_FILE: '/missing' }, () => {
        throw new Error('ENOENT');
      }),
    ).toBe('network_config_invalid');
    expect(c({ OAX_NETWORK_CONFIG_FILE: '/definitely/not/there.yaml' })).toBe(
      'network_config_invalid',
    );
    expect(c({ HTTPS_PROXY: 'socks5://x' })).toBe('network_config_invalid');
    expect(c({ HTTPS_PROXY: 'garbage url' })).toBe('network_config_invalid');
    expect(c({ NODE_TLS_REJECT_UNAUTHORIZED: '0' })).toBe('tls_insecure');
    expect(() => assertTlsVerificationOn({ NODE_TLS_REJECT_UNAUTHORIZED: '1' })).not.toThrow();
    expect(
      code(() =>
        loadNetworkSettings(
          { OAX_NETWORK_CONFIG: '{"proxies":[{"name":"p","url":"http://p.example"}]}' },
          { production: true },
        ),
      ),
    ).toBe('proxy_plain_http');
  });
});

describe('checkNetworkAirgap', () => {
  const policy = (allow: string) =>
    new EgressPolicy({ airgapped: true, allow: parseAllowlist(allow), implicit: [] });
  const net = (doc: object) => compileNetwork(parseNetworkConfig(doc).config);

  it('is a no-op outside air-gapped mode', () => {
    const open = new EgressPolicy({ airgapped: false, allow: [], implicit: [] });
    expect(checkNetworkAirgap(net(base), open)).toEqual([]);
  });

  it('requires proxy hosts and route patterns inside the allowlist', () => {
    const doc = {
      proxies: [{ name: 'p', url: 'https://proxy.corp.example:3128' }],
      routes: [
        { match: { hosts: ['llm.corp.example'] }, via: 'p' },
        { match: { hosts: ['10.1.0.0/16'] }, via: 'direct' },
        { match: { hosts: ['*'] }, via: 'deny' },
      ],
    };
    expect(checkNetworkAirgap(net(doc), policy('.corp.example, 10.0.0.0/8'))).toEqual([]);
    const problems = checkNetworkAirgap(net(doc), policy('other.example'));
    expect(problems.join('|')).toMatch(/proxy "p"/);
    expect(problems.join('|')).toMatch(/llm\.corp\.example/);
  });

  it('refuses a catch-all that is not a deny', () => {
    const problems = checkNetworkAirgap(
      net({
        proxies: [{ name: 'p', url: 'https://p.example' }],
        routes: [{ match: { hosts: ['*'] }, via: 'p' }],
      }),
      policy('p.example'),
    );
    expect(problems.join()).toMatch(/matches every destination/);
  });
});
