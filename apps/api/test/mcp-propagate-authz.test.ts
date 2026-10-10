import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { connections } from '../src/db/schema.js';
import { CVE_TRIAGE } from './fixtures.js';
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

describe('narrower admins and tokens', () => {
  it('a team-scoped admin cannot enable it on team or agent connections', async () => {
    const team = (
      await n.req({ method: 'POST', url: '/v1/teams', payload: { slug: 'team-x', name: 'X' } })
    ).json().id as string;
    const agent = (
      await n.req({ method: 'POST', url: '/v1/agents', payload: { source: CVE_TRIAGE } })
    ).json().id as string;
    const u = (
      await n.req({
        method: 'POST',
        url: '/v1/users',
        payload: { email: 'tadmin@example.com', displayName: 'T', password: 'long-password-1' },
      })
    ).json().id as string;
    await n.req({
      method: 'PUT',
      url: `/v1/teams/${team}/members`,
      payload: { members: [{ userId: u, role: 'admin' }] },
    });
    const tadmin = await n.login('tadmin@example.com', 'long-password-1');
    const mk = (scope: string, scopeId: string, telemetry: unknown) =>
      n.req({
        method: 'POST',
        url: '/v1/connections',
        token: tadmin,
        payload: { name: `c${++seq}`, scope, scopeId, config: cfg(telemetry) },
      });
    // Control: the same user may create these connections without propagation, so the 403 below
    // comes from the propagation rule and not from a missing scope.
    expect((await mk('team', team, undefined)).statusCode).toBe(201);
    expect((await mk('team', team, { propagate: true })).statusCode).toBe(403);
    expect((await mk('agent', agent, { propagate: true })).statusCode).toBe(403);
  });

  it('an admin token without settings:write cannot enable it', async () => {
    const token = (
      await n.req({
        method: 'POST',
        url: '/v1/tokens',
        payload: { name: 'conn-only', scopes: ['connections:read', 'connections:write'] },
      })
    ).json().token as string;
    expect((await create(token)).statusCode).toBe(201);
    expect((await create(token, { propagate: true })).statusCode).toBe(403);
    const full = (
      await n.req({
        method: 'POST',
        url: '/v1/tokens',
        payload: {
          name: 'conn-settings',
          scopes: ['connections:read', 'connections:write', 'settings:write'],
        },
      })
    ).json().token as string;
    expect((await create(full, { propagate: true })).statusCode).toBe(201);
  });
});

describe('a changed destination needs the admin again', () => {
  const put = (id: string, token: string | undefined, config: unknown) =>
    n.req({
      method: 'PUT',
      url: `/v1/connections/${id}`,
      ...(token ? { token } : {}),
      payload: { config },
    });
  const at = (url: string, telemetry: unknown) => ({
    transport: 'streamable-http',
    url,
    telemetry,
  });

  it('an integrator cannot repoint a connection that has propagation on', async () => {
    const a = 'https://mcp.vendor.example/mcp';
    const b = 'https://mcp.other.example/mcp';
    const id = (
      await n.req({
        method: 'POST',
        url: '/v1/connections',
        payload: { name: `c${++seq}`, config: at(a, { propagate: true }) },
      })
    ).json().id as string;
    expect((await put(id, integrator, at(a, { propagate: true }))).statusCode).toBe(200);
    expect((await put(id, integrator, at(b, { propagate: true }))).statusCode).toBe(403);
    // Turning it off while repointing is fine, and the admin may repoint with it on.
    expect((await put(id, integrator, at(b, { propagate: false }))).statusCode).toBe(200);
    expect((await put(id, undefined, at(b, { propagate: true }))).statusCode).toBe(200);
    // A transport switch counts as a new destination as well.
    const other = { transport: 'in-memory', telemetry: { propagate: true } };
    expect((await put(id, integrator, other)).statusCode).toBe(403);
  });
});

describe('updates are compare-and-swap', () => {
  it('answers 409 and writes nothing when the connection changed after it was read', async () => {
    const id = (await create(undefined, { propagate: false })).json().id as string;
    const catalog = n.services.catalog as unknown as {
      getOwnConnection: (...a: unknown[]) => Promise<{ config: unknown }>;
    };
    const original = catalog.getOwnConnection.bind(catalog);
    // The integrator's request reads the row (propagation off) ...
    catalog.getOwnConnection = async (...a) => {
      const row = await original(...a);
      // ... and an admin turns propagation on before the integrator's write lands.
      await n.ctx.db
        .update(connections)
        .set({ config: cfg({ propagate: true }) })
        .where(eq(connections.id, id));
      return row;
    };
    try {
      const res = await n.req({
        method: 'PUT',
        url: `/v1/connections/${id}`,
        token: integrator,
        payload: { config: { ...cfg({ propagate: false }), timeoutMs: 1234 } },
      });
      expect(res.statusCode).toBe(409);
    } finally {
      catalog.getOwnConnection = original;
    }
    const [row] = await n.ctx.db.select().from(connections).where(eq(connections.id, id));
    expect((row!.config as { timeoutMs?: number }).timeoutMs).toBeUndefined();
    expect((row!.config as { telemetry?: { propagate?: boolean } }).telemetry?.propagate).toBe(
      true,
    );
  });

  it('answers 404 when the connection was deleted after it was read', async () => {
    const id = (await create(undefined, { propagate: false })).json().id as string;
    const catalog = n.services.catalog as unknown as {
      getOwnConnection: (...a: unknown[]) => Promise<{ config: unknown }>;
    };
    const original = catalog.getOwnConnection.bind(catalog);
    catalog.getOwnConnection = async (...a) => {
      const row = await original(...a);
      await n.ctx.db.delete(connections).where(eq(connections.id, id));
      return row;
    };
    try {
      const res = await n.req({
        method: 'PUT',
        url: `/v1/connections/${id}`,
        token: integrator,
        payload: { config: cfg({ propagate: false }) },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      catalog.getOwnConnection = original;
    }
  });
});
