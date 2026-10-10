import { randomUUID } from 'node:crypto';
import { type Principal, type Role } from '@openagentix/core';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_TENANT_ID,
  auditLog,
  tenantRoleBindings,
  users as usersTable,
} from '../src/db/schema.js';
import { currentAuthzEpoch, reconcileUserBindings } from '../src/services/role-bindings.js';
import { sqlTargets } from './db-targets.js';
import { testNode, type TestNode } from './helpers.js';

/**
 * ADR 0014 slice S4 (#189, #226): the role-binding API, the nine grant rules with one refusal test
 * each, the audit trail, and the separate key of mirror rows and explicit grants. Written to pass on
 * both read paths (`OAX_TEST_ROLE_BINDINGS_READ=bindings` re-runs it on the resolver path).
 *
 *   org-a ─┬─ div-1 ─── team-1        org-b ─── x-unit
 *          └─ div-2
 */
const PW = 'long-password-123';

describe.each(sqlTargets)('role-binding API (%s)', (_kind, enabled, open) => {
  if (!enabled()) {
    it.skip('needs OAX_TEST_DATABASE_URL', () => undefined);
    return;
  }
  let target: Awaited<ReturnType<typeof open>>;
  let n: TestNode;
  const id = {} as Record<string, string>;
  const tok = {} as Record<string, string>;
  const uid = {} as Record<string, string>;
  const op = (): Principal => ({
    kind: 'user',
    userId: randomUUID(),
    tenantId: DEFAULT_TENANT_ID,
    displayName: 'op',
    platformAdmin: true,
    bindings: [],
  });
  const mkUser = async (key: string, home: string, roles: Role[]) => {
    const email = `${key}@example.org`;
    const u = await n.services.identity.createLocalUser(
      { userId: op().userId, tenantId: id[home]! },
      { email, displayName: key, password: PW, globalRoles: roles },
    );
    uid[key] = u.id;
    tok[key] = await n.login(email, PW);
  };
  const rb = (tenant: string) => `/v1/tenants/${id[tenant] ?? tenant}/role-bindings`;
  const post = (who: string | null, tenant: string, body: Record<string, unknown>) =>
    n.req({
      method: 'POST',
      url: rb(tenant),
      payload: body,
      ...(who === null ? {} : { token: tok[who]! }),
    });
  const grant = (
    user: string,
    role: Role,
    inherit = false,
    extra: Record<string, unknown> = {},
  ) => ({ userId: uid[user] ?? user, role, inherit, ...extra });
  const rows = (user: string) =>
    n.ctx.db.select().from(tenantRoleBindings).where(eq(tenantRoleBindings.userId, uid[user]!));
  const bound = async (user: string, tenant: string, role: string, source?: string) =>
    (await rows(user)).filter(
      (b) =>
        b.tenantId === id[tenant] &&
        b.role === role &&
        (source === undefined || b.source === source),
    );
  const audit = async (action: string, tenant?: string) =>
    (await n.ctx.db.select().from(auditLog).where(eq(auditLog.action, action))).filter(
      (e) => tenant === undefined || e.tenantId === id[tenant],
    );
  const epoch = (slug: string) => currentAuthzEpoch(n.ctx.db, id[slug]!);
  const setMax = (v: number) => {
    (n.ctx.config.tenancy as { maxBindingsPerUser: number }).maxBindingsPerUser = v;
  };
  const scopedToken = async (user: string, scopes: string[]) => {
    const principal = await n.services.identity.principalForUser(uid[user]!);
    return (
      await n.services.identity.createApiToken(principal, `scoped-${user}`, scopes as never, 30)
    ).token;
  };

  beforeAll(async () => {
    target = await open();
    n = await testNode({ OAX_DATABASE_URL: target.url, OAX_RATE_LIMIT_LOGIN_MAX: '10000' });
    id.default = DEFAULT_TENANT_ID;
    for (const slug of ['org-a', 'org-b'])
      id[slug] = (await n.services.tenants.create(op(), { slug, name: `Org ${slug}` })).id;
    const child = async (parent: string, slug: string) => {
      id[slug] = (await n.services.tenants.createChild(op(), id[parent]!, { slug, name: slug })).id;
    };
    await child('org-a', 'div-1');
    await child('div-1', 'team-1');
    await child('org-a', 'div-2');
    await child('org-b', 'x-unit');
    await mkUser('admin-a', 'org-a', ['admin']); // plain (non-inheriting) administrator
    await mkUser('root-inh', 'org-a', ['admin']); // opted in by the platform operator below
    await mkUser('viewer-a', 'org-a', ['viewer']);
    await mkUser('admin-d1', 'div-1', ['admin']);
    await mkUser('m1', 'org-a', []);
    await mkUser('m2', 'org-a', []);
    await mkUser('m-d1', 'div-1', []);
    await mkUser('m-d2', 'div-2', []);
    await mkUser('outsider', 'org-b', []);
    await mkUser('admin-b', 'org-b', ['admin']);
  }, 180_000);
  afterAll(async () => {
    await n.close();
    await target.close();
  });

  describe('list', () => {
    it('lists the mirror rows of a tenant with their source, for users:read only', async () => {
      const r = await n.req({ method: 'GET', url: rb('org-a'), token: tok['admin-a']! });
      expect(r.statusCode).toBe(200);
      const items = r.json().items as { user: { id: string }; role: string; source: string }[];
      expect(items.find((b) => b.user.id === uid['admin-a'])).toMatchObject({
        role: 'admin',
        source: 'mirror',
        inherit: false,
        useCase: null,
      });
      // a viewer lacks users:read
      expect(
        (await n.req({ method: 'GET', url: rb('org-a'), token: tok['viewer-a']! })).statusCode,
      ).toBe(403);
    });

    it('pages with a cursor and filters by user', async () => {
      const first = await n.req({
        method: 'GET',
        url: `${rb('org-a')}?limit=2`,
        token: tok['admin-a']!,
      });
      expect(first.json().items).toHaveLength(2);
      expect(first.json().nextCursor).toEqual(expect.any(String));
      const second = await n.req({
        method: 'GET',
        url: `${rb('org-a')}?limit=50&cursor=${first.json().nextCursor}`,
        token: tok['admin-a']!,
      });
      const seen = new Set<string>(first.json().items.map((b: { id: string }) => b.id));
      for (const b of second.json().items) expect(seen.has(b.id)).toBe(false);
      const one = await n.req({
        method: 'GET',
        url: `${rb('org-a')}?userId=${uid['admin-a']}`,
        token: tok['admin-a']!,
      });
      expect(
        one.json().items.every((b: { user: { id: string } }) => b.user.id === uid['admin-a']),
      ).toBe(true);
    });

    it('answers an invisible tenant like an unknown one', async () => {
      const foreign = await n.req({ method: 'GET', url: rb('org-b'), token: tok['admin-a']! });
      const unknown = await n.req({
        method: 'GET',
        url: `/v1/tenants/${randomUUID()}/role-bindings`,
        token: tok['admin-a']!,
      });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json()).toEqual(unknown.json());
    });
  });

  describe('grant rules (ADR 0014 section 7), one refusal each', () => {
    it('rule 1: users:write on the tenant is required', async () => {
      const r = await post('viewer-a', 'org-a', grant('m1', 'viewer'));
      expect(r.statusCode).toBe(403);
      expect(await bound('m1', 'org-a', 'viewer')).toHaveLength(0);
      // and a tenant the caller cannot see is a 404, not a 403
      expect((await post('admin-a', 'org-b', grant('m1', 'viewer'))).statusCode).toBe(404);
    });

    it('rule 2: no grant above the permissions the caller holds (token scopes count)', async () => {
      const narrow = await scopedToken('admin-a', ['users:read', 'users:write']);
      const r = await n.req({
        method: 'POST',
        url: rb('org-a'),
        token: narrow,
        payload: grant('m1', 'operator'),
      });
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toBe('grant_exceeds_own');
      expect(await bound('m1', 'org-a', 'operator')).toHaveLength(0);
    });

    it('rule 2: an inheriting grant needs an inheriting binding on the tenant or above', async () => {
      const r = await post('admin-a', 'org-a', grant('m1', 'viewer', true));
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toBe('inheritance_required');
      expect(await bound('m1', 'org-a', 'viewer')).toHaveLength(0);
    });

    it('rule 3: use-case bindings are refused until S8', async () => {
      const r = await post('admin-a', 'org-a', grant('m1', 'viewer', false, { useCase: 'secops' }));
      expect(r.statusCode).toBe(422);
      expect(r.json().error).toBe('use_case_bindings_unsupported');
      expect(await bound('m1', 'org-a', 'viewer')).toHaveLength(0);
    });

    it('rule 4: a grantee outside the caller coverage is 404 user, like an unknown id', async () => {
      const hidden = await post('admin-a', 'org-a', grant('m-d1', 'viewer')); // home div-1: not covered
      const unknown = await post('admin-a', 'org-a', grant(randomUUID(), 'viewer'));
      const foreign = await post('admin-a', 'org-a', grant('outsider', 'viewer'));
      for (const r of [hidden, unknown, foreign]) {
        expect(r.statusCode).toBe(404);
        expect(r.json()).toEqual(unknown.json());
      }
      expect(unknown.json().message).toBe('user not found');
      expect(await bound('m-d1', 'org-a', 'viewer')).toHaveLength(0);
    });

    it('rule 5: a role is never bound outside the organisation of the user', async () => {
      const r = await post(null, 'org-a', grant('outsider', 'viewer')); // platform operator
      expect(r.statusCode).toBe(422);
      expect(r.json().error).toBe('cross_organisation_grant');
      expect(await rows('outsider')).toHaveLength(0);
    });

    it('rule 6: no self-grant, also not by flipping inherit on one own binding', async () => {
      const r = await post('admin-a', 'org-a', grant('admin-a', 'viewer'));
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toBe('self_grant');
      // a binding of admin-a made by the operator cannot be widened by admin-a
      const made = await post(null, 'org-a', grant('admin-a', 'auditor'));
      expect(made.statusCode).toBe(201);
      const flip = await n.req({
        method: 'PATCH',
        url: `${rb('org-a')}/${made.json().id}`,
        token: tok['admin-a']!,
        payload: { inherit: true },
      });
      expect(flip.statusCode).toBe(403);
      expect(flip.json().error).toBe('self_grant');
      expect((await bound('admin-a', 'org-a', 'auditor'))[0]!.inherit).toBe(false);
      // platform operators may grant themselves (nobody else can fix an empty organisation)
      expect(
        (
          await post(null, 'default', {
            userId: (
              await n.ctx.db
                .select()
                .from(usersTable)
                .where(eq(usersTable.email, 'admin@example.com'))
            )[0]!.id,
            role: 'viewer',
            inherit: false,
          })
        ).statusCode,
      ).toBe(201);
    });

    it('rule 7: pentest cannot be granted before S6', async () => {
      const r = await post(null, 'org-a', grant('m1', 'pentest' as Role));
      expect(r.statusCode).toBe(400);
      expect(await bound('m1', 'org-a', 'pentest')).toHaveLength(0);
    });

    it('rule 8: the last inheriting administrator of an organisation stays', async () => {
      const a = await post(null, 'org-b', grant('admin-b', 'admin', true));
      expect(a.statusCode).toBe(201);
      // admin-b cannot remove or narrow the only inheriting admin, not even through its own binding
      const del = await n.req({
        method: 'DELETE',
        url: `${rb('org-b')}/${a.json().id}`,
        token: tok['admin-b']!,
      });
      expect(del.statusCode).toBe(409);
      expect(del.json().error).toBe('last_admin');
      // a second inheriting admin by the operator
      await mkUser('admin-b2', 'org-b', []);
      const b = await post(null, 'org-b', grant('admin-b2', 'admin', true));
      expect(b.statusCode).toBe(201);
      // narrowing the other one is fine now ...
      const narrow = await n.req({
        method: 'PATCH',
        url: `${rb('org-b')}/${a.json().id}`,
        token: tok['admin-b2']!,
        payload: { inherit: false },
      });
      expect(narrow.statusCode).toBe(200);
      // ... but then admin-b2 is the last one
      const last = await n.req({
        method: 'PATCH',
        url: `${rb('org-b')}/${b.json().id}`,
        token: tok['admin-b2']!,
        payload: { inherit: false },
      });
      expect(last.statusCode).toBe(403); // own binding: self_grant comes first
      const byOther = await n.req({
        method: 'DELETE',
        url: `${rb('org-b')}/${b.json().id}`,
        token: tok['admin-b']!,
      });
      // admin-b has a plain admin only now (the grant was narrowed): no inheriting coverage left
      expect(byOther.statusCode).toBe(403);
      // the operator is exempt
      expect(
        (await n.req({ method: 'DELETE', url: `${rb('org-b')}/${b.json().id}` })).statusCode,
      ).toBe(204);
      expect(
        (await n.req({ method: 'DELETE', url: `${rb('org-b')}/${a.json().id}` })).statusCode,
      ).toBe(204);
    });

    it('rule 8 holds under concurrency: two admins removing each other leave one', async () => {
      await mkUser('race-1', 'org-b', []);
      await mkUser('race-2', 'org-b', []);
      const r1 = (await post(null, 'org-b', grant('race-1', 'admin', true))).json().id as string;
      const r2 = (await post(null, 'org-b', grant('race-2', 'admin', true))).json().id as string;
      const [x, y] = await Promise.all([
        n.req({ method: 'DELETE', url: `${rb('org-b')}/${r2}`, token: tok['race-1']! }),
        n.req({ method: 'DELETE', url: `${rb('org-b')}/${r1}`, token: tok['race-2']! }),
      ]);
      const codes = [x.statusCode, y.statusCode].sort();
      expect(codes[0]).toBe(204);
      expect([403, 409]).toContain(codes[1]);
      const left = (await rows('race-1'))
        .concat(await rows('race-2'))
        .filter((b) => b.source === 'grant');
      expect(left).toHaveLength(1);
      expect(left[0]!.inherit).toBe(true);
    });

    it('rule 8: an expiring co-admin does not count as the remaining administrator', async () => {
      id['org-c'] = (
        await n.services.tenants.create(op(), { slug: 'org-c', name: 'Org org-c' })
      ).id;
      await mkUser('perm-c', 'org-c', []);
      await mkUser('temp-c', 'org-c', []);
      const perm = (await post(null, 'org-c', grant('perm-c', 'admin', true))).json().id as string;
      const temp = await post(
        null,
        'org-c',
        grant('temp-c', 'admin', true, { expiresAt: '2999-01-01T00:00:00Z' }),
      );
      expect(temp.statusCode).toBe(201);
      // the time-boxed admin cannot remove the permanent one, and the permanent one cannot leave
      for (const who of ['temp-c', 'perm-c']) {
        const r = await n.req({
          method: 'DELETE',
          url: `${rb('org-c')}/${perm}`,
          token: tok[who]!,
        });
        expect(r.statusCode).toBe(409);
        expect(r.json().error).toBe('last_admin');
      }
      expect(await bound('perm-c', 'org-c', 'admin', 'grant')).toHaveLength(1);
    });

    it('rule 9: revoking follows the grant rules; leaving one own binding is always allowed', async () => {
      const made = await post(null, 'org-a', grant('viewer-a', 'operator'));
      expect(made.statusCode).toBe(201);
      // a stranger without users:write cannot revoke ...
      const foreign = await n.req({
        method: 'DELETE',
        url: `${rb('org-a')}/${made.json().id}`,
        token: tok['m1']!,
      });
      expect([403, 404]).toContain(foreign.statusCode);
      // ... a narrowly scoped admin token cannot revoke above its own permissions ...
      const narrow = await scopedToken('admin-a', ['users:read', 'users:write']);
      const above = await n.req({
        method: 'DELETE',
        url: `${rb('org-a')}/${made.json().id}`,
        token: narrow,
      });
      expect(above.statusCode).toBe(403);
      expect(above.json().error).toBe('grant_exceeds_own');
      // ... the holder may leave without users:write
      const own = await n.req({
        method: 'DELETE',
        url: `${rb('org-a')}/${made.json().id}`,
        token: tok['viewer-a']!,
      });
      expect(own.statusCode).toBe(204);
      const ev = (await audit('tenant.role_unbound', 'org-a')).find(
        (e) => e.target === made.json().id,
      );
      expect(ev?.payload).toMatchObject({ role: 'operator', reason: 'self' });
    });
  });

  describe('create, change, delete', () => {
    it('grants, audits in the partition of the node, bumps the epoch and survives a duplicate', async () => {
      const before = await epoch('org-a');
      const r = await post('admin-a', 'org-a', grant('m1', 'viewer'));
      expect(r.statusCode).toBe(201);
      expect(r.json()).toMatchObject({
        tenantId: id['org-a'],
        role: 'viewer',
        inherit: false,
        source: 'grant',
        grantedBy: uid['admin-a'],
      });
      expect(await epoch('org-a')).toBeGreaterThan(before!);
      const ev = (await audit('tenant.role_bound', 'org-a')).find((e) => e.target === r.json().id);
      expect(ev?.payload).toMatchObject({
        bindingId: r.json().id,
        userId: uid['m1'],
        role: 'viewer',
        inherit: false,
        grantedBy: uid['admin-a'],
      });
      expect(ev?.actor).toBe(uid['admin-a']);
      const dup = await post('admin-a', 'org-a', grant('m1', 'viewer'));
      expect(dup.statusCode).toBe(409);
    });

    it('requires inherit and validates the expiry', async () => {
      const missing = await post('admin-a', 'org-a', { userId: uid['m1'], role: 'auditor' });
      expect(missing.statusCode).toBe(400);
      const past = await post(
        'admin-a',
        'org-a',
        grant('m1', 'auditor', false, { expiresAt: '2000-01-01T00:00:00Z' }),
      );
      expect(past.statusCode).toBe(422);
      const ok = await post(
        'admin-a',
        'org-a',
        grant('m1', 'auditor', false, { expiresAt: '2999-01-01T00:00:00Z' }),
      );
      expect(ok.statusCode).toBe(201);
      expect(ok.json().expiresAt).toBe('2999-01-01T00:00:00.000Z');
    });

    it('PATCH re-checks every rule and audits each changed field', async () => {
      const made = (await post('admin-a', 'org-a', grant('m2', 'viewer'))).json();
      // widening to inheriting needs inheriting coverage
      const wide = await n.req({
        method: 'PATCH',
        url: `${rb('org-a')}/${made.id}`,
        token: tok['admin-a']!,
        payload: { inherit: true },
      });
      expect(wide.statusCode).toBe(403);
      expect(wide.json().error).toBe('inheritance_required');
      // a role above the token scopes cannot be reached through PATCH
      const narrow = await scopedToken('admin-a', [
        'users:read',
        'users:write',
        'agents:read',
        'runs:read',
        'events:read',
        'costs:read',
      ]);
      const up = await n.req({
        method: 'PATCH',
        url: `${rb('org-a')}/${made.id}`,
        token: narrow,
        payload: { role: 'operator' },
      });
      expect(up.statusCode).toBe(403);
      expect(up.json().error).toBe('grant_exceeds_own');
      // an expiry in the past, and an empty patch
      expect(
        (
          await n.req({
            method: 'PATCH',
            url: `${rb('org-a')}/${made.id}`,
            token: tok['admin-a']!,
            payload: { expiresAt: '2000-01-01T00:00:00Z' },
          })
        ).statusCode,
      ).toBe(422);
      expect(
        (
          await n.req({
            method: 'PATCH',
            url: `${rb('org-a')}/${made.id}`,
            token: tok['admin-a']!,
            payload: {},
          })
        ).statusCode,
      ).toBe(400);
      // allowed changes
      const ok = await n.req({
        method: 'PATCH',
        url: `${rb('org-a')}/${made.id}`,
        token: tok['admin-a']!,
        payload: { role: 'auditor', expiresAt: '2999-06-01T00:00:00Z' },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ role: 'auditor', expiresAt: '2999-06-01T00:00:00.000Z' });
      const changes = (await audit('tenant.role_binding_changed', 'org-a')).filter(
        (e) => e.target === made.id,
      );
      expect(changes.map((e) => (e.payload as { field: string }).field).sort()).toEqual([
        'expiresAt',
        'role',
      ]);
      // unchanged patch writes nothing
      const again = await n.req({
        method: 'PATCH',
        url: `${rb('org-a')}/${made.id}`,
        token: tok['admin-a']!,
        payload: { role: 'auditor' },
      });
      expect(again.statusCode).toBe(200);
      expect(
        (await audit('tenant.role_binding_changed', 'org-a')).filter((e) => e.target === made.id),
      ).toHaveLength(2);
      // a binding of another tenant is not found under this one
      expect(
        (
          await n.req({
            method: 'PATCH',
            url: `${rb('div-2')}/${made.id}`,
            token: tok['admin-a']!,
            payload: { inherit: false },
          })
        ).statusCode,
      ).toBe(404);
    });

    it('treats mirror rows as managed by the global roles of the user', async () => {
      const mirror = (await bound('viewer-a', 'org-a', 'viewer', 'mirror'))[0]!;
      const del = await n.req({
        method: 'DELETE',
        url: `${rb('org-a')}/${mirror.id}`,
        token: tok['admin-a']!,
      });
      expect(del.statusCode).toBe(409);
      expect(del.json().error).toBe('mirror_binding');
      const role = await n.req({
        method: 'PATCH',
        url: `${rb('org-a')}/${mirror.id}`,
        token: tok['admin-a']!,
        payload: { role: 'auditor' },
      });
      expect(role.statusCode).toBe(409);
      expect(await bound('viewer-a', 'org-a', 'viewer', 'mirror')).toHaveLength(1);
    });

    it('caps the bindings of one user', async () => {
      await mkUser('capped', 'org-a', []);
      setMax(1);
      try {
        expect((await post('admin-a', 'org-a', grant('capped', 'viewer'))).statusCode).toBe(201);
        const r = await post('admin-a', 'org-a', grant('capped', 'auditor'));
        expect(r.statusCode).toBe(422);
        expect(r.json().error).toBe('binding_limit_exceeded');
      } finally {
        setMax(200);
      }
    });

    it('a grant on a child node is audited in the partition of that node', async () => {
      const r = await post(null, 'div-2', grant('m-d2', 'operator'));
      expect(r.statusCode).toBe(201);
      expect(
        (await audit('tenant.role_bound', 'div-2')).some((e) => e.target === r.json().id),
      ).toBe(true);
      expect(
        (await audit('tenant.role_bound', 'org-a')).some((e) => e.target === r.json().id),
      ).toBe(false);
    });
  });

  describe('bulk opt-in', () => {
    const enable = (who: string | null, tenant: string, body: Record<string, unknown>) =>
      n.req({
        method: 'POST',
        url: `${rb(tenant)}/enable-inheritance`,
        payload: body,
        ...(who === null ? {} : { token: tok[who]! }),
      });

    it('is for platform operators; everybody else gets the same 403, for any tenant', async () => {
      const a = await enable('admin-a', 'org-a', { roles: ['admin'], dryRun: true });
      const b = await enable('admin-a', randomUUID(), { roles: ['admin'], dryRun: true });
      expect(a.statusCode).toBe(403);
      expect(b.statusCode).toBe(403);
      expect(a.json()).toEqual(b.json());
    });

    it('honours the scopes of an operator token', async () => {
      const [opUser] = await n.ctx.db
        .select()
        .from(usersTable)
        .where(eq(usersTable.email, 'admin@example.com'));
      const principal = await n.services.identity.principalForUser(opUser!.id);
      const scoped = async (scopes: string[]) =>
        (await n.services.identity.createApiToken(principal, 'op-scoped', scopes as never, 30))
          .token;
      const readOnly = await scoped(['agents:read']);
      for (const dryRun of [true, false]) {
        const r = await n.req({
          method: 'POST',
          url: `${rb('org-a')}/enable-inheritance`,
          token: readOnly,
          payload: { roles: ['admin'], dryRun },
        });
        expect(r.statusCode).toBe(403);
      }
      const reader = await scoped(['users:read']);
      const write = await n.req({
        method: 'POST',
        url: `${rb('org-a')}/enable-inheritance`,
        token: reader,
        payload: { roles: ['admin'], dryRun: false },
      });
      expect(write.statusCode).toBe(403);
      const dry = await n.req({
        method: 'POST',
        url: `${rb('org-a')}/enable-inheritance`,
        token: reader,
        payload: { roles: ['admin'], dryRun: true },
      });
      expect(dry.statusCode).toBe(200);
      expect(await audit('tenant.inheritance_enabled')).toHaveLength(0);
    });

    it('a dry run lists users and nodes and changes nothing', async () => {
      const before = await rows('root-inh');
      const r = await enable(null, 'org-a', { roles: ['admin'], dryRun: true });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.dryRun).toBe(true);
      const mine = body.items.find((i: { user: { id: string } }) => i.user.id === uid['root-inh']);
      expect(mine.tenant.slugPath).toBe('org-a');
      expect(mine.nodes.map((x: { slugPath: string }) => x.slugPath).sort()).toEqual([
        'org-a/div-1',
        'org-a/div-1/team-1',
        'org-a/div-2',
      ]);
      // nothing from another organisation, nothing outside the requested roles
      const slugs = JSON.stringify(body);
      expect(slugs).not.toContain('org-b');
      expect(body.items.every((i: { role: string }) => i.role === 'admin')).toBe(true);
      expect(await rows('root-inh')).toEqual(before);
      expect(await audit('tenant.inheritance_enabled')).toHaveLength(0);
    });

    it('defaults to a dry run, refuses non-roots and enables with an audit trail', async () => {
      const def = await enable(null, 'org-a', { roles: ['admin'] });
      expect(def.json().dryRun).toBe(true);
      expect((await enable(null, 'div-1', { roles: ['admin'], dryRun: true })).statusCode).toBe(
        422,
      );
      const before = await epoch('org-a');
      const r = await enable(null, 'org-a', { roles: ['admin'], dryRun: false });
      expect(r.statusCode).toBe(200);
      expect(r.json().bindings).toBeGreaterThanOrEqual(2);
      expect(await epoch('org-a')).toBeGreaterThan(before!);
      const flipped = (await bound('root-inh', 'org-a', 'admin'))[0]!;
      expect(flipped).toMatchObject({ inherit: true, source: 'mirror' });
      const ev = await audit('tenant.inheritance_enabled', 'org-a');
      expect(ev[0]?.payload).toMatchObject({ roles: ['admin'], bindings: r.json().bindings });
      expect(
        (await audit('tenant.role_binding_changed', 'org-a')).some(
          (e) => e.target === flipped.id && (e.payload as { to: boolean }).to === true,
        ),
      ).toBe(true);
      // idempotent
      expect(
        (await enable(null, 'org-a', { roles: ['admin'], dryRun: false })).json().bindings,
      ).toBe(0);
      // admin-a opted in too (same role): hand it back so later tests keep a plain admin
      await n.ctx.db
        .update(tenantRoleBindings)
        .set({ inherit: false })
        .where(
          and(eq(tenantRoleBindings.userId, uid['admin-a']!), eq(tenantRoleBindings.role, 'admin')),
        );
    });

    it('an inheriting mirror row follows the global roles of the user', async () => {
      await n.ctx.db
        .update(usersTable)
        .set({ globalRoles: [] })
        .where(eq(usersTable.id, uid['root-inh']!));
      expect(await bound('root-inh', 'org-a', 'admin')).toHaveLength(0);
      await n.ctx.db
        .update(usersTable)
        .set({ globalRoles: ['admin'] })
        .where(eq(usersTable.id, uid['root-inh']!));
      await reconcileUserBindings(n.ctx.db, uid['root-inh']!);
      expect((await bound('root-inh', 'org-a', 'admin'))[0]).toMatchObject({
        inherit: false,
        source: 'mirror',
      });
    });
  });

  describe('explicit grants and the global_roles mirror (#226)', () => {
    it('an explicit grant survives an unrelated global_roles change, the reconcile and the trigger', async () => {
      await mkUser('keeper', 'org-a', ['viewer']);
      const g = (await post(null, 'org-a', grant('keeper', 'admin'))).json();
      const g2 = (
        await post(
          null,
          'org-a',
          grant('keeper', 'viewer', false, { expiresAt: '2999-01-01T00:00:00Z' }),
        )
      ).json();
      // the same role also as explicit grant next to the mirror row: two rows, two sources
      expect(await bound('keeper', 'org-a', 'viewer')).toHaveLength(2);
      // application path: replace the global roles
      await n.services.identity.updateUser(
        { userId: uid['admin-a']!, tenantId: id['org-a']! },
        uid['keeper']!,
        { globalRoles: ['operator'] },
      );
      expect(await bound('keeper', 'org-a', 'viewer', 'mirror')).toHaveLength(0);
      expect(await bound('keeper', 'org-a', 'operator', 'mirror')).toHaveLength(1);
      expect((await bound('keeper', 'org-a', 'admin', 'grant'))[0]?.id).toBe(g.id);
      expect((await bound('keeper', 'org-a', 'viewer', 'grant'))[0]?.id).toBe(g2.id);
      // SQL path (trigger) and the reconcile
      await n.ctx.db
        .update(usersTable)
        .set({ globalRoles: [] })
        .where(eq(usersTable.id, uid['keeper']!));
      expect((await rows('keeper')).map((b) => `${b.source}|${b.role}`).sort()).toEqual([
        'grant|admin',
        'grant|viewer',
      ]);
      await reconcileUserBindings(n.ctx.db, uid['keeper']!);
      expect((await rows('keeper')).map((b) => `${b.source}|${b.role}`).sort()).toEqual([
        'grant|admin',
        'grant|viewer',
      ]);
      // adding a role through the column and reconciling does not touch the grants either
      await n.ctx.db
        .update(usersTable)
        .set({ globalRoles: ['admin'] })
        .where(eq(usersTable.id, uid['keeper']!));
      await reconcileUserBindings(n.ctx.db, uid['keeper']!);
      expect((await rows('keeper')).map((b) => `${b.source}|${b.role}`).sort()).toEqual([
        'grant|admin',
        'grant|viewer',
        'mirror|admin',
      ]);
    });

    it('an explicit grant survives a home move; the mirror rows move with the user', async () => {
      await mkUser('mover', 'org-a', ['auditor']);
      const g = (await post(null, 'org-a', grant('mover', 'viewer'))).json();
      const gOld = (await post(null, 'org-a', grant('mover', 'auditor'))).json(); // same role as the mirror row
      await n.ctx.db
        .update(usersTable)
        .set({ tenantId: id['div-2']! })
        .where(eq(usersTable.id, uid['mover']!));
      expect((await bound('mover', 'org-a', 'viewer', 'grant'))[0]?.id).toBe(g.id);
      expect((await bound('mover', 'org-a', 'auditor', 'grant'))[0]?.id).toBe(gOld.id);
      expect(await bound('mover', 'org-a', 'auditor', 'mirror')).toHaveLength(0);
      expect(await bound('mover', 'div-2', 'auditor', 'mirror')).toHaveLength(1);
      // no revocation happened, so no unbound event either
      expect((await audit('tenant.role_unbound')).filter((e) => e.target === g.id)).toHaveLength(0);
      // and a move to another organisation stays refused while any binding of the old one exists
      await expect(
        n.ctx.db
          .update(usersTable)
          .set({ tenantId: id['org-b']! })
          .where(eq(usersTable.id, uid['mover']!)),
      ).rejects.toBeDefined();
    });
  });

  describe('effect on authorisation (read path bindings)', () => {
    it('a grant gives access at once, a revocation takes it away at once', async () => {
      if (n.ctx.config.auth.roleBindingsRead !== 'bindings') return;
      await mkUser('fresh', 'org-a', []);
      expect(
        (await n.req({ method: 'GET', url: '/v1/agents', token: tok['fresh']! })).statusCode,
      ).toBe(403);
      const g = (await post('admin-a', 'org-a', grant('fresh', 'viewer'))).json();
      expect(
        (await n.req({ method: 'GET', url: '/v1/agents', token: tok['fresh']! })).statusCode,
      ).toBe(200);
      expect(
        (await n.req({ method: 'DELETE', url: `${rb('org-a')}/${g.id}`, token: tok['admin-a']! }))
          .statusCode,
      ).toBe(204);
      expect(
        (await n.req({ method: 'GET', url: '/v1/agents', token: tok['fresh']! })).statusCode,
      ).toBe(403);
    });

    it('an inheriting administrator may grant below only once the clamp is lifted (S5)', async () => {
      if (n.ctx.config.auth.roleBindingsRead !== 'bindings') return;
      // root-inh was opted in earlier and handed back; give it an inheriting grant on org-a
      const g = await post(null, 'org-a', grant('root-inh', 'admin', true));
      expect(g.statusCode).toBe(201);
      // inherited authority is read-only for now (INHERITED_READ_ONLY): no users:write at div-1
      const r = await post('root-inh', 'div-1', grant('m-d1', 'viewer'));
      expect(r.statusCode).toBe(403);
      // directly on the node it holds, the inheriting grant covers the subtree
      const ok = await post('root-inh', 'org-a', grant('m-d1', 'viewer', true));
      expect(ok.statusCode).toBe(201);
    });
  });
});
