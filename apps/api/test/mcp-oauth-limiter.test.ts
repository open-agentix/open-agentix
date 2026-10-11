import { describe, expect, it } from 'vitest';
import { RenewalLimiter } from '../src/mcp-oauth/renewal-limiter.js';
import { loadConfig } from '../src/config.js';

describe('renewal limiter', () => {
  it('bounds renewals per process and per tenant without ever waiting', () => {
    const l = new RenewalLimiter(3, 2);
    const a1 = l.tryAcquire('a');
    const a2 = l.tryAcquire('a');
    expect(a1 && a2).toBeTruthy();
    expect(l.tryAcquire('a')).toBeNull(); // tenant bound
    const b1 = l.tryAcquire('b');
    expect(b1).toBeTruthy();
    expect(l.tryAcquire('c')).toBeNull(); // process bound
    expect(l.inFlight).toBe(3);
    a1!();
    a1!(); // releasing twice frees one slot only
    expect(l.inFlight).toBe(2);
    const c1 = l.tryAcquire('c');
    expect(c1).toBeTruthy();
    expect(l.tryAcquire('a')).toBeNull(); // process bound again
    for (const r of [a2, b1, c1]) r!();
    expect(l.inFlight).toBe(0);
    expect(l.tryAcquire('a')).toBeTruthy();
  });

  it('reads the limits from the environment, the tenant bound never above the process bound', () => {
    const base = { NODE_ENV: 'test', OAX_DATABASE_URL: 'memory://' };
    expect(loadConfig(base).mcp.oauth.renewals).toEqual({ max: 4, perTenant: 2 });
    expect(
      loadConfig({ ...base, OAX_MCP_OAUTH_RENEWALS: '3', OAX_MCP_OAUTH_RENEWALS_PER_TENANT: '9' })
        .mcp.oauth.renewals,
    ).toEqual({ max: 3, perTenant: 3 });
    expect(() => loadConfig({ ...base, OAX_MCP_OAUTH_RENEWALS: '0' })).toThrow();
  });
});
