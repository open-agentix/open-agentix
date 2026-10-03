import { describe, expect, it } from 'vitest';
import { loadConfig, mapGroupsToBindings } from '../src/config.js';

const base = { OAX_DATABASE_URL: 'memory://', NODE_ENV: 'test' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(base);
    expect(c.port).toBe(8080);
    expect(c.providers).toEqual([{ kind: 'simulated', name: 'simulated' }]);
    expect(c.auth.oidc).toBeNull();
    expect(c.auth.ldap).toBeNull();
    expect(c.auth.bootstrapAdmin).toBeNull();
    expect(c.worker).toMatchObject({ concurrency: 4, leaseSeconds: 60 });
    expect(c.runToken.secret.length).toBeGreaterThanOrEqual(32);
    expect(c.corsOrigins).toEqual([]);
  });

  it('parses auth, JSON and boolean settings', () => {
    const c = loadConfig({
      ...base,
      OAX_PUBLIC_URL: 'https://oax.example.com/',
      OAX_CORS_ORIGINS: 'https://ui.example.com, https://other',
      OAX_TRUST_PROXY: 'true',
      OAX_BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
      OAX_BOOTSTRAP_ADMIN_PASSWORD: 'correct-horse-battery',
      OAX_OIDC_ISSUER: 'https://idp.example.com/realms/oax',
      OAX_OIDC_CLIENT_ID: 'oax',
      OAX_OIDC_REDIRECT_URI: 'https://oax.example.com/v1/auth/oidc/callback',
      OAX_OIDC_ROLE_MAPPING: '{"oax-admins":"admin"}',
      OAX_LDAP_URL: 'ldaps://ldap.example.com',
      OAX_LDAP_USER_BASE_DN: 'ou=people,dc=example,dc=com',
      OAX_LDAP_TLS_REJECT_UNAUTHORIZED: 'no',
      OAX_AUDIT_PUBLIC_KEYS: '{"k1":"pem"}',
      OAX_PRICE_TABLE: '[{"provider":"openai","model":"*","inputPerMTok":1,"outputPerMTok":2}]',
      OAX_PROVIDERS: '[{"kind":"ollama","name":"local"}]',
      OAX_WORKER_CONCURRENCY: '0',
    });
    expect(c.publicUrl).toBe('https://oax.example.com');
    expect(c.corsOrigins).toEqual(['https://ui.example.com', 'https://other']);
    expect(c.trustProxy).toBe(true);
    expect(c.auth.bootstrapAdmin?.email).toBe('admin@example.com');
    expect(c.auth.oidc?.roleMapping).toEqual({ 'oax-admins': 'admin' });
    expect(c.auth.ldap?.tlsRejectUnauthorized).toBe(false);
    expect(c.audit.publicKeys).toEqual({ k1: 'pem' });
    expect(c.priceTable[0]?.perToolCallUsd).toBe(0);
    expect(c.providers[0]?.kind).toBe('ollama');
    expect(c.worker.concurrency).toBe(1);
  });

  it('rejects invalid configuration with readable messages', () => {
    expect(() => loadConfig({})).toThrow(/OAX_DATABASE_URL/);
    expect(() => loadConfig({ ...base, OAX_OIDC_ROLE_MAPPING: '{nope' })).toThrow(/valid JSON/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/OAX_RUN_TOKEN_SECRET/);
    expect(
      loadConfig({ ...base, NODE_ENV: 'production', OAX_RUN_TOKEN_SECRET: 's'.repeat(32) }).env,
    ).toBe('production');
  });
});

describe('mapGroupsToBindings', () => {
  it('maps groups to global and team roles, ignoring unknown roles', () => {
    expect(
      mapGroupsToBindings(['admins', 'sec', 'unknown', 'bad'], {
        admins: 'admin',
        sec: ['operator@team-security', 'viewer'],
        bad: 'root',
      }),
    ).toEqual([
      { role: 'admin', teamSlug: null },
      { role: 'operator', teamSlug: 'team-security' },
      { role: 'viewer', teamSlug: null },
    ]);
  });
});

describe('runner, toolbox, secrets and worker settings', () => {
  it('parses defaults', () => {
    const c = loadConfig(base);
    expect(c.runners.enabled).toEqual(['in-process']);
    expect(c.runners.kubernetesJob).toMatchObject({
      enabled: false,
      namespace: 'openagentix-runs',
      serviceAccountName: 'openagentix-worker',
      imagePullSecrets: [],
    });
    expect(c.toolboxes).toEqual({
      registry: 'ghcr.io/open-agentix',
      allowlist: [],
      requireSignature: true,
    });
    expect(c.workerHttp).toEqual({ host: '0.0.0.0', port: 9090 });
    expect(c.demoMcp).toBe(false);
    expect(c.secrets).toEqual({ dir: undefined, envRefs: [] });
  });

  it('parses the v0.2 Kubernetes Job contract behind its feature flag', () => {
    const c = loadConfig({
      ...base,
      OAX_RUNNERS_ENABLED: 'in-process, kubernetes-job',
      OAX_K8S_JOB_ENABLED: 'true',
      OAX_K8S_NAMESPACE: 'runs',
      OAX_K8S_IMAGE_PULL_SECRETS: 'ghcr, other',
      OAX_K8S_NODE_SELECTOR: '{"pool":"agents"}',
      OAX_K8S_EGRESS: '10.0.0.0/8',
      OAX_TOOLBOX_ALLOWLIST: 'trivy,git+node',
      OAX_TOOLBOX_REQUIRE_SIGNATURE: 'false',
      OAX_SECRETS_DIR: '/var/run/secrets/oax',
      OAX_SECRET_GITHUB_TOKEN: 'x',
      OAX_SECRET_JIRA: 'y',
      OAX_DEMO_MCP: 'true',
      OAX_WORKER_HTTP_PORT: '9191',
    });
    expect(c.runners.enabled).toEqual(['in-process', 'kubernetes-job']);
    expect(c.runners.kubernetesJob).toMatchObject({
      enabled: true,
      namespace: 'runs',
      imagePullSecrets: ['ghcr', 'other'],
      nodeSelector: { pool: 'agents' },
      egress: ['10.0.0.0/8'],
    });
    expect(c.toolboxes).toEqual({
      registry: 'ghcr.io/open-agentix',
      allowlist: ['trivy', 'git+node'],
      requireSignature: false,
    });
    expect(c.secrets).toEqual({ dir: '/var/run/secrets/oax', envRefs: ['github_token', 'jira'] });
    expect(c.demoMcp).toBe(true);
    expect(c.workerHttp.port).toBe(9191);
  });

  it('rejects unknown runners, disabled feature flags and bad secret names', () => {
    expect(() => loadConfig({ ...base, OAX_RUNNERS_ENABLED: 'magic' })).toThrow(
      /unknown runner "magic"/,
    );
    expect(() => loadConfig({ ...base, OAX_RUNNERS_ENABLED: 'kubernetes-job' })).toThrow(
      /OAX_K8S_JOB_ENABLED/,
    );
    expect(() => loadConfig({ ...base, 'OAX_SECRET_bad-name': 'x' })).toThrow(/OAX_SECRET_/);
  });
});
