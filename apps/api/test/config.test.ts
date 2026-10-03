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
