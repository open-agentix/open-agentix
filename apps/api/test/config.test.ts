import { describe, expect, it } from 'vitest';
import { loadConfig, mapGroupsToBindings } from '../src/config.js';

const base = { OAX_DATABASE_URL: 'memory://', NODE_ENV: 'test' };

const DIGEST = `sha256:${'b'.repeat(64)}`;
/** The settings an enabled kubernetes-job runner needs (fail closed without them). */
const K8S_REQUIRED = {
  OAX_NODE_CONTROL_URL: 'https://oax-api.oax.svc.cluster.local',
  OAX_K8S_IMAGE: `ghcr.io/open-agentix/toolbox-trivy@${DIGEST}`,
  OAX_K8S_CONTROL_PLANE_NAMESPACE_SELECTOR: '{"kubernetes.io/metadata.name":"oax"}',
};

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

describe('OAX_ROLE_BINDINGS_READ (ADR 0014 S2)', () => {
  it("defaults to the legacy read path, so the upgrade changes nobody's access", () => {
    expect(loadConfig(base).auth.roleBindingsRead).toBe('legacy');
  });

  it('accepts exactly legacy and bindings', () => {
    for (const v of ['legacy', 'bindings'] as const)
      expect(loadConfig({ ...base, OAX_ROLE_BINDINGS_READ: v }).auth.roleBindingsRead).toBe(v);
  });

  it('refuses to start with any other value', () => {
    for (const v of ['', 'Bindings', 'both', 'true', 'resolver', ' legacy', 'legacy ', '1', 'off'])
      expect(() => loadConfig({ ...base, OAX_ROLE_BINDINGS_READ: v }), JSON.stringify(v)).toThrow(
        /OAX_ROLE_BINDINGS_READ/,
      );
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
      serviceAccountName: 'openagentix-run-node',
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
      ...K8S_REQUIRED,
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

  it('fails closed for the kubernetes-job runner without allowlist or signature enforcement', () => {
    const k8s = {
      ...base,
      ...K8S_REQUIRED,
      OAX_RUNNERS_ENABLED: 'kubernetes-job',
      OAX_K8S_JOB_ENABLED: 'true',
      OAX_TOOLBOX_ALLOWLIST: 'trivy',
    };
    // signature requirement defaults to true and is not enforced by the runner
    expect(() => loadConfig(k8s)).toThrow(/OAX_K8S_SIGNATURES_VERIFIED_BY_ADMISSION/);
    expect(() =>
      loadConfig({ ...k8s, OAX_K8S_SIGNATURES_VERIFIED_BY_ADMISSION: 'true' }),
    ).not.toThrow();
    expect(() =>
      loadConfig({ ...k8s, OAX_TOOLBOX_REQUIRE_SIGNATURE: 'false', OAX_TOOLBOX_ALLOWLIST: '' }),
    ).toThrow(/OAX_TOOLBOX_ALLOWLIST/);
    for (const bad of [
      { OAX_K8S_RESOURCES_MEMORY: '0' },
      { OAX_K8S_RESOURCES_MEMORY: '1000K' },
      { OAX_K8S_RESOURCES_CPU: '0' },
      { OAX_K8S_RESOURCES_CPU: '10m' },
    ]) {
      expect(() => loadConfig({ ...k8s, OAX_TOOLBOX_REQUIRE_SIGNATURE: 'false', ...bad })).toThrow(
        /OAX_K8S_RESOURCES_\*.*below the minimum/,
      );
    }
    const c = loadConfig({
      ...k8s,
      OAX_TOOLBOX_REQUIRE_SIGNATURE: 'false',
      OAX_K8S_RUN_NODE_IMAGES: 'openagentix-worker',
      OAX_K8S_DENY_CIDRS: '10.244.0.0/16, 10.96.0.0/12',
      OAX_AIRGAPPED: 'true',
    });
    expect(c.runners.kubernetesJob).toMatchObject({
      serviceAccountName: 'openagentix-run-node',
      toolboxAllowlist: ['trivy'],
      runNodeImages: ['openagentix-worker'],
      denyCidrs: ['10.244.0.0/16', '10.96.0.0/12'],
      airgapped: true,
    });
  });

  it('parses the Kubernetes wiring settings and defaults to the safe values', () => {
    const c = loadConfig({
      ...base,
      ...K8S_REQUIRED,
      OAX_RUNNERS_ENABLED: 'kubernetes-job',
      OAX_K8S_JOB_ENABLED: 'true',
      OAX_TOOLBOX_ALLOWLIST: 'trivy',
      OAX_TOOLBOX_REQUIRE_SIGNATURE: 'false',
      OAX_K8S_TOOLBOX_IMAGES: JSON.stringify({
        trivy: `ghcr.io/open-agentix/toolbox-trivy@${DIGEST}`,
      }),
      OAX_K8S_CONTROL_PLANE_POD_SELECTOR: '{"app":"api"}',
      OAX_K8S_CONTROL_PLANE_CIDRS: '10.96.0.10/32',
      OAX_K8S_CONTROL_PLANE_PORTS: '8443, 443',
    });
    expect(c.runners.kubernetesJob).toMatchObject({
      nodeControlUrl: 'https://oax-api.oax.svc.cluster.local',
      automountServiceAccountToken: false,
      dnsEgress: true,
      defaultDenyPolicy: 'default-deny-all',
      controlPlane: {
        podSelector: { app: 'api' },
        namespaceSelector: { 'kubernetes.io/metadata.name': 'oax' },
        cidrs: ['10.96.0.10/32'],
        ports: [8443, 443],
      },
    });
    // Off by default: nothing is required and nothing is enabled.
    const off = loadConfig({ ...base });
    expect(off.runners.kubernetesJob.enabled).toBe(false);
    expect(off.runners.enabled).not.toContain('kubernetes-job');
  });

  it('refuses an enabled kubernetes-job runner with a missing or unsafe wiring', () => {
    const ok = {
      ...base,
      ...K8S_REQUIRED,
      OAX_RUNNERS_ENABLED: 'kubernetes-job',
      OAX_K8S_JOB_ENABLED: 'true',
      OAX_TOOLBOX_ALLOWLIST: 'trivy',
      OAX_TOOLBOX_REQUIRE_SIGNATURE: 'false',
    };
    expect(() => loadConfig(ok)).not.toThrow();
    const without = (k: keyof typeof K8S_REQUIRED) => {
      const e: Record<string, string | undefined> = { ...ok };
      delete e[k];
      return e;
    };
    expect(() => loadConfig(without('OAX_NODE_CONTROL_URL'))).toThrow(/OAX_NODE_CONTROL_URL/);
    expect(() => loadConfig({ ...ok, OAX_NODE_CONTROL_URL: 'http://oax:8080' })).toThrow(/https/);
    expect(() => loadConfig(without('OAX_K8S_IMAGE'))).toThrow(/OAX_K8S_IMAGE/);
    expect(() => loadConfig(without('OAX_K8S_CONTROL_PLANE_NAMESPACE_SELECTOR'))).toThrow(
      /OAX_K8S_CONTROL_PLANE/,
    );
    // tag instead of digest, foreign registry, toolbox not on the allowlist
    expect(() =>
      loadConfig({ ...ok, OAX_K8S_IMAGE: 'ghcr.io/open-agentix/toolbox-trivy:latest' }),
    ).toThrow(/digest/);
    expect(() =>
      loadConfig({ ...ok, OAX_K8S_IMAGE: `docker.io/evil/toolbox-trivy@${DIGEST}` }),
    ).toThrow(/registry/);
    expect(() =>
      loadConfig({ ...ok, OAX_K8S_IMAGE: `ghcr.io/open-agentix/toolbox-nmap@${DIGEST}` }),
    ).toThrow(/allowlist/);
    // an empty selector would match every pod
    expect(() => loadConfig({ ...ok, OAX_K8S_CONTROL_PLANE_POD_SELECTOR: '{}' })).toThrow();
  });

  const K8S_OK = {
    ...base,
    ...K8S_REQUIRED,
    OAX_RUNNERS_ENABLED: 'kubernetes-job',
    OAX_K8S_JOB_ENABLED: 'true',
    OAX_TOOLBOX_ALLOWLIST: 'trivy',
    OAX_TOOLBOX_REQUIRE_SIGNATURE: 'false',
  };

  it('refuses an empty or non-numeric control plane port list', () => {
    const ok = K8S_OK;
    // An empty port list would render `ports: []`, which Kubernetes reads as "every port".
    expect(() => loadConfig({ ...ok, OAX_K8S_CONTROL_PLANE_PORTS: '' })).toThrow(
      /OAX_K8S_CONTROL_PLANE_PORTS/,
    );
    expect(() => loadConfig({ ...ok, OAX_K8S_CONTROL_PLANE_PORTS: 'https' })).toThrow();
  });

  it('refuses broad, invalid or denied control plane CIDRs at start-up', () => {
    const ok = K8S_OK;
    // Broad or invalid CIDRs are a start-up error, not a surprise at the first step.
    expect(() => loadConfig({ ...ok, OAX_K8S_CONTROL_PLANE_CIDRS: '0.0.0.0/1' })).toThrow(
      /OAX_K8S_CONTROL_PLANE_CIDRS.*too broad/,
    );
    expect(() => loadConfig({ ...ok, OAX_K8S_CONTROL_PLANE_CIDRS: 'oax-api' })).toThrow(
      /OAX_K8S_CONTROL_PLANE_CIDRS/,
    );
    expect(() => loadConfig({ ...ok, OAX_K8S_CONTROL_PLANE_CIDRS: '169.254.169.254/32' })).toThrow(
      /always-denied/,
    );
    expect(() => loadConfig({ ...ok, OAX_K8S_CONTROL_PLANE_CIDRS: '10.96.0.10/32' })).not.toThrow();
  });
});
