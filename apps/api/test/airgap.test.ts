import { StaticSecretResolver, getEgressPolicy } from '@openagentix/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  activateAirgap,
  checkAirgapConfig,
  checkStoredConnections,
  connectionEndpoints,
  providerEndpoints,
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

  it('checks stored connections: MCP servers and BYOK model connections', () => {
    const p = buildPolicy(
      cfg({ OAX_AIRGAPPED: 'true', OAX_AIRGAPPED_ALLOW: 'mcp.internal,vllm.internal:8000' }),
    );
    const mcp = (name: string, config: object) => ({ name, kind: 'mcp', config });
    const model = (name: string, config: object) => ({ name, kind: 'model', config });
    expect(
      checkStoredConnections(
        [
          mcp('ok', { transport: 'streamable-http', url: 'https://mcp.internal/x' }),
          mcp('bad', { transport: 'streamable-http', url: 'https://tools.vendor.example/x' }),
          mcp('broken', { transport: 'streamable-http', url: 'nonsense' }),
          mcp('mem', { transport: 'in-memory' }),
          model('local', { kind: 'vllm', baseUrl: 'http://vllm.internal:8000/v1' }),
          model('wrong-port', { kind: 'vllm', baseUrl: 'http://vllm.internal:9999/v1' }),
          model('gpt', { kind: 'openai', apiKeySecret: 'k' }),
          model('claude', {
            kind: 'anthropic',
            apiKeySecret: 'k',
            proxyUrl: 'http://px.example:3128',
          }),
          model('azure', {
            kind: 'azure-openai',
            endpoint: 'https://res.openai.azure.com',
            apiKeySecret: 'k',
          }),
          model('aws', { kind: 'bedrock', region: 'eu-west-1' }),
          model('sim', { kind: 'simulated' }),
          { name: 'other', kind: 'something-else', config: {} },
        ],
        p,
      ),
    ).toEqual([
      'MCP connection "bad": tools.vendor.example is not on OAX_AIRGAPPED_ALLOW',
      'MCP connection "broken": invalid URL',
      'model connection "wrong-port": vllm.internal:9999 is not on OAX_AIRGAPPED_ALLOW',
      'model connection "gpt": api.openai.com is not on OAX_AIRGAPPED_ALLOW',
      'model connection "claude": api.anthropic.com is not on OAX_AIRGAPPED_ALLOW',
      'model connection "claude" proxy: px.example:3128 is not on OAX_AIRGAPPED_ALLOW',
      'model connection "azure": res.openai.azure.com is not on OAX_AIRGAPPED_ALLOW',
      'model connection "aws": bedrock-runtime.eu-west-1.amazonaws.com is not on OAX_AIRGAPPED_ALLOW',
    ]);
    expect(
      checkStoredConnections(
        [mcp('x', { transport: 'streamable-http', url: 'https://a.example' })],
        buildPolicy(cfg()),
      ),
    ).toEqual([]);
  });

  it('knows the default endpoint of every provider kind', () => {
    const urls = (settings: object) => providerEndpoints(settings, 'p').map((e) => e.url);
    expect(urls({ kind: 'openai' })).toEqual(['https://api.openai.com/v1']);
    expect(urls({ kind: 'openrouter' })).toEqual(['https://openrouter.ai/api/v1']);
    expect(urls({ kind: 'anthropic' })).toEqual(['https://api.anthropic.com']);
    expect(urls({ kind: 'ollama' })).toEqual(['http://localhost:11434']);
    expect(urls({ kind: 'lmstudio' })).toEqual(['http://localhost:1234/v1']);
    expect(urls({ kind: 'bedrock', region: 'us-east-1' })).toEqual([
      'https://bedrock-runtime.us-east-1.amazonaws.com',
    ]);
    expect(
      urls({ kind: 'bedrock', region: 'us-east-1', endpoint: 'https://vpce.internal' }),
    ).toEqual(['https://vpce.internal']);
    expect(urls({ kind: 'openai-compatible', baseUrl: 'http://gw.internal/v1' })).toEqual([
      'http://gw.internal/v1',
    ]);
    expect(urls({ kind: 'simulated', proxyUrl: 'http://ignored' })).toEqual([]);
    expect(urls({ kind: 'bedrock' })).toEqual([]);
    expect(connectionEndpoints('mcp', 'x', undefined)).toEqual([]);
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

  it('guards BYOK model connections, the connection test endpoint and keeps the catalog offline', async () => {
    const sent: string[] = [];
    const fakeFetch = async (url: string) => {
      sent.push(url);
      return new Response(
        JSON.stringify({
          model: 'llama',
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    n = await testNode(
      { OAX_AIRGAPPED: 'true', OAX_AIRGAPPED_ALLOW: 'vllm.internal' },
      { secrets: new StaticSecretResolver({ key: 'k' }), fetchImpl: fakeFetch },
    );
    const model = (name: string, config: object) =>
      n.req({ method: 'POST', url: '/v1/connections', payload: { name, kind: 'model', config } });

    // creating or changing a connection to a public endpoint is refused, nothing is stored
    for (const [name, cfgBody] of [
      ['gpt', { kind: 'openai', apiKeySecret: 'key' }],
      ['claude', { kind: 'anthropic', apiKeySecret: 'key' }],
      ['router', { kind: 'openrouter', apiKeySecret: 'key' }],
      ['aws', { kind: 'bedrock', region: 'eu-central-1' }],
      [
        'via-proxy',
        { kind: 'vllm', baseUrl: 'http://vllm.internal/v1', proxyUrl: 'http://proxy.example:3128' },
      ],
    ] as const) {
      const r = await model(name, cfgBody);
      expect(r.statusCode, name).toBe(422);
      expect(r.json().error).toBe('egress_denied');
    }
    const local = await model('local', {
      kind: 'vllm',
      baseUrl: 'http://vllm.internal/v1',
      models: [{ id: 'llama-3' }],
    });
    expect(local.statusCode).toBe(201);
    const refusedUpdate = await n.req({
      method: 'PUT',
      url: `/v1/connections/${local.json().id}`,
      payload: { config: { kind: 'vllm', baseUrl: 'http://elsewhere.example/v1' } },
    });
    expect(refusedUpdate.statusCode).toBe(422);

    // the test endpoint works for an allowlisted endpoint ...
    const ok = await n.req({
      method: 'POST',
      url: `/v1/connections/${local.json().id}/test`,
      payload: { model: 'llama-3' },
    });
    expect(ok.json()).toMatchObject({ ok: true, error: null });
    expect(sent).toEqual(['http://vllm.internal/v1/chat/completions']);

    // ... and a connection stored before air-gapped mode was switched on cannot reach the internet
    // even though a fetch implementation is injected: the policy is checked first.
    await n.ctx.database.db.execute(
      `insert into connections (id, tenant_id, scope, name, kind, config)
       select gen_random_uuid(), tenant_id, 'tenant', 'legacy-gpt', 'model',
              '{"kind":"openai","baseUrl":"https://api.openai.com/v1","apiKeySecret":"key"}'::jsonb
       from connections limit 1` as never,
    );
    const legacy = (await n.req({ method: 'GET', url: '/v1/connections' }))
      .json()
      .items.find((c: { name: string }) => c.name === 'legacy-gpt');
    const blocked = await n.req({
      method: 'POST',
      url: `/v1/connections/${legacy.id}/test`,
      payload: { model: 'gpt-4.1' },
    });
    expect(blocked.json().ok).toBe(false);
    expect(blocked.json().error).toMatch(/air-gapped/);
    expect(sent).toHaveLength(1);

    // price proposals and the model list come from the vendored snapshot: no egress attempt at all
    const before = getEgressPolicy().status().blocked;
    const proposals = await n.req({
      method: 'POST',
      url: '/v1/models/proposals',
      payload: { provider: 'anthropic' },
    });
    expect(proposals.statusCode).toBe(200);
    expect(proposals.json().items.length).toBeGreaterThan(5);
    expect((await n.req({ method: 'GET', url: '/v1/models?provider=openai' })).statusCode).toBe(
      200,
    );
    expect(getEgressPolicy().status().blocked).toBe(before);
  }, 120_000);

  it('is not air-gapped by default', async () => {
    n = await testNode();
    const ready = await n.req({ method: 'GET', url: '/readyz', token: null });
    expect(ready.json().airgapped).toEqual({ enabled: false, allowlist: 0, blockedAttempts: 0 });
  }, 120_000);
});
