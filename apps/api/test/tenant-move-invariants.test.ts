import {
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  appliedAt,
  rebasePath,
  type NodeRoleGrant,
  type Permission,
  type RawGrants,
  type Role,
  type RoleRestriction,
} from '@openagentix/core';
import { describe, expect, it } from 'vitest';
import { isInheritingAdminAt, type Actor } from '../src/services/grant-authority.js';
import { Tree, matches, naive, rng, type Node, type Rng, type User } from './move-reference.js';

/**
 * ADR 0014 section 13, "Move invariant" (slice S10, #195), over random forests and random grants,
 * against a naive reference that walks parent pointers one by one (it shares no code with the
 * resolver, which reads the chain from the node's path, nor with the move itself, which rewrites
 * paths). Seeded, so a failure replays: the seed is in the test name. The service-level properties
 * (the real loader, the real move, the dry run) are in tenant-move-property.test.ts.
 *
 * After moving X below Q (inside one organisation, Q not in subtree(X)):
 *
 *  1. nodes outside subtree(X): effective permissions of every principal are unchanged;
 *  2. nodes inside subtree(X): they equal the permissions of the bindings anchored in subtree(X)
 *     plus those of the bindings anchored on chain(Q) (the ADR formula), and the resolver agrees
 *     with the naive reference before and after;
 *  3. nobody gains a permission inside the subtree except through bindings on chain(Q) or, where a
 *     restriction of an ancestor the node left narrowed a binding inside, through that restriction
 *     ending (the move refuses the latter unless the mover may lift it, see the API tests); with no
 *     such restriction the gains are exactly the bindings of chain(Q);
 *  4. the mover (inheriting admin on X, the old parent and Q) gains no coverage: its authority
 *     predicate is the same in the reference and the implementation, and its permissions after the
 *     move are within what it held before plus the admin role.
 */
const NOW = new Date('2026-10-10T12:00:00.000Z');
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const USE_CASES = ['sec', 'sec/a', 'ops'];
const ADMIN = new Set<Permission>(ROLE_PERMISSIONS.admin);

function forest(r: Rng): Node[] {
  const nodes: Node[] = [];
  let i = 0;
  const add = (parent: Node | null) => {
    const id = uuid(++i);
    nodes.push(
      parent
        ? {
            id,
            rootId: parent.rootId,
            path: `${parent.path}${id}/`,
            parentId: parent.id,
            useCase: r.bool(0.25) ? r.pick(USE_CASES) : null,
          }
        : { id, rootId: id, path: `/${id}/`, parentId: null, useCase: null },
    );
  };
  add(null);
  add(null);
  const size = 8 + r.int(30);
  while (nodes.length < size) {
    const parent = r.pick(nodes);
    if (parent.path.split('/').length - 2 < 7) add(parent);
  }
  return nodes;
}

function users(r: Rng, nodes: readonly Node[], count: number): User[] {
  return Array.from({ length: count }, (_, k) => {
    const home = r.pick(nodes);
    const org = nodes.filter((n) => n.rootId === home.rootId);
    // admins are common enough that moves qualify often
    const roles = [...ROLES, 'admin', 'admin', 'viewer', 'operator'] as Role[];
    return {
      id: `u${k}`,
      rootId: home.rootId,
      bindings: Array.from({ length: 1 + r.int(4) }, (): NodeRoleGrant => {
        const role = r.pick(roles);
        return {
          tenantId: r.pick(org).id,
          role,
          useCase: role !== 'pentest' && r.bool(0.2) ? r.pick(USE_CASES) : null,
          inherit: r.bool(0.65),
          expiresAt:
            role === 'pentest' || r.bool(0.1)
              ? new Date(NOW.getTime() + (r.bool(0.7) ? 3_600_000 : -1000))
              : null,
        };
      }),
    };
  });
}

function restrictions(r: Rng, nodes: readonly Node[]): RoleRestriction[] {
  const out: RoleRestriction[] = [];
  for (let i = 0; i < r.int(6); i++) {
    const role = r.pick(ROLES.filter((x) => x !== 'admin'));
    out.push({
      tenantId: r.pick(nodes).id,
      role,
      permission: r.pick(ROLE_PERMISSIONS[role]),
    });
  }
  return out;
}

function raw(user: User, tree: Tree): RawGrants {
  return {
    userId: user.id,
    homeTenantId: user.rootId,
    homeRootId: user.rootId,
    platformAdmin: false,
    nodeBindings: user.bindings.map((b) => ({
      ...b,
      // what the loader resolves: the children of the anchor attached to the binding's use case
      attachedNodeIds:
        b.useCase !== null && b.inherit
          ? tree.nodes
              .filter((c) => c.parentId === b.tenantId && matches(b.useCase!, c.useCase))
              .map((c) => c.id)
          : [],
    })),
    teamBindings: [],
    agentBindings: [],
  };
}

const resolver = (user: User, tree: Tree, rs: readonly RoleRestriction[], n: Node) =>
  new Set(
    appliedAt(raw(user, tree), n, {
      now: NOW,
      restrictions: rs,
      implicitPlatformAdmin: false,
    }).flatMap((b) => b.permissions),
  );

const same = (a: ReadonlySet<Permission>, b: ReadonlySet<Permission>) =>
  a.size === b.size && [...a].every((x) => b.has(x));
const without = (a: ReadonlySet<Permission>, b: ReadonlySet<Permission>) =>
  [...a].filter((x) => !b.has(x));

/** The move as the service performs it on the data: parents, paths and the cleared use case. */
function moved(tree: Tree, x: Node, q: Node): Tree {
  const toPath = `${q.path}${x.id}/`;
  return new Tree(
    tree.nodes.map((n) =>
      n.path.startsWith(x.path)
        ? {
            ...n,
            path: rebasePath(n.path, x.path, toPath),
            parentId: n.id === x.id ? q.id : n.parentId,
            useCase: n.id === x.id ? null : n.useCase,
          }
        : n,
    ),
  );
}

const stats = { moves: 0, changed: 0, movers: 0 };
const SEEDS = Array.from({ length: 400 }, (_, i) => 1000 + i);

describe('move invariants (ADR 0014 section 13) against the naive reference', () => {
  it.each(SEEDS)('seed %i', (seed) => {
    const r = rng(seed);
    const before = new Tree(forest(r));
    const us = users(r, before.nodes, 6 + r.int(8));
    const rs = restrictions(r, before.nodes);
    // a movable pair: X below a parent, Q in the same organisation, not in subtree(X), not its parent
    const candidates = before.nodes.filter((n) => n.parentId !== null);
    const x = r.pick(candidates);
    const targets = before.nodes.filter(
      (n) => n.rootId === x.rootId && !before.inSubtree(n.id, x.id) && n.id !== x.parentId,
    );
    if (targets.length === 0) return;
    const q = r.pick(targets);
    const oldParent = before.byId.get(x.parentId!)!;
    const after = moved(before, x, q);
    const qChain = new Set(before.walk(q.id).map((n) => n.id));
    const lostAncestors = new Set(
      before
        .walk(oldParent.id)
        .map((n) => n.id)
        .filter((id) => !qChain.has(id)),
    );
    stats.moves++;
    const subtree = before.nodes.filter((n) => before.inSubtree(n.id, x.id));
    const inside = new Set(subtree.map((n) => n.id));
    // the restrictions the service would call "dropped" (it refuses them without authority)
    const roleAnchored = new Set(
      us.flatMap((u) => u.bindings.filter((b) => inside.has(b.tenantId)).map((b) => b.role)),
    );
    const dropsRestriction = rs.some(
      (e) => lostAncestors.has(e.tenantId) && roleAnchored.has(e.role),
    );

    for (const u of us) {
      for (const n of before.nodes) {
        const b = resolver(u, before, rs, n);
        const a = resolver(u, after, rs, after.byId.get(n.id)!);
        // the resolver is the reference, before and after
        expect(same(b, naive(before, NOW, u, rs, n.id)), `${u.id} before at ${n.id}`).toBe(true);
        expect(same(a, naive(after, NOW, u, rs, n.id)), `${u.id} after at ${n.id}`).toBe(true);
        if (!inside.has(n.id)) {
          // 1. outside: unchanged
          expect(same(a, b), `${u.id} outside at ${n.id}`).toBe(true);
          continue;
        }
        if (!same(a, b)) stats.changed++;
        // 2. inside: bindings anchored in the subtree plus bindings on chain(Q) (the ADR formula)
        const formula = new Set<Permission>([
          ...naive(after, NOW, u, rs, n.id, (anchor) => inside.has(anchor)),
          ...naive(after, NOW, u, rs, n.id, (anchor) => qChain.has(anchor)),
        ]);
        expect(same(a, formula), `${u.id} formula at ${n.id}`).toBe(true);
        // 3. gains come from chain(Q), or from a lifted restriction of a node the subtree left
        const fromQ = naive(after, NOW, u, rs, n.id, (anchor) => qChain.has(anchor));
        const fromLifted = naive(
          after,
          NOW,
          u,
          rs,
          n.id,
          (anchor) => inside.has(anchor),
          lostAncestors,
        );
        const gained = without(a, b);
        const allowed = dropsRestriction ? new Set<Permission>([...fromQ, ...fromLifted]) : fromQ;
        expect(
          gained.filter((p) => !allowed.has(p)),
          `${u.id} widened at ${n.id}`,
        ).toEqual([]);
      }
    }

    // 4. the mover: an inheriting admin (no use case, unexpired) on X, the old parent and Q
    const asActor = (u: User): Actor => ({
      userId: u.id,
      platformAdmin: false,
      scopes: undefined,
      raw: raw(u, before),
    });
    const refAdminAt = (u: User, id: string) => {
      const chain = new Set(before.walk(id).map((n) => n.id));
      return u.bindings.some(
        (b) =>
          b.role === 'admin' &&
          b.useCase === null &&
          b.inherit &&
          chain.has(b.tenantId) &&
          (b.expiresAt === null || b.expiresAt.getTime() > NOW.getTime()),
      );
    };
    for (const u of us) {
      const ids = [x.id, oldParent.id, q.id];
      for (const id of ids)
        expect(
          isInheritingAdminAt(asActor(u), before.byId.get(id)!, NOW),
          `${u.id} admin at ${id}`,
        ).toBe(refAdminAt(u, id));
      if (!ids.every((id) => refAdminAt(u, id))) continue;
      stats.movers++;
      for (const n of before.nodes) {
        const b = resolver(u, before, rs, n);
        const a = resolver(u, after, rs, after.byId.get(n.id)!);
        // coverage (nodes with any permission) never grows, and no permission beyond admin appears
        if (a.size > 0)
          expect(b.size > 0 || inside.has(n.id), `${u.id} coverage at ${n.id}`).toBe(true);
        expect(
          without(a, b).filter((p) => !ADMIN.has(p)),
          `${u.id} gained beyond admin at ${n.id}`,
        ).toEqual([]);
      }
    }
  });

  it('the generator exercises real moves, real changes and real movers (not vacuous)', () => {
    expect(stats.moves).toBeGreaterThan(300);
    expect(stats.changed).toBeGreaterThan(300);
    expect(stats.movers).toBeGreaterThan(50);
  });

  it('every permission is known to the reference (guards the generator)', () => {
    for (const role of ROLES)
      for (const p of ROLE_PERMISSIONS[role]) expect(PERMISSIONS).toContain(p);
  });
});
