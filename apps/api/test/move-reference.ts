import {
  ROLE_PERMISSIONS,
  USE_CASE_PERMISSIONS,
  type NodeRoleGrant,
  type Permission,
  type RoleRestriction,
} from '@openagentix/core';

/**
 * Naive reference for the move invariants (ADR 0014 section 13): permissions of a user at a node by
 * walking parent pointers one by one. It shares no code with the resolver (which reads the chain
 * from the node's path) or with the move (which rewrites paths).
 */
export function rng(seed: number) {
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
export type Rng = ReturnType<typeof rng>;

export interface Node {
  id: string;
  rootId: string;
  path: string;
  parentId: string | null;
  useCase: string | null;
}
export interface User {
  id: string;
  rootId: string;
  bindings: NodeRoleGrant[];
}

export const matches = (uc: string, nodeUc: string | null) =>
  nodeUc !== null && (nodeUc === uc || nodeUc.startsWith(`${uc}/`));

/** The tree as parent pointers; `walk(n)` is n, its parent, ... up to the root. */
export class Tree {
  readonly byId = new Map<string, Node>();
  constructor(readonly nodes: readonly Node[]) {
    for (const n of nodes) this.byId.set(n.id, n);
  }
  walk(id: string): Node[] {
    const out: Node[] = [];
    for (let n = this.byId.get(id); n; n = n.parentId ? this.byId.get(n.parentId) : undefined)
      out.push(n);
    return out;
  }
  inSubtree(id: string, root: string): boolean {
    return this.walk(id).some((n) => n.id === root);
  }
}

/** Naive permissions of a user at a node; `anchors` limits which bindings count (undefined: all). */
export function naive(
  tree: Tree,
  now: Date,
  user: User,
  rs: readonly RoleRestriction[],
  nodeId: string,
  anchors?: (anchor: string) => boolean,
  ignoredRestrictionNodes: ReadonlySet<string> = new Set(),
): Set<Permission> {
  const out = new Set<Permission>();
  const chain = tree.walk(nodeId); // node first
  for (const b of user.bindings) {
    if (anchors && !anchors(b.tenantId)) continue;
    if (b.role === 'pentest' && (b.useCase !== null || b.expiresAt === null)) continue;
    if (b.expiresAt !== null && !(b.expiresAt.getTime() > now.getTime())) continue;
    const at = chain.findIndex((n) => n.id === b.tenantId);
    if (at < 0) continue;
    let unrestrictedUseCase = false;
    if (at > 0) {
      if (b.useCase === null) {
        if (!b.inherit) continue;
      } else {
        // attached: the child of the anchor on the way down must carry the use case
        const child = chain[at - 1]!;
        if (!b.inherit || !matches(b.useCase, child.useCase)) continue;
        unrestrictedUseCase = true;
      }
    }
    let perms: Permission[] = [...ROLE_PERMISSIONS[b.role]];
    if (b.role !== 'admin') {
      const above = new Set(tree.walk(b.tenantId).map((n) => n.id));
      const removed = rs.filter(
        (x) =>
          x.role === b.role && above.has(x.tenantId) && !ignoredRestrictionNodes.has(x.tenantId),
      );
      perms = perms.filter((p) => !removed.some((x) => x.permission === p));
    }
    if (b.useCase !== null && !unrestrictedUseCase)
      perms = perms.filter((p) => USE_CASE_PERMISSIONS.includes(p));
    for (const p of perms) out.add(p);
  }
  return out;
}
