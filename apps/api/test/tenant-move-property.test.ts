import { randomUUID } from 'node:crypto';
import {
  ROLES,
  ROLE_PERMISSIONS,
  appliedAt,
  type Permission,
  type Principal,
  type Role,
  type RoleRestriction,
} from '@openagentix/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_TENANT_ID,
  tenantRoleBindings,
  tenantRoleRestrictions,
  tenants,
  users as usersTable,
} from '../src/db/schema.js';
import { loadRawGrants } from '../src/services/role-bindings.js';
import { sqlTargets } from './db-targets.js';
import { testNode, type TestNode } from './helpers.js';
import { Tree, naive, rng, type Node, type User } from './move-reference.js';

/**
 * Move invariants on the real stack (ADR 0014 section 13, slice S10): random trees, bindings,
 * attachments and restrictions in the database; the move through the API (dry run, then apply) as a
 * platform operator; permissions read with the real loader and resolver and compared with the naive
 * reference that walks the parent pointers stored in the database. Seeded, so a failure replays.
 *
 *  - outside the moved subtree nothing changes for anybody;
 *  - everywhere, before and after, the resolver equals the reference;
 *  - the dry run lists exactly the users whose permissions inside the subtree change, with the
 *    right number of gaining and losing nodes, and changes nothing;
 *  - the stored tree stays consistent (path, depth, root, parent) and the node count is conserved.
 */
const USE_CASES = ['sec', 'sec/a', 'ops'];
const SEEDS = Array.from({ length: 12 }, (_, i) => 7000 + i);

describe.each(sqlTargets)('tenant move properties (%s)', (_kind, enabled, open) => {
  if (!enabled()) {
    it.skip('needs OAX_TEST_DATABASE_URL', () => undefined);
    return;
  }
  let target: Awaited<ReturnType<typeof open>>;
  let n: TestNode;
  const op = (): Principal => ({
    kind: 'user',
    userId: randomUUID(),
    tenantId: DEFAULT_TENANT_ID,
    displayName: 'op',
    platformAdmin: true,
    bindings: [],
  });
  beforeAll(async () => {
    target = await open();
    n = await testNode({
      OAX_DATABASE_URL: target.url,
      OAX_ROLE_BINDINGS_READ: 'bindings',
      OAX_RATE_LIMIT_RESTRICTION_MAX: '100000',
      OAX_BINDING_REAPER_INTERVAL_SECONDS: '0',
    });
  }, 120_000);
  afterAll(async () => {
    await n.close();
    await target.close();
  });

  const nodesOf = async (rootId: string): Promise<Node[]> =>
    (await n.ctx.db.select().from(tenants).where(eq(tenants.rootId, rootId))).map((t) => ({
      id: t.id,
      rootId: t.rootId,
      path: t.path,
      parentId: t.parentId,
      useCase: t.useCase,
    }));

  it.each(SEEDS)(
    'seed %i',
    async (seed) => {
      const r = rng(seed);
      const tag = `p${seed}`;
      // --- a random organisation
      const root = await n.services.tenants.create(op(), { slug: `${tag}-0`, name: tag });
      const ids = [root.id];
      for (let i = 1; i < 9 + r.int(8); i++) {
        const parent = r.pick(ids.filter((x) => x === root.id || true));
        const row = await n.services.tenants.createChild(op(), parent, {
          slug: `${tag}-${i}`,
          name: `${tag}-${i}`,
        });
        ids.push(row.id);
        if (r.bool(0.3))
          await n.ctx.db
            .update(tenants)
            .set({ useCase: r.pick(USE_CASES) })
            .where(eq(tenants.id, row.id));
      }
      const now = n.ctx.now();
      const people: User[] = [];
      for (let k = 0; k < 8; k++) {
        const id = randomUUID();
        await n.ctx.db.insert(usersTable).values({
          id,
          email: `${tag}-u${k}@example.org`,
          displayName: `u${k}`,
          source: 'local',
          tenantId: r.pick(ids),
        });
        const bindings = Array.from({ length: 1 + r.int(4) }, () => {
          const role = r.pick([...ROLES, 'admin', 'viewer', 'operator'] as Role[]);
          return {
            tenantId: r.pick(ids),
            role,
            useCase: role !== 'pentest' && r.bool(0.2) ? r.pick(USE_CASES) : null,
            inherit: r.bool(0.65),
            expiresAt: role === 'pentest' ? new Date(now.getTime() + 3_600_000) : null,
          };
        });
        const seen = new Set<string>();
        for (const b of bindings.filter((x) => {
          const key = `${x.tenantId}/${x.role}/${x.useCase}`;
          return !seen.has(key) && !!seen.add(key);
        }))
          await n.ctx.db.insert(tenantRoleBindings).values({
            id: randomUUID(),
            userId: id,
            tenantId: b.tenantId,
            role: b.role,
            inherit: b.inherit,
            useCase: b.useCase,
            expiresAt: b.expiresAt,
            source: 'grant',
          });
        people.push({
          id,
          rootId: root.id,
          bindings: bindings.filter(
            (x, i) =>
              bindings.findIndex(
                (y) => y.tenantId === x.tenantId && y.role === x.role && y.useCase === x.useCase,
              ) === i,
          ),
        });
      }
      // same-organisation rule: the trigger accepted every binding (all nodes are in one organisation)
      const restrictions: RoleRestriction[] = [];
      for (let i = 0; i < r.int(5); i++) {
        const role = r.pick(ROLES.filter((x) => x !== 'admin'));
        const e = { tenantId: r.pick(ids), role, permission: r.pick(ROLE_PERMISSIONS[role]) };
        if (
          restrictions.some(
            (x) => x.tenantId === e.tenantId && x.role === e.role && x.permission === e.permission,
          )
        )
          continue;
        restrictions.push(e);
        await n.ctx.db.insert(tenantRoleRestrictions).values(e);
      }

      /** Permissions per user and node, from the real loader and resolver on the stored tree. */
      const read = async () => {
        const nodes = await nodesOf(root.id);
        const tree = new Tree(nodes);
        const out = new Map<string, Map<string, Set<Permission>>>();
        for (const u of people) {
          const home = (
            await n.ctx.db.select().from(usersTable).where(eq(usersTable.id, u.id))
          )[0]!;
          const loaded = (await loadRawGrants(n.ctx.db, {
            id: u.id,
            tenantId: home.tenantId,
            platformAdmin: false,
          }))!;
          const perUser = new Map<string, Set<Permission>>();
          for (const node of nodes) {
            const real = new Set(
              appliedAt(loaded.raw, node, { now, implicitPlatformAdmin: false }).flatMap(
                (b) => b.permissions,
              ),
            );
            const ref = naive(tree, now, u, restrictions, node.id);
            expect([...real].sort(), `${u.id} at ${node.id}`).toEqual([...ref].sort());
            perUser.set(node.id, real);
          }
          out.set(u.id, perUser);
        }
        return { nodes, tree, out };
      };

      for (let step = 0; step < 3; step++) {
        const before = await read();
        const movable = before.nodes.filter((x) => x.parentId !== null);
        if (movable.length === 0) return;
        const x = r.pick(movable);
        const targets = before.nodes.filter(
          (t) => !before.tree.inSubtree(t.id, x.id) && t.id !== x.parentId,
        );
        if (targets.length === 0) continue;
        const q = r.pick(targets);
        const inside = new Set(
          before.nodes.filter((t) => before.tree.inSubtree(t.id, x.id)).map((t) => t.id),
        );

        const call = (dryRun: boolean) =>
          n.req({
            method: 'POST',
            url: `/v1/tenants/${x.id}/move`,
            payload: { parentId: q.id, dryRun },
          });
        const dry = await call(true);
        expect(dry.statusCode, dry.body).toBe(200);
        // the dry run changed nothing
        expect(
          JSON.stringify(
            (await nodesOf(root.id)).map((t) => [t.id, t.path, t.parentId, t.useCase]).sort(),
          ),
        ).toBe(
          JSON.stringify(before.nodes.map((t) => [t.id, t.path, t.parentId, t.useCase]).sort()),
        );
        const real = await call(false);
        expect(real.statusCode, real.body).toBe(200);
        const after = await read();

        // the stored tree is consistent and nothing was lost
        expect(after.nodes).toHaveLength(before.nodes.length);
        for (const t of after.nodes) {
          if (t.parentId === null) continue;
          expect(t.path).toBe(`${after.tree.byId.get(t.parentId)!.path}${t.id}/`);
        }
        expect(after.tree.byId.get(x.id)!.parentId).toBe(q.id);

        const expected: { userId: string; gained: number; lost: number }[] = [];
        for (const u of people) {
          let gained = 0;
          let lost = 0;
          for (const node of before.nodes) {
            const b = before.out.get(u.id)!.get(node.id)!;
            const a = after.out.get(u.id)!.get(node.id)!;
            if (!inside.has(node.id)) {
              // outside the subtree nothing changes
              expect([...a].sort(), `${u.id} outside ${node.id}`).toEqual([...b].sort());
              continue;
            }
            if ([...a].some((p) => !b.has(p))) gained++;
            if ([...b].some((p) => !a.has(p))) lost++;
          }
          if (gained + lost > 0) expected.push({ userId: u.id, gained, lost });
        }
        // the dry run lists exactly those users, with the same counts
        const listed = (
          dry.json().principals as { userId: string; gainedNodes: number; lostNodes: number }[]
        )
          .map((p) => ({ userId: p.userId, gained: p.gainedNodes, lost: p.lostNodes }))
          .sort((a, b) => a.userId.localeCompare(b.userId));
        expect(listed, `dry run of step ${step}`).toEqual(
          expected.sort((a, b) => a.userId.localeCompare(b.userId)),
        );
      }
    },
    120_000,
  );
});
