import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLES,
  type NodeRoleGrant,
  type Role,
} from '@openagentix/core';
import { describe, expect, it } from 'vitest';
import {
  coversSubtree,
  isInheritingAdminAt,
  permissionsAt,
  type Actor,
} from '../src/services/grant-authority.js';

/**
 * ADR 0014 S5: who may create below a node and who may grant inheriting roles there, checked
 * against a naive reference that walks parent pointers one by one (it shares no code with the
 * implementation, which reads the chain from the node's path). Seeded, so a failure replays.
 */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (n: number) => Math.floor(next() * n),
    bool: (p = 0.5) => next() < p,
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
  };
}

interface Node {
  id: string;
  rootId: string;
  path: string;
  parentId: string | null;
}
const NOW = new Date('2026-10-10T12:00:00.000Z');
const uid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

function forest(r: ReturnType<typeof rng>): Node[] {
  const nodes: Node[] = [];
  let i = 0;
  const add = (parent: Node | null) => {
    const id = uid(++i);
    nodes.push(
      parent
        ? { id, rootId: parent.rootId, path: `${parent.path}${id}/`, parentId: parent.id }
        : { id, rootId: id, path: `/${id}/`, parentId: null },
    );
  };
  for (let o = 0; o < 1 + r.int(3); o++) add(null);
  const size = 6 + r.int(40);
  while (nodes.length < size) {
    const parent = r.pick(nodes);
    if (parent.path.split('/').length - 2 < 6) add(parent);
  }
  return nodes;
}

function actorOf(r: ReturnType<typeof rng>, nodes: Node[]) {
  const home = r.pick(nodes);
  const org = nodes.filter((n) => n.rootId === home.rootId);
  const bindings: NodeRoleGrant[] = Array.from({ length: r.int(6) }, () => ({
    tenantId: r.pick(org).id,
    role: r.pick(ROLES.filter((x) => x !== 'pentest')) as Role,
    useCase: null,
    inherit: r.bool(0.6),
    expiresAt: r.bool(0.2) ? new Date(NOW.getTime() + (r.bool() ? 1000 : -1000)) : null,
  }));
  const actor: Actor = {
    userId: 'u',
    platformAdmin: false,
    scopes: undefined,
    raw: {
      userId: 'u',
      homeTenantId: home.id,
      homeRootId: home.rootId,
      platformAdmin: false,
      nodeBindings: bindings,
      teamBindings: [],
      agentBindings: [],
    },
  };
  return { actor, bindings };
}

const live = (b: NodeRoleGrant) => b.expiresAt === null || b.expiresAt.getTime() > NOW.getTime();
function ancestorsOrSelf(byId: Map<string, Node>, n: Node): Set<string> {
  const out = new Set<string>();
  for (let cur: Node | undefined = n; cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined)
    out.add(cur.id);
  return out;
}

const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);

describe('property: creation and inheriting grants need coverage', () => {
  it('isInheritingAdminAt = an unexpired inheriting admin binding on the node or an ancestor (seeds 1..200)', () => {
    let positives = 0;
    for (const seed of SEEDS) {
      const r = rng(seed);
      const nodes = forest(r);
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const { actor, bindings } = actorOf(r, nodes);
      for (const n of nodes) {
        const chain = ancestorsOrSelf(byId, n);
        const want = bindings.some(
          (b) => b.role === 'admin' && b.inherit && live(b) && chain.has(b.tenantId),
        );
        if (want) positives++;
        expect(isInheritingAdminAt(actor, n, NOW), `seed ${seed} node ${n.id}`).toBe(want);
      }
    }
    expect(positives).toBeGreaterThan(100);
  });

  it('coverage only flows down: a covered node covers its whole subtree, never an ancestor (seeds 1..200)', () => {
    for (const seed of SEEDS) {
      const r = rng(seed * 7);
      const nodes = forest(r);
      const { actor } = actorOf(r, nodes);
      for (const n of nodes) {
        if (!isInheritingAdminAt(actor, n, NOW)) continue;
        for (const d of nodes.filter((x) => x.path.startsWith(n.path)))
          expect(isInheritingAdminAt(actor, d, NOW), `seed ${seed}`).toBe(true);
      }
    }
  });

  it('coversSubtree(role) holds only when the inheriting bindings above give the whole role (seeds 1..200)', () => {
    for (const seed of SEEDS) {
      const r = rng(seed * 13);
      const nodes = forest(r);
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const { actor, bindings } = actorOf(r, nodes);
      for (const n of nodes) {
        const chain = ancestorsOrSelf(byId, n);
        const have = new Set(
          bindings
            .filter((b) => b.inherit && live(b) && chain.has(b.tenantId))
            .flatMap((b) => ROLE_PERMISSIONS[b.role]),
        );
        for (const role of ROLES.filter((x) => x !== 'pentest') as Role[])
          expect(coversSubtree(actor, n, role, NOW), `seed ${seed} ${role}`).toBe(
            ROLE_PERMISSIONS[role].every((p) => have.has(p)),
          );
      }
    }
  });

  it('permissionsAt never exceeds the union of the roles whose bindings reach the node (seeds 1..200)', () => {
    for (const seed of SEEDS) {
      const r = rng(seed * 31);
      const nodes = forest(r);
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const { actor, bindings } = actorOf(r, nodes);
      for (const n of nodes) {
        const chain = ancestorsOrSelf(byId, n);
        const ceiling = new Set(
          bindings
            .filter((b) => live(b) && (b.tenantId === n.id || (b.inherit && chain.has(b.tenantId))))
            .flatMap((b) => ROLE_PERMISSIONS[b.role]),
        );
        for (const p of permissionsAt(actor, n, NOW)) expect(ceiling, `seed ${seed}`).toContain(p);
        for (const p of PERMISSIONS.filter((x) => ceiling.has(x)))
          expect(permissionsAt(actor, n, NOW), `seed ${seed}`).toContain(p);
      }
    }
  });

  it('a token scope without settings:write never creates, whatever the bindings', () => {
    const r = rng(5);
    const nodes = forest(r);
    const { actor } = actorOf(r, nodes);
    const scoped = { ...actor, scopes: ['agents:read' as const] };
    for (const n of nodes) expect(isInheritingAdminAt(scoped, n, NOW)).toBe(false);
  });

  it('a platform admin always covers; a non-admin never does', () => {
    const r = rng(9);
    const nodes = forest(r);
    const { actor } = actorOf(r, nodes);
    for (const n of nodes) {
      expect(isInheritingAdminAt({ ...actor, platformAdmin: true }, n, NOW)).toBe(true);
      const viewerOnly = {
        ...actor,
        raw: {
          ...actor.raw,
          nodeBindings: [
            {
              tenantId: n.rootId,
              role: 'viewer' as Role,
              useCase: null,
              inherit: true,
              expiresAt: null,
            },
          ],
        },
      };
      expect(isInheritingAdminAt(viewerOnly, n, NOW)).toBe(false);
    }
  });
});
