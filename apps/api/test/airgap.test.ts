import { getEgressPolicy } from '@openagentix/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  activateAirgap,
  checkAirgapConfig,
  checkMcpConnections,
  configuredEndpoints,
  deactivateAirgap,
  loadConfig,
  buildPolicy,
} from '../src/index.js';
import { testNode, type TestNode } from './helpers.js';

const base = { OAX_DATABASE_URL: 'memory://', NODE_ENV: 'test' };
const cfg = (env: Record<string, string> = {}) => loadConfig({ ...base, ...env });

afterEach(() => deactivateAirgap());

describe('air-gapped start-up self-check', () => {
  it('is off by default and the default simulated setup is compliant when on', () => {
    expect(cfg().airgap).toMatchObject({ enabled: false, allow: '' });
    expect(checkAirgapConfig(cfg())).toEqual([]);
    expect(checkAirgapConfig(cfg({ OAX_AIRGAPPED: 'true' }), undefined, {})).toEqual([]);
  });

  it('lists every enabled endpoint outside the allowlist', () => {
    const c = cfg({
      OAX_AIRGAPPED: 'true',
      OAX_PROVIDERS: JSON.stringify([
        { kind: 'anthropic', name: 'a', apiKeySecret: 'k' },
        { kind: 'openai', name: 'o', baseUrl: 'https://llm.internal.example/v1' },
        { kind: 'ollama', name: 'l' },
        {
          kind: 'bedrock',
          name: 'b',
          region: 'eu-central-1',
          proxyUrl: 'http://proxy.example:3128',
        },
        { kind: 'simulated', name: 's' },
      ]),
      OAX_OIDC_ISSUER: 'https://idp.example.com/realms/x',
      OAX_OIDC_CLIENT_ID: 'c',
      OAX_OIDC_REDIRECT_URI: 'https://oax.example.com/cb',
      OAX_LDAP_URL: 'ldaps://ldap.example.com',
      OAX_LDAP_USER_BASE_DN: 'ou=p',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com',
      OAX_CATALOG_REFRESH_URL: 'https://models.dev/api.json',
      OAX_WEBHOOK_OUT_URLS: 'https://hooks.example.com/x',
    });
    const problems = checkAirgapConfig(c, undefined, { HTTPS_PROXY: 'http://egress.example:3128' });
    const text = problems.join('\n');
    for (const needle of [
      'provider "a": api.anthropic.com',
      'provider "o": llm.internal.example',
      'bedrock-runtime.eu-central-1.amazonaws.com',
      'proxy.example:3128',
      'OIDC issuer: idp.example.com',
      'LDAP: ldap.example.com',
      'OpenTelemetry exporter: otel.example.com',
      'model catalog refresh: models.dev',
      'outbound webhook: hooks.example.com',
      'HTTPS_PROXY proxy: egress.example:3128',
      'vendored snapshot only',
    ])
      expect(text).toContain(needle);
    expect(text).not.toContain('provider "l"'); // loopback ollama default
    expect(text).not.toContain('provider "s"');
  });

  it('passes once the endpoints are allowlisted (except the catalog refresh, never allowed)', () => {
    const env = {
      OAX_AIRGAPPED: 'true',
      OAX_AIRGAPPED_ALLOW: 'llm.internal.example,.corp.example,10.0.0.0/8',
      OAX_PROVIDERS: JSON.stringify([
        { kind: 'openai', name: 'o', baseUrl: 'https://llm.internal.example/v1' },
        { kind: 'anthropic', name: 'a', apiKeySecret: 'k', baseUrl: 'https://gw.corp.example' },
      ]),
      OAX_OIDC_ISSUER: 'https://10.1.2.3/realms/x',
      OAX_OIDC_CLIENT_ID: 'c',
      OAX_OIDC_REDIRECT_URI: 'https://oax.example.com/cb',
    };
    expect(checkAirgapConfig(cfg(env), undefined, {})).toEqual([]);
    expect(
      checkAirgapConfig(
        cfg({ ...env, OAX_CATALOG_REFRESH_URL: 'https://gw.corp.example/m' }),
        undefined,
        {},
      ),
    ).toEqual([
      'model catalog refresh is not available in air-gapped mode (vendored snapshot only)',
    ]);
  });

  it('treats the database and cache hosts as implicit infrastructure', () => {
    const c = cfg({
      OAX_AIRGAPPED: 'true',
      OAX_DATABASE_URL: 'postgres://u@pg.cluster.local:5432/db',
      OAX_CACHE_URL: 'redis://valkey.cluster.local:6379',
    });
    const p = buildPolicy(c);
    expect(p.isAllowed('pg.cluster.local', 5432)).toBe(true);
    expect(p.isAllowed('valkey.cluster.local', 6379)).toBe(true);
    expect(p.isAllowed('other.cluster.local')).toBe(false);
  });

  it('activateAirgap fails closed with a stable error code and installs nothing', () => {
    const bad = cfg({
      OAX_AIRGAPPED: 'true',
      OAX_PROVIDERS: JSON.stringify([{ kind: 'anthropic', name: 'a', apiKeySecret: 'k' }]),
    });
    expect(() => activateAirgap(bad, {})).toThrowError(/refusing to start/);
    try {
      activateAirgap(bad, {});
    } catch (e) {
      expect((e as { code: string }).code).toBe('airgap_violation');
    }
    expect(getEgressPolicy().airgapped).toBe(false);
  });

  it('exposes the configured endpoints (also for malformed provider proxies)', () => {
    const c = cfg({
      OAX_PROVIDERS: JSON.stringify([{ kind: 'ollama', name: 'l', baseUrl: 'http://o:1' }]),
    });
    expect(configuredEndpoints(c, {})).toEqual([{ purpose: 'provider "l"', url: 'http://o:1' }]);
  });

  it('checks stored MCP connections', () => {
    const p = buildPolicy(cfg({ OAX_AIRGAPPED: 'true', OAX_AIRGAPPED_ALLOW: 'mcp.internal' }));
    expect(
      checkMcpConnections(
        [
          { name: 'ok', config: { transport: 'streamable-http', url: 'https://mcp.internal/x' } },
          {
            name: 'bad',
            config: { transport: 'streamable-http', url: 'https://tools.vendor.example/x' },
          },
          { name: 'broken', config: { transport: 'streamable-http', url: 'nonsense' } },
          { name: 'mem', config: { transport: 'in-memory' } },
        ],
        p,
      ),
    ).toEqual([
      'MCP connection "bad": tools.vendor.example is not on OAX_AIRGAPPED_ALLOW',
      'MCP connection "broken": invalid URL',
    ]);
    expect(
      checkMcpConnections(
        [{ name: 'x', config: { transport: 'streamable-http', url: 'https://a.example' } }],
        buildPolicy(cfg()),
      ),
    ).toEqual([]);
  });
});

describe('air-gapped control node', () => {
  let n: TestNode;
  afterEach(async () => {
    await n?.close();
  });

  it('reports the state on /readyz and refuses non-allowlisted MCP endpoints', async () => {
    n = await testNode({ OAX_AIRGAPPED: 'true', OAX_AIRGAPPED_ALLOW: 'mcp.internal' });
    const ready = await n.req({ method: 'GET', url: '/readyz', token: null });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().airgapped).toEqual({ enabled: true, allowlist: 1, blockedAttempts: 0 });

    const ok = await n.req({
      method: 'POST',
      url: '/v1/connections',
      payload: {
        name: 'good',
        config: { transport: 'streamable-http', url: 'https://mcp.internal/mcp' },
      },
    });
    expect(ok.statusCode).toBe(201);
    const bad = await n.req({
      method: 'POST',
      url: '/v1/connections',
      payload: {
        name: 'bad',
        config: { transport: 'streamable-http', url: 'https://tools.vendor.example/mcp' },
      },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error).toBe('egress_denied');
    const upd = await n.req({
      method: 'PUT',
      url: `/v1/connections/${ok.json().id}`,
      payload: {
        config: { transport: 'streamable-http', url: 'https://tools.vendor.example/mcp' },
      },
    });
    expect(upd.statusCode).toBe(422);
    const after = await n.req({ method: 'GET', url: '/readyz', token: null });
    expect(after.json().airgapped.blockedAttempts).toBe(2);
  }, 120_000);

  it('is not air-gapped by default', async () => {
    n = await testNode();
    const ready = await n.req({ method: 'GET', url: '/readyz', token: null });
    expect(ready.json().airgapped).toEqual({ enabled: false, allowlist: 0, blockedAttempts: 0 });
  }, 120_000);
});
