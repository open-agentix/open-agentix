import { afterEach, describe, expect, it, vi } from 'vitest';
import { testNode } from './helpers.js';
import { activateAirgap, deactivateAirgap, getNetworkSettings, loadConfig } from '../src/index.js';
import { checkAirgapConfig } from '../src/airgap.js';

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

  it('reads a scheme-less proxy variable leniently and checks its host in air-gapped mode', () => {
    const env = { HTTPS_PROXY: 'proxy.corp:3128' };
    activateAirgap(cfg(), env);
    expect(getNetworkSettings()?.warnings.join()).toMatch(/no scheme/);
    deactivateAirgap();
    const ok = cfg({ OAX_AIRGAPPED: 'true', OAX_AIRGAPPED_ALLOW: 'proxy.corp' });
    expect(checkAirgapConfig(ok, undefined, env)).toEqual([]);
    const bad = cfg({ OAX_AIRGAPPED: 'true', OAX_AIRGAPPED_ALLOW: 'other.corp' });
    expect(checkAirgapConfig(bad, undefined, env).join()).toMatch(/proxy\.corp/);
    expect(() => activateAirgap(cfg(), { HTTPS_PROXY: 'socks5://x:1' })).toThrow(/proxy URL/);
  });

  it('rejects a wildcard in OAX_NETWORK_PRIVATE_ALLOW at start-up', () => {
    expect(() => activateAirgap(cfg(), { OAX_NETWORK_PRIVATE_ALLOW: '*' })).toThrow(
      /OAX_NETWORK_PRIVATE_ALLOW/,
    );
  });
});

describe('network configuration warnings', () => {
  it('are logged when the control node starts', async () => {
    const warn = vi.fn();
    const logger = { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger };
    process.env.OAX_NETWORK_CONFIG = JSON.stringify({
      proxies: [{ name: 'p', url: 'http://p.example' }],
    });
    try {
      const node = await testNode({}, { logger: logger as never });
      await node.close();
    } finally {
      delete process.env.OAX_NETWORK_CONFIG;
      deactivateAirgap();
    }
    expect(warn.mock.calls.some((c) => JSON.stringify(c).includes('plain http'))).toBe(true);
  });
});
