import { randomUUID } from 'node:crypto';
import {
  GRANTABLE_ROLES,
  effectiveAt,
  reviveGrants,
  serializeGrants,
  type Role,
} from '@openagentix/core';
import { and, eq, sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryCache, ValkeyCache, type ValkeyLike } from '../src/cache.js';
import { DEFAULT_TENANT_ID, tenantRoleBindings, users as usersTable } from '../src/db/schema.js';
import {
  findDriftedUsers,
  loadRawGrants,
  mirrorGlobalRoles,
  reconcileAllBindings,
  reconcileUserBindings,
} from '../src/services/role-bindings.js';
import { BindingReconciler } from '../src/services/binding-reconciler.js';
import { sqlState, sqlTargets } from './db-targets.js';
import { testNode, type TestNode } from './helpers.js';

/**
 * ADR 0014 S1 follow-up (#216, #217): the bindings table is a mirror of `users.global_roles`; the
 * reconcile makes it safe to rely on before the resolver decides. Every test here fails on the S1
 * code (no reconcile, `ON CONFLICT DO NOTHING` hiding a same-key row, rows of the old home node
 * left behind, dates lost in a JSON cache, three connections per load). Runs on PGlite and, with
 * OAX_TEST_DATABASE_URL, on a real PostgreSQL.
 */
const PW = 'long-password-123';

describe.each(sqlTargets)('role binding mirror reconcile (%s)', (_kind, enabled, open) => {
  if (!enabled()) {
    it.skip('needs OAX_TEST_DATABASE_URL', () => undefined);
    return;
  }
  let target: Awaited<ReturnType<typeof open>>;
  let n: TestNode;
  const id = {} as Record<string, string>;
  const db = () => n.ctx.db;
  const rec = () => n.services.identity.reconciler;

  const rows = (userId: string) =>
    db().select().from(tenantRoleBindings).where(eq(tenantRoleBindings.userId, userId));
  const shape = async (userId: string) =>
    (await rows(userId))
      .map(
        (b) =>
          `${b.tenantId === DEFAULT_TENANT_ID ? 'root' : b.tenantId === id.sub ? 'sub' : b.tenantId}|${b.role}|${b.inherit ? 'inh' : 'own'}${b.expiresAt ? '|exp' : ''}${b.useCase ? `|uc:${b.useCase}` : ''}`,
      )
      .sort();
  const setRoles = (userId: string, globalRoles: Role[]) =>
    db().update(usersTable).set({ globalRoles }).where(eq(usersTable.id, userId));
  const homeRoles = async (userId: string) =>
    (await rows(userId))
      .filter((b) => !b.inherit && !b.expiresAt && !b.useCase && b.tenantId === DEFAULT_TENANT_ID)
      .map((b) => b.role)
      .sort();
  const fixes = async (kind: string, trigger?: string) => {
    let total = 0;
    for (const v of (await n.ctx.metrics.roleBindingsReconcileFixes.get()).values)
      if (v.labels.kind === kind && (!trigger || v.labels.trigger === trigger)) total += v.value;
    return total;
  };
  const createUser = async (email: string, globalRoles: Role[]) => {
    const r = await n.req({
      method: 'POST',
      url: '/v1/users',
      payload: { email, displayName: email, password: PW, globalRoles },
    });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  };
  const patchRoles = (userId: string, globalRoles: Role[]) =>
    n.req({ method: 'PATCH', url: `/v1/users/${userId}`, payload: { globalRoles } });
  /** A user row as an application version without the mirror writes it. */
  const oldVersionUser = async (
    email: string,
    globalRoles: Role[],
    tenantId = DEFAULT_TENANT_ID,
  ) => {
    const uid = randomUUID();
    await db().insert(usersTable).values({
      id: uid,
      email,
      displayName: email,
      source: 'local',
      globalRoles,
      tenantId,
    });
    return uid;
  };

  beforeAll(async () => {
    target = await open();
    n = await testNode({ OAX_DATABASE_URL: target.url });
    id.sub = (
      await n.services.tenants.createChild(
        {
          kind: 'user',
          userId: randomUUID(),
          tenantId: DEFAULT_TENANT_ID,
          displayName: 'op',
          platformAdmin: true,
          bindings: [],
        },
        DEFAULT_TENANT_ID,
        { slug: 'sub', name: 'Sub' },
      )
    ).id;
  }, 120_000);
  afterAll(async () => {
    await n.close();
    await target.close();
  });

  describe('drift written by an older application version (#216, point 1)', () => {
    it('adds the binding of a role granted without the mirror', async () => {
      const u = await createUser('old-add@example.org', ['viewer']);
      await setRoles(u, ['viewer', 'admin']); // old version: column only
      expect(await homeRoles(u)).toEqual(['viewer']);
      expect(await findDriftedUsers(db(), '00000000-0000-0000-0000-000000000000', 1000)).toContain(
        u,
      );
      const r = await reconcileUserBindings(db(), u);
      expect(r).toMatchObject({ added: 1, removed: 0, blocked: 0 });
      expect(await homeRoles(u)).toEqual(['admin', 'viewer']);
    });

    it('removes the binding of a role revoked without the mirror (the retained-privilege case)', async () => {
      const u = await createUser('old-del@example.org', ['admin', 'viewer']);
      await setRoles(u, ['viewer']); // old version revokes admin: column only
      expect(await homeRoles(u)).toEqual(['admin', 'viewer']); // admin binding is stale
      const r = await reconcileUserBindings(db(), u);
      expect(r).toMatchObject({ added: 0, removed: 1 });
      expect(await homeRoles(u)).toEqual(['viewer']);
      await setRoles(u, []);
      await reconcileUserBindings(db(), u);
      expect(await rows(u)).toEqual([]);
    });

    it('rolling deploy: users created and changed by old replicas, then one reconcile', async () => {
      const a = await oldVersionUser('roll-a@example.org', ['admin', 'viewer']); // no bindings at all
      const b = await createUser('roll-b@example.org', ['operator']);
      await setRoles(b, ['auditor']); // swapped by an old replica
      const c = await createUser('roll-c@example.org', ['viewer']);
      await setRoles(c, []); // revoked by an old replica
      const before = {
        added: await fixes('added', 'startup'),
        removed: await fixes('removed', 'startup'),
      };
      expect(await homeRoles(a)).toEqual([]);
      const summary = await rec().runAll('startup');
      expect(summary).toMatchObject({ users: expect.any(Number) });
      expect(await homeRoles(a)).toEqual(['admin', 'viewer']);
      expect(await homeRoles(b)).toEqual(['auditor']);
      expect(await homeRoles(c)).toEqual([]);
      expect(await fixes('added', 'startup')).toBe(before.added + 3);
      expect(await fixes('removed', 'startup')).toBe(before.removed + 2);
      // idempotent: a second pass finds nothing
      const again = await rec().runAll('startup');
      expect(again).toMatchObject({ users: 0, added: 0, removed: 0 });
      // and the mirror now behaves: a later removal through the API revokes
      expect((await patchRoles(a, ['viewer'])).statusCode).toBe(200);
      expect(await homeRoles(a)).toEqual(['viewer']);
    });

    it('the dry run reports and changes nothing; the batch size does not matter', async () => {
      const us = [] as string[];
      for (let i = 0; i < 5; i++) us.push(await oldVersionUser(`dry-${i}@example.org`, ['viewer']));
      const dry = await reconcileAllBindings(db(), { dryRun: true, batchSize: 2 });
      expect(dry.fixed).toEqual(expect.arrayContaining(us));
      for (const u of us) expect(await homeRoles(u)).toEqual([]);
      const real = await reconcileAllBindings(db(), { batchSize: 2 });
      expect(real.fixed).toEqual(expect.arrayContaining(us));
      for (const u of us) expect(await homeRoles(u)).toEqual(['viewer']);
    });

    it('ignores roles the application ignores (pentest, unknown), like the backfill', async () => {
      const u = await oldVersionUser('odd@example.org', ['viewer']);
      await db()
        .update(usersTable)
        .set({ globalRoles: ['pentest', 'root', 'viewer'] as Role[] })
        .where(eq(usersTable.id, u));
      await reconcileUserBindings(db(), u);
      expect(await homeRoles(u)).toEqual(['viewer']);
    });

    it('a deleted user is not an error', async () => {
      expect(await reconcileUserBindings(db(), randomUUID())).toBeUndefined();
    });
  });

  describe('rows the mirror does not manage are never touched (#216, point 2)', () => {
    it('leaves inheriting, expiring, use-case, other-node and pentest rows alone', async () => {
      const u = await createUser('keep2@example.org', ['viewer']);
      await db()
        .insert(tenantRoleBindings)
        .values([
          { id: randomUUID(), userId: u, tenantId: id.sub!, role: 'auditor', inherit: true },
          { id: randomUUID(), userId: u, tenantId: id.sub!, role: 'operator' }, // permanent, non-home node
          {
            id: randomUUID(),
            userId: u,
            tenantId: DEFAULT_TENANT_ID,
            role: 'integrator',
            useCase: 'uc',
          },
          {
            id: randomUUID(),
            userId: u,
            tenantId: DEFAULT_TENANT_ID,
            role: 'pentest',
            expiresAt: new Date(Date.now() + 3_600_000),
          },
        ]);
      const before = await shape(u);
      await setRoles(u, []); // drift: viewer revoked by an old version
      const r = await reconcileUserBindings(db(), u);
      expect(r).toMatchObject({ added: 0, removed: 1, blocked: 0 });
      expect(await shape(u)).toEqual(before.filter((s) => !s.startsWith('root|viewer')));
      // reconciling again, and a patch through the API, still leave them
      await reconcileUserBindings(db(), u);
      await patchRoles(u, ['admin']);
      expect(await shape(u)).toEqual(
        [...before.filter((s) => !s.startsWith('root|viewer')), 'root|admin|own'].sort(),
      );
      await db().delete(tenantRoleBindings).where(eq(tenantRoleBindings.userId, u));
    });

    it('a role removed from global_roles revokes a same-key row of any shape (fail closed)', async () => {
      const u = await createUser('revoke@example.org', ['admin', 'viewer']);
      // A row of another shape in the key of a mirrored role. No write API creates one before S4;
      // the test builds it by hand to pin the rule down.
      await db()
        .delete(tenantRoleBindings)
        .where(and(eq(tenantRoleBindings.userId, u), eq(tenantRoleBindings.role, 'admin')));
      await db()
        .insert(tenantRoleBindings)
        .values([
          {
            id: randomUUID(),
            userId: u,
            tenantId: DEFAULT_TENANT_ID,
            role: 'admin',
            inherit: true,
          },
        ]);
      // the mirror cannot add its own row; the existing one is kept and reported
      const kept = await rec().runUser(u, 'cli');
      expect(kept).toMatchObject({ added: 0, removed: 0, blocked: 1 });
      expect(await shape(u)).toEqual(['root|admin|inh', 'root|viewer|own']);
      expect(await fixes('blocked')).toBeGreaterThan(0);
      // removing admin through the API revokes the inheriting row too
      expect((await patchRoles(u, ['viewer'])).statusCode).toBe(200);
      expect(await shape(u)).toEqual(['root|viewer|own']);
      // same for an expiring row and for the reconcile after an old-version removal
      await db()
        .insert(tenantRoleBindings)
        .values({
          id: randomUUID(),
          userId: u,
          tenantId: DEFAULT_TENANT_ID,
          role: 'auditor',
          expiresAt: new Date(Date.now() + 3_600_000),
        });
      await setRoles(u, ['viewer']); // auditor was never in global_roles: stale by definition
      const r = await reconcileUserBindings(db(), u);
      expect(r).toMatchObject({ removed: 1 });
      expect(await shape(u)).toEqual(['root|viewer|own']);
    });

    it('only mirror rows can exist through the application: every write path leaves the plain shape', async () => {
      const u = await createUser('shape@example.org', ['admin', 'operator']);
      await patchRoles(u, ['operator', 'viewer']);
      await n.services.identity.upsertExternalUser(
        'ldap',
        'cn=shape',
        'shape-ext@example.org',
        'S',
        [{ role: 'auditor', teamSlug: null }],
      );
      for (const email of ['shape@example.org', 'shape-ext@example.org', 'admin@example.com']) {
        const [row] = await db().select().from(usersTable).where(eq(usersTable.email, email));
        for (const b of await rows(row!.id)) {
          expect({ inherit: b.inherit, expiresAt: b.expiresAt, useCase: b.useCase }).toEqual({
            inherit: false,
            expiresAt: null,
            useCase: null,
          });
          expect(b.tenantId).toBe(row!.tenantId);
        }
      }
    });
  });

  describe('a change of the home tenant inside the organisation (#216, point 3)', () => {
    it('moves the mirror rows of the old home node with the user, in the same statement', async () => {
      const u = await createUser('mover@example.org', ['admin', 'viewer']);
      await db()
        .insert(tenantRoleBindings)
        .values([
          {
            id: randomUUID(),
            userId: u,
            tenantId: DEFAULT_TENANT_ID,
            role: 'auditor',
            inherit: true,
          },
          {
            id: randomUUID(),
            userId: u,
            tenantId: DEFAULT_TENANT_ID,
            role: 'integrator',
            useCase: 'uc',
          },
        ]);
      await db().update(usersTable).set({ tenantId: id.sub! }).where(eq(usersTable.id, u));
      // old home: mirror rows gone, the others kept; new home: the roles of global_roles
      expect(await shape(u)).toEqual(
        ['root|auditor|inh', 'root|integrator|own|uc:uc', 'sub|admin|own', 'sub|viewer|own'].sort(),
      );
      // and the mirror is consistent: no drift to repair
      const drift = await findDriftedUsers(db(), '00000000-0000-0000-0000-000000000000', 1000);
      expect(drift).not.toContain(u);
      // moving back works the same way
      await db()
        .update(usersTable)
        .set({ tenantId: DEFAULT_TENANT_ID })
        .where(eq(usersTable.id, u));
      expect((await shape(u)).filter((s) => s.startsWith('sub|'))).toEqual([]);
      expect(await homeRoles(u)).toEqual(['admin', 'viewer']);
      await db().delete(tenantRoleBindings).where(eq(tenantRoleBindings.userId, u));
    });

    it('a role revoked after the move is gone from the new home only (nothing left behind)', async () => {
      const u = await createUser('mover2@example.org', ['admin']);
      await db().update(usersTable).set({ tenantId: id.sub! }).where(eq(usersTable.id, u));
      await db().update(usersTable).set({ globalRoles: [] }).where(eq(usersTable.id, u)); // old version
      await reconcileUserBindings(db(), u);
      expect(await rows(u)).toEqual([]); // admin on root was removed by the move, admin on sub by reconcile
    });

    it('still refuses a move to another organisation while bindings of the old one exist', async () => {
      const org = await n.req({
        method: 'POST',
        url: '/v1/tenants',
        payload: {
          slug: 'org-mv',
          name: 'Org MV',
          admin: { email: 'a@org-mv.example.org', displayName: 'A', password: PW },
        },
      });
      const u = await createUser('mover3@example.org', ['viewer']);
      expect(
        await sqlState(
          db().update(usersTable).set({ tenantId: org.json().id }).where(eq(usersTable.id, u)),
        ),
      ).toBe('23514');
      expect(await homeRoles(u)).toEqual(['viewer']);
    });
  });

  describe('mismatch-driven targeted reconcile (shadow check)', () => {
    it('repairs the mismatching user after the principal build; the legacy result decided', async () => {
      const u = await createUser('shadow-fix@example.org', ['viewer']);
      await setRoles(u, ['viewer', 'operator']); // old version grants operator
      const fixed = await fixes('added', 'mismatch');
      const p = await n.services.identity.principalForUser(u);
      expect(p.bindings.map((b) => b.role).sort()).toEqual(['operator', 'viewer']); // legacy decides
      await rec().drain();
      expect(await homeRoles(u)).toEqual(['operator', 'viewer']);
      expect(await fixes('added', 'mismatch')).toBe(fixed + 1);
      // a clean user triggers nothing
      const runs = async () =>
        (await n.ctx.metrics.roleBindingsReconcileRuns.get()).values.reduce(
          (s, v) => s + v.value,
          0,
        );
      const before = await runs();
      await n.services.identity.principalForUser(u);
      await rec().drain();
      expect(await runs()).toBe(before);
    });

    it('does nothing about a mismatch it cannot fix (a foreign row) and does not touch it', async () => {
      const u = await createUser('shadow-foreign@example.org', ['viewer']);
      const stray = {
        id: randomUUID(),
        userId: u,
        tenantId: id.sub!, // another node than the home: not the mirror's business
        role: 'auditor' as const,
        inherit: true,
      };
      await db().insert(tenantRoleBindings).values(stray);
      await n.services.identity.principalForUser(u);
      await rec().drain();
      expect(await shape(u)).toEqual(['root|viewer|own', 'sub|auditor|inh']);
      await db().delete(tenantRoleBindings).where(eq(tenantRoleBindings.id, stray.id));
    });

    it('is rate limited per user and bounded in flight, and never throws', async () => {
      let now = 1_000_000;
      const r = new BindingReconciler({
        db: db(),
        metrics: n.ctx.metrics,
        logger: pino({ level: 'silent' }),
        now: () => new Date(now),
      });
      const u = await createUser('rate@example.org', ['viewer']);
      await setRoles(u, []);
      expect(r.requestUser(u)).toBe(true);
      expect(r.requestUser(u)).toBe(false); // same user: too soon (and one already in flight)
      await r.drain();
      now += 59_000;
      expect(r.requestUser(u)).toBe(false);
      now += 2_000;
      expect(r.requestUser(u)).toBe(true);
      expect(r.requestUser(randomUUID())).toBe(false); // one at a time
      await r.drain();
      expect(r.requestUser(randomUUID())).toBe(true);
      await r.stop();
      expect(r.requestUser(randomUUID())).toBe(false); // stopped
      const skipped = (await n.ctx.metrics.roleBindingsReconcileRuns.get()).values.find(
        (v) => v.labels.outcome === 'skipped',
      );
      expect(skipped?.value).toBeGreaterThan(0);
    });

    it('a failing reconcile is counted and swallowed', async () => {
      const broken = new BindingReconciler({
        db: { transaction: () => Promise.reject(new Error('boom')) } as never,
        metrics: n.ctx.metrics,
        logger: pino({ level: 'silent' }),
        now: () => new Date(),
      });
      expect(await broken.runUser(randomUUID(), 'cli')).toBeUndefined();
      expect(await broken.runAll('cli')).toBeUndefined();
    });
  });

  describe('periodic job and start-up', () => {
    it('the periodic pass repairs drift and stops with the reconciler', async () => {
      const u = await oldVersionUser('periodic@example.org', ['auditor']);
      const r = new BindingReconciler({
        db: db(),
        metrics: n.ctx.metrics,
        logger: pino({ level: 'silent' }),
        now: () => new Date(),
      });
      r.start(25);
      for (let i = 0; i < 200 && (await homeRoles(u)).length === 0; i++)
        await new Promise((res) => setTimeout(res, 25));
      await r.stop();
      expect(await homeRoles(u)).toEqual(['auditor']);
    });

    it('the control node reconciles at start-up unless switched off', async () => {
      const runs = async (node: TestNode) =>
        (await node.ctx.metrics.roleBindingsReconcileRuns.get()).values
          .filter((v) => v.labels.trigger === 'startup')
          .reduce((s, v) => s + v.value, 0);
      const on = await testNode({});
      try {
        expect(await runs(on)).toBe(1);
      } finally {
        await on.close();
      }
      const off = await testNode({ OAX_ROLE_BINDINGS_RECONCILE: 'false' });
      try {
        expect(await runs(off)).toBe(0);
      } finally {
        await off.close();
      }
    });
  });

  describe('concurrency: reconcile against writers of global_roles', () => {
    it('ends consistent whatever the interleaving of PATCH and reconcile', async () => {
      const u = await createUser('race@example.org', ['viewer']);
      const sets: Role[][] = [
        ['admin'],
        ['viewer', 'operator'],
        [],
        ['auditor', 'viewer'],
        ['integrator'],
      ];
      for (let round = 0; round < 12; round++) {
        const want = sets[round % sets.length]!;
        await Promise.all([
          patchRoles(u, want),
          reconcileUserBindings(db(), u),
          reconcileUserBindings(db(), u),
          reconcileAllBindings(db()),
        ]);
        const [row] = await db().select().from(usersTable).where(eq(usersTable.id, u));
        expect(row!.globalRoles.slice().sort()).toEqual([...want].sort());
        // after the writers finish, one reconcile at most fixes nothing: no writer lost an update
        expect(await homeRoles(u)).toEqual([...new Set(want)].sort());
      }
    });

    it('a reconcile waits for a concurrent old-version write and sees its result', async () => {
      if (!target.session) return; // needs two real connections (PostgreSQL only)
      const u = await createUser('lock@example.org', ['viewer']);
      const s = await target.session();
      try {
        await s.query('begin');
        await s.query(`update users set global_roles = array['admin']::text[] where id = $1`, [u]);
        let done = false;
        const rc = reconcileUserBindings(db(), u).then((r) => {
          done = true;
          return r;
        });
        await new Promise((res) => setTimeout(res, 300));
        expect(done).toBe(false); // blocked on the user row
        await s.query('commit');
        const r = await rc;
        expect(r).toMatchObject({ added: 1, removed: 1 });
        expect(await homeRoles(u)).toEqual(['admin']);
      } finally {
        s.release();
      }
    });

    it('a PATCH waits for a running reconcile and wins afterwards (no lost update)', async () => {
      if (!target.session) return;
      const u = await createUser('lock2@example.org', ['viewer']);
      const s = await target.session();
      try {
        await s.query('begin');
        await s.query(`select id from users where id = $1 for no key update`, [u]); // a reconcile in flight
        let done = false;
        const patch = patchRoles(u, ['operator']).then((r) => {
          done = true;
          return r;
        });
        await new Promise((res) => setTimeout(res, 300));
        expect(done).toBe(false);
        await s.query('commit');
        expect((await patch).statusCode).toBe(200);
        expect(await homeRoles(u)).toEqual(['operator']);
      } finally {
        s.release();
      }
    });
  });

  describe('raw grants for the cache (#217)', () => {
    const wire = new Map<string, string>();
    const client: ValkeyLike = {
      get: async (k) => wire.get(k) ?? null,
      set: async (k, v) => {
        wire.set(k, v);
        return 'OK';
      },
      del: async (...ks) => ks.map((k) => wire.delete(k)).filter(Boolean).length,
      scan: async () => ['0', []],
      quit: async () => 'OK',
    };

    it('loads with exactly one statement (one connection)', async () => {
      const [u] = await db()
        .select()
        .from(usersTable)
        .where(eq(usersTable.email, 'admin@example.com'));
      const calls = { select: 0, execute: 0, transaction: 0 };
      const counting = new Proxy(db(), {
        get(t, p, r) {
          const v = Reflect.get(t, p, r);
          if (p === 'select' || p === 'execute' || p === 'transaction')
            return (...a: unknown[]) => {
              calls[p]++;
              return (v as (...x: unknown[]) => unknown).apply(t, a);
            };
          return v;
        },
      });
      const g = await loadRawGrants(counting, u!);
      expect(g).toBeDefined();
      expect(calls).toEqual({ select: 0, execute: 1, transaction: 0 });
    });

    it('many loads at once on a pool of one connection neither deadlock nor change the result', async () => {
      const small = await testNode({ OAX_DATABASE_URL: target.url, OAX_DB_POOL_MAX: '1' });
      try {
        const [u] = await small.ctx.db
          .select()
          .from(usersTable)
          .where(eq(usersTable.email, 'admin@example.com'));
        const results = await Promise.all(
          Array.from({ length: 25 }, () => loadRawGrants(small.ctx.db, u!)),
        );
        for (const r of results) expect(r).toEqual(results[0]);
      } finally {
        await small.close();
      }
    }, 60_000);

    it('a binding with an expiry survives the JSON cache: applies until expiry, then expires', async () => {
      const u = await createUser('cache@example.org', ['viewer']);
      const expires = new Date(Date.now() + 3_600_000);
      await db()
        .insert(tenantRoleBindings)
        .values([
          {
            id: randomUUID(),
            userId: u,
            tenantId: DEFAULT_TENANT_ID,
            role: 'pentest',
            expiresAt: expires,
          },
          {
            id: randomUUID(),
            userId: u,
            tenantId: id.sub!,
            role: 'auditor',
            inherit: true,
            expiresAt: expires,
          },
        ]);
      const [row] = await db().select().from(usersTable).where(eq(usersTable.id, u));
      const loaded = (await loadRawGrants(db(), row!))!;
      const pent = loaded.raw.nodeBindings.find((b) => b.role === 'pentest')!;
      expect(pent.expiresAt).toBeInstanceOf(Date);
      // never later than the stored instant, and at most one millisecond earlier
      expect(expires.getTime() - pent.expiresAt!.getTime()).toBeLessThan(2);
      expect(pent.expiresAt!.getTime()).toBeLessThanOrEqual(expires.getTime());

      for (const cache of [new ValkeyCache(client), new MemoryCache()]) {
        await cache.set(`grants:${u}`, serializeGrants(loaded), 60_000);
        const hit = reviveGrants(await cache.get(`grants:${u}`));
        expect(hit).toBeDefined();
        const at = (t: Date) =>
          effectiveAt(hit!.raw, hit!.home, { now: t, implicitPlatformAdmin: false })
            .map((b) => b.role)
            .sort();
        const direct = (t: Date) =>
          effectiveAt(loaded.raw, loaded.home, { now: t, implicitPlatformAdmin: false })
            .map((b) => b.role)
            .sort();
        const now = new Date();
        expect(at(now)).toContain('pentest');
        expect(at(now)).toEqual(direct(now));
        const later = new Date(expires.getTime() + 1);
        expect(at(later)).not.toContain('pentest');
        expect(at(later)).toEqual(direct(later));
      }
      // the raw value in the wire cache really is JSON text, not a Date
      expect([...wire.values()].some((v) => v.includes(expires.toISOString().slice(0, 19)))).toBe(
        true,
      );
    });

    it('a corrupt cache entry is a miss, never a partial grant list', async () => {
      const cache = new ValkeyCache(client);
      await cache.set('grants:bad', { v: 1, raw: { nodeBindings: [{ expiresAt: 'soon' }] } }, 1000);
      expect(reviveGrants(await cache.get('grants:bad'))).toBeUndefined();
    });
  });

  it('GRANTABLE_ROLES is what the reconcile manages (guards a role added without the mirror)', async () => {
    const u = await oldVersionUser('allroles@example.org', [...GRANTABLE_ROLES]);
    await reconcileUserBindings(db(), u);
    expect(await homeRoles(u)).toEqual([...GRANTABLE_ROLES].sort());
    // mirrorGlobalRoles reports the change it made
    const c = await mirrorGlobalRoles(db(), { id: u, tenantId: DEFAULT_TENANT_ID }, ['viewer']);
    expect(c).toEqual({ added: 0, removed: GRANTABLE_ROLES.length - 1, blocked: 0 });
  });

  it('after all of the above the mirror of every user equals global_roles', async () => {
    await rec().drain();
    await reconcileAllBindings(db());
    expect(await findDriftedUsers(db(), '00000000-0000-0000-0000-000000000000', 1000)).toEqual([]);
    const res = await db().execute(sql`select count(*)::int as c from tenant_role_bindings`);
    expect((res as unknown as { rows: { c: number }[] }).rows[0]!.c).toBeGreaterThan(0);
  });
});
