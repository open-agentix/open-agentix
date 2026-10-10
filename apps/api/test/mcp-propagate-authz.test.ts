import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testNode, type TestNode } from './helpers.js';

/**
 * ADR 0015 S8: `telemetry.propagate` sends the run's trace id to a server the platform does not
 * control. Turning it on needs a tenant admin (platform operator for platform connections); an
 * integrator, who has `connections:write`, may not. Turning it off is always allowed.
 */
let n: TestNode;
let integrator: string;
beforeAll(async () => {
  n = await testNode();
  await n.req({
    method: 'POST',
    url: '/v1/users',
    payload: {
      email: 'integ@example.com',
      displayName: 'Integrator',
      password: 'long-password-1',
      globalRoles: ['integrator'],
    },
  });
  integrator = await n.login('integ@example.com', 'long-password-1');
});
afterAll(async () => n.close());

let seq = 0;
const cfg = (telemetry?: unknown) => ({
  transport: 'streamable-http',
  url: 'https://mcp.vendor.example/mcp',
  ...(telemetry === undefined ? {} : { telemetry }),
});
const create = (token: string | undefined, telemetry?: unknown, scope = 'tenant') =>
  n.req({
    method: 'POST',
    url: '/v1/connections',
    ...(token ? { token } : {}),
    payload: { name: `c${++seq}`, scope, config: cfg(telemetry) },
  });

describe('who may enable telemetry.propagate', () => {
  it('is off by default and the schema stays strict', async () => {
    const res = await create(undefined);
    expect(res.statusCode).toBe(201);
    expect(res.json().config.telemetry).toBeUndefined();
    for (const bad of [{ propagate: true, tracestate: 'a=b' }, { propagate: 'yes' }, 'on'])
      expect((await create(undefined, bad)).statusCode).toBe(400);
  });

  it('an integrator can create a connection but not switch propagation on', async () => {
    expect((await create(integrator)).statusCode).toBe(201);
    expect((await create(integrator, { propagate: false })).statusCode).toBe(201);
    const denied = await create(integrator, { propagate: true });
    expect(denied.statusCode).toBe(403);
  });

  it('an integrator cannot switch it on by updating, but can switch it off and keep it on', async () => {
    const id = (await create(undefined, { propagate: false })).json().id as string;
    const put = (token: string | undefined, telemetry: unknown) =>
      n.req({
        method: 'PUT',
        url: `/v1/connections/${id}`,
        ...(token ? { token } : {}),
        payload: { config: cfg(telemetry) },
      });
    expect((await put(integrator, { propagate: true })).statusCode).toBe(403);
    expect((await put(undefined, { propagate: true })).statusCode).toBe(200);
    // Already on: saving it unchanged (for example after a url change) needs nothing extra.
    expect((await put(integrator, { propagate: true })).statusCode).toBe(200);
    expect((await put(integrator, { propagate: false })).statusCode).toBe(200);
    expect((await put(integrator, { propagate: true })).statusCode).toBe(403);
  });

  it('a tenant admin and the operator may enable it; the audit entry records the setting', async () => {
    const res = await create(undefined, { propagate: true });
    expect(res.statusCode).toBe(201);
    const audit = await n.req({ method: 'GET', url: '/v1/audit?limit=20' });
    expect(JSON.stringify(audit.json())).toContain('"propagate":true');
    const platform = await create(undefined, { propagate: true }, 'platform');
    expect(platform.statusCode).toBe(201);
  });
});
