import { afterEach, describe, expect, it } from 'vitest';
import { activateAirgap, deactivateAirgap, getNetworkSettings, loadConfig } from '../src/index.js';

const base = { OAX_DATABASE_URL: 'memory://', NODE_ENV: 'test' };
const cfg = (env: Record<string, string> = {}) => loadConfig({ ...base, ...env });

afterEach(() => deactivateAirgap());

describe('network configuration at start-up', () => {
  it('loads the configuration and exposes it after activation', () => {
    const env = {
      OAX_NETWORK_CONFIG: JSON.stringify({ proxies: [{ name: 'p', url: 'https://p.example' }] }),
    };
    activateAirgap(cfg(), env);
    expect(getNetworkSettings()?.net.proxies.has('p')).toBe(true);
    deactivateAirgap();
    expect(getNetworkSettings()).toBeNull();
  });

  it('refuses plain http proxies in production only', () => {
    const env = {
      OAX_NETWORK_CONFIG: JSON.stringify({ proxies: [{ name: 'p', url: 'http://p.example' }] }),
    };
    expect(() => activateAirgap(cfg(), env)).not.toThrow();
    deactivateAirgap();
    expect(() =>
      activateAirgap(
        loadConfig({ ...base, NODE_ENV: 'production', OAX_RUN_TOKEN_SECRET: 'x'.repeat(40) }),
        env,
      ),
    ).toThrow(/proxy_plain_http|plain http/);
  });

  it('aborts start-up on an insecure TLS environment or an invalid file', () => {
    expect(() => activateAirgap(cfg(), { NODE_TLS_REJECT_UNAUTHORIZED: '0' })).toThrow(
      /certificate verification/,
    );
    expect(() => activateAirgap(cfg(), { OAX_NETWORK_CONFIG: '{"insecure":true}' })).toThrow(
      /network configuration/,
    );
  });

  it('air-gapped: a proxy outside the allowlist aborts start-up', () => {
    const env = {
      OAX_NETWORK_CONFIG: JSON.stringify({
        proxies: [{ name: 'p', url: 'https://proxy.example' }],
      }),
    };
    const c = cfg({ OAX_AIRGAPPED: 'true', OAX_AIRGAPPED_ALLOW: 'other.example' });
    expect(() => activateAirgap(c, env)).toThrow(/airgap|air-gapped/i);
    const ok = cfg({ OAX_AIRGAPPED: 'true', OAX_AIRGAPPED_ALLOW: 'proxy.example' });
    expect(() => activateAirgap(ok, env)).not.toThrow();
  });
});
