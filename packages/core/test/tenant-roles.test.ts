import { describe, expect, it } from 'vitest';
import {
  GRANTABLE_ROLES,
  PERMISSIONS,
  USE_CASE_PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  bindingFingerprint,
  bindingPermissions,
  appliedAt,
  effectiveAt,
  hasPermission,
  isGrantableRole,
  isRole,
  sameBindings,
  visibleNodeIds,
  visibleTeams,
  type NodeRoleGrant,
  type Permission,
  type RawGrants,
  type Role,
  type RoleBinding,
  type RoleNode,
  type RoleRestriction,
} from '../src/index.js';

// ---------------------------------------------------------------- fixtures and a seeded generator

/** Small deterministic PRNG so that a failing property replays from its seed. */
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
    next,
    int: (n: number) => Math.floor(next() * n),
    bool: (p = 0.5) => next() < p,
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
  };
}

const hex = (r: ReturnType<typeof rng>, n: number) =>
  Array.from({ length: n }, () => r.int(16).toString(16)).join('');
const uuid = (r: ReturnType<typeof rng>) =>
  `${hex(r, 8)}-${hex(r, 4)}-4${hex(r, 3)}-8${hex(r, 3)}-${hex(r, 12)}`;

interface Node extends RoleNode {
  parentId: string | null;
}

/** A random forest: `orgs` roots, then nodes attached to random existing nodes up to depth 6. */
function forest(r: ReturnType<typeof rng>, orgs: number, size: number): Node[] {
  const nodes: Node[] = [];
  const add = (parent: Node | null): Node => {
    const id = uuid(r);
    const n: Node = parent
      ? { id, rootId: parent.rootId, path: `${parent.path}${id}/`, parentId: parent.id }
      : { id, rootId: id, path: `/${id}/`, parentId: null };
    nodes.push(n);
    return n;
  };
  for (let i = 0; i < orgs; i++) add(null);
  while (nodes.length < size) {
    const parent = r.pick(nodes);
    if (parent.path.split('/').length - 2 >= 6) continue;
    add(parent);
  }
  return nodes;
}

const NOW = new Date('2026-10-10T12:00:00.000Z');
const ahead = (ms: number) => new Date(NOW.getTime() + ms);

const grant = (tenantId: string, role: Role, over: Partial<NodeRoleGrant> = {}): NodeRoleGrant => ({
  tenantId,
  role,
  useCase: null,
  inherit: false,
  expiresAt: null,
  ...over,
});

const rawOf = (home: Node, over: Partial<RawGrants> = {}): RawGrants => ({
  userId: 'u1',
  homeTenantId: home.id,
  homeRootId: home.rootId,
  platformAdmin: false,
  nodeBindings: [],
  teamBindings: [],
  agentBindings: [],
  ...over,
});

const permsOf = (bs: readonly RoleBinding[]): Permission[] =>
  PERMISSIONS.filter((p) => bs.some((b) => bindingPermissions(b).includes(p)));

// org A:   root
//           |- a ---- a1
//           `- b
// org B:   x
function fixture() {
  const root: Node = {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    rootId: '',
    path: '',
    parentId: null,
  };
  root.rootId = root.id;
  root.path = `/${root.id}/`;
  const child = (id: string, parent: Node): Node => ({
    id,
    rootId: parent.rootId,
    path: `${parent.path}${id}/`,
    parentId: parent.id,
  });
  const a = child('aaaaaaaa-0000-4000-8000-0000000000a1', root);
  const a1 = child('aaaaaaaa-0000-4000-8000-0000000000a2', a);
  const b = child('aaaaaaaa-0000-4000-8000-0000000000b1', root);
  const x: Node = {
    id: 'bbbbbbbb-0000-4000-8000-000000000001',
    rootId: '',
    path: '',
    parentId: null,
  };
  x.rootId = x.id;
  x.path = `/${x.id}/`;
  return { root, a, a1, b, x, all: [root, a, a1, b, x] };
}

const opts = { now: NOW };

// ---------------------------------------------------------------------------- unit tests

describe('rbac additions', () => {
  it('knows pentest but does not offer it as a grantable role', () => {
    expect(ROLES).toContain('pentest');
    expect(GRANTABLE_ROLES).not.toContain('pentest');
    expect(isGrantableRole('pentest')).toBe(false);
    expect(isRole('pentest')).toBe(true);
    expect([...GRANTABLE_ROLES, 'pentest'].sort()).toEqual([...ROLES].sort());
    expect(ROLE_PERMISSIONS.pentest).toContain('audit:read');
    for (const w of [
      'agents:write',
      'runs:execute',
      'runs:approve',
      'audit:export',
      'tokens:write',
    ])
      expect(ROLE_PERMISSIONS.pentest).not.toContain(w);
    expect(ROLE_PERMISSIONS.viewer).not.toContain('audit:read');
  });

  it('bindingPermissions never exceeds the role, whatever the binding carries', () => {
    const widened: RoleBinding = {
      role: 'viewer',
      teamId: null,
      permissions: ['agents:read', 'agents:write', 'users:write'],
    };
    expect(bindingPermissions(widened)).toEqual(['agents:read']);
    expect(bindingPermissions({ role: 'viewer', teamId: null })).toEqual(ROLE_PERMISSIONS.viewer);
    expect(bindingPermissions({ role: 'admin', teamId: null, permissions: [] })).toEqual([]);
  });

  it('hasPermission and visibleTeams read the narrowed permissions', () => {
    const p = {
      kind: 'user' as const,
      userId: 'u',
      tenantId: 't',
      platformAdmin: false,
      displayName: 'U',
      bindings: [{ role: 'admin' as const, teamId: null, permissions: ['agents:read' as const] }],
    };
    expect(hasPermission(p, 'agents:read')).toBe(true);
    expect(hasPermission(p, 'agents:write')).toBe(false);
    expect(visibleTeams(p, 'agents:write')).toEqual([]);
  });
});

describe('effectiveAt', () => {
  const f = fixture();

  it('applies a non-inheriting binding at its own node only', () => {
    const raw = rawOf(f.a, { nodeBindings: [grant(f.a.id, 'admin')] });
    expect(effectiveAt(raw, f.a, opts)).toEqual([
      {
        role: 'admin',
        teamId: null,
        permissions: ROLE_PERMISSIONS.admin,
        useCase: null,
        source: 'direct',
      },
    ]);
    for (const n of [f.root, f.a1, f.b, f.x]) expect(effectiveAt(raw, n, opts)).toEqual([]);
  });

  it('applies an inheriting binding to the node and its descendants, never up or sideways', () => {
    const raw = rawOf(f.a, { nodeBindings: [grant(f.a.id, 'auditor', { inherit: true })] });
    expect(effectiveAt(raw, f.a, opts).map((b) => b.source)).toEqual(['direct']);
    expect(effectiveAt(raw, f.a1, opts).map((b) => b.source)).toEqual(['inherited']);
    for (const n of [f.root, f.b, f.x]) expect(effectiveAt(raw, n, opts)).toEqual([]);
  });

  it('write inheritance: an inherited binding gives its whole role below, and nothing else (S5)', () => {
    const raw = rawOf(f.root, { nodeBindings: [grant(f.root.id, 'admin', { inherit: true })] });
    const inherited = effectiveAt(raw, f.a1, opts);
    expect(inherited).toHaveLength(1);
    expect(inherited[0]).toMatchObject({ source: 'inherited', role: 'admin' });
    // The role is the ceiling: exactly what holding admin at the node itself gives.
    expect(inherited[0]!.permissions).toEqual(ROLE_PERMISSIONS.admin);
    expect(inherited[0]!.permissions).toContain('agents:write');
    expect(inherited[0]!.permissions).toContain('users:write');
    expect(effectiveAt(raw, f.root, opts)[0]!.permissions).toEqual(ROLE_PERMISSIONS.admin);
    // A weaker role stays weaker: an inherited viewer cannot write.
    const viewer = rawOf(f.root, { nodeBindings: [grant(f.root.id, 'viewer', { inherit: true })] });
    expect(effectiveAt(viewer, f.a1, opts)[0]!.permissions).toEqual(ROLE_PERMISSIONS.viewer);
    expect(effectiveAt(viewer, f.a1, opts)[0]!.permissions).not.toContain('agents:write');
    // Without the opt-in nothing flows down, whatever the role.
    const plain = rawOf(f.root, { nodeBindings: [grant(f.root.id, 'admin')] });
    expect(effectiveAt(plain, f.a1, opts)).toEqual([]);
  });

  it('team and agent bindings never inherit, even with write inheritance on (S5)', () => {
    const raw = rawOf(f.root, {
      teamBindings: [{ tenantId: f.root.id, teamId: 't', role: 'admin' }],
      agentBindings: [{ tenantId: f.root.id, agentId: 'a', teamId: 't', role: 'admin' }],
    });
    expect(effectiveAt(raw, f.a1, opts)).toEqual([]);
  });

  it('never applies a binding in another organisation, even a hand-made one', () => {
    const raw = rawOf(f.a, {
      nodeBindings: [
        grant(f.x.id, 'admin', { inherit: true }),
        grant(f.root.id, 'viewer', { inherit: true }),
      ],
    });
    expect(effectiveAt(raw, f.x, opts)).toEqual([]);
    expect(effectiveAt(raw, f.a, opts).map((b) => b.role)).toEqual(['viewer']);
    // Team and agent grants of a node in another organisation do not apply there either.
    const foreign = rawOf(f.a, {
      teamBindings: [{ tenantId: f.x.id, teamId: 't1', role: 'admin' }],
      agentBindings: [{ tenantId: f.x.id, agentId: 'g1', teamId: null, role: 'admin' }],
    });
    expect(effectiveAt(foreign, f.x, opts)).toEqual([]);
  });

  it('applies team and agent bindings at their own node only (they never inherit)', () => {
    const raw = rawOf(f.a, {
      teamBindings: [{ tenantId: f.a.id, teamId: 't1', role: 'operator' }],
      agentBindings: [{ tenantId: f.a.id, agentId: 'g1', teamId: null, role: 'agent-engineer' }],
    });
    expect(effectiveAt(raw, f.a, opts).map((b) => [b.source, b.teamId, b.agentId ?? null])).toEqual(
      [
        ['team', 't1', null],
        ['agent', null, 'g1'],
      ],
    );
    for (const n of [f.root, f.a1, f.b]) expect(effectiveAt(raw, n, opts)).toEqual([]);
  });

  it('evaluates expiry per call at the exact second', () => {
    const t = ahead(60_000);
    const raw = rawOf(f.a, { nodeBindings: [grant(f.a.id, 'auditor', { expiresAt: t })] });
    expect(effectiveAt(raw, f.a, { now: new Date(t.getTime() - 1) })).toHaveLength(1);
    expect(effectiveAt(raw, f.a, { now: t })).toEqual([]);
    expect(effectiveAt(raw, f.a, { now: new Date(t.getTime() + 1) })).toEqual([]);
  });

  it('fails closed: pentest without expiry, malformed use cases, unknown roles, bad nodes', () => {
    const bad = rawOf(f.a, {
      nodeBindings: [
        grant(f.a.id, 'pentest'),
        grant(f.a.id, 'admin', { useCase: 'security/' }),
        grant(f.a.id, 'admin', { useCase: 'a b' }),
        grant(f.a.id, 'admin', { useCase: '' }),
        grant(f.a.id, 'pentest', { useCase: 'security', expiresAt: ahead(1000) }),
        grant(f.a.id, 'root' as Role),
      ],
    });
    expect(effectiveAt(bad, f.a, opts)).toEqual([]);
    const ok = rawOf(f.a, { nodeBindings: [grant(f.a.id, 'pentest', { expiresAt: ahead(1000) })] });
    expect(effectiveAt(ok, f.a, opts)[0]!.permissions).toEqual(ROLE_PERMISSIONS.pentest);
    const raw = rawOf(f.a, { nodeBindings: [grant(f.a.id, 'admin')] });
    expect(effectiveAt(raw, { ...f.a, path: '/nope/' }, opts)).toEqual([]);
    expect(effectiveAt(raw, { ...f.a, id: f.b.id }, opts)).toEqual([]);
    expect(effectiveAt(raw, { ...f.a, rootId: f.x.id }, opts)).toEqual([]);
    // The node's id must be the last id of its path: a team of a1 must not apply at "a1" placed
    // at a's path.
    const team = rawOf(f.a, { teamBindings: [{ tenantId: f.a1.id, teamId: 't1', role: 'admin' }] });
    expect(effectiveAt(team, f.a1, opts)).toHaveLength(1);
    expect(effectiveAt(team, { ...f.a, id: f.a1.id }, opts)).toEqual([]);
    // The node's root must be the first id of its path: a node of org A claiming org B's root
    // gets nothing from a user of org B.
    const orgB = rawOf(f.x, { nodeBindings: [grant(f.a.id, 'admin')] });
    expect(effectiveAt(orgB, { ...f.a, rootId: f.x.id }, opts)).toEqual([]);
    expect(effectiveAt({ ...raw, platformAdmin: true }, { ...f.a, path: '/nope/' }, opts)).toEqual(
      [],
    );
  });

  it('fails closed on an expiry or a clock that is not a valid date', () => {
    const invalid = rawOf(f.a, {
      nodeBindings: [
        grant(f.a.id, 'auditor', { expiresAt: new Date('not a date') }),
        grant(f.a.id, 'pentest', { expiresAt: new Date(Number.NaN) }),
        // what a JSON round trip (a cached principal) turns a Date into
        grant(f.a.id, 'viewer', { expiresAt: ahead(60_000).toISOString() as unknown as Date }),
        grant(f.a.id, 'operator', { expiresAt: undefined as unknown as Date }),
      ],
    });
    expect(effectiveAt(invalid, f.a, opts)).toEqual([]);
    // An invalid `now` ends every expiring binding; bindings without an expiry are unaffected.
    const mixed = rawOf(f.a, {
      nodeBindings: [
        grant(f.a.id, 'auditor', { expiresAt: ahead(60_000) }),
        grant(f.a.id, 'viewer'),
      ],
    });
    expect(effectiveAt(mixed, f.a, { now: new Date(Number.NaN) }).map((b) => b.role)).toEqual([
      'viewer',
    ]);
  });

  it('fails closed on a chain that names a node twice or is deeper than the tree can be', () => {
    // `/root/a/a1/a/`: a1 (a descendant of a) would sit in the "ancestors" of a and its
    // inheriting binding would flow up.
    const loop: RoleNode = { ...f.a, path: `${f.a1.path}${f.a.id}/` };
    const raw = rawOf(f.a, {
      nodeBindings: [grant(f.a1.id, 'admin', { inherit: true }), grant(f.a.id, 'viewer')],
    });
    expect(effectiveAt(raw, f.a, opts).map((b) => b.role)).toEqual(['viewer']);
    expect(effectiveAt(raw, loop, opts)).toEqual([]);
    const ids = Array.from(
      { length: 34 },
      (_, i) => `cccccccc-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    const deep: RoleNode = { id: ids[33]!, rootId: ids[0]!, path: `/${ids.join('/')}/` };
    const deepRaw: RawGrants = {
      ...rawOf(f.a, { nodeBindings: [grant(deep.id, 'viewer')] }),
      homeRootId: deep.rootId,
    };
    expect(effectiveAt(deepRaw, deep, opts)).toEqual([]);
    const ok: RoleNode = { id: ids[32]!, rootId: ids[0]!, path: `/${ids.slice(0, 33).join('/')}/` };
    expect(
      effectiveAt({ ...deepRaw, nodeBindings: [grant(ok.id, 'viewer')] }, ok, opts),
    ).toHaveLength(1);
  });

  it('makes a platform admin admin everywhere, unless asked not to', () => {
    const raw = rawOf(f.a, { platformAdmin: true, nodeBindings: [grant(f.a.id, 'viewer')] });
    for (const n of f.all) {
      const out = effectiveAt(raw, n, opts);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ role: 'admin', source: 'platform' });
      expect(out[0]!.permissions).toEqual(PERMISSIONS);
    }
    expect(
      effectiveAt(raw, f.a, { ...opts, implicitPlatformAdmin: false }).map((b) => b.role),
    ).toEqual(['viewer']);
    expect(effectiveAt(raw, f.x, { ...opts, implicitPlatformAdmin: false })).toEqual([]);
  });

  describe('restrictions', () => {
    const restrict = (tenantId: string, role: Role, permission: Permission): RoleRestriction => ({
      tenantId,
      role,
      permission,
    });

    it('remove permissions at the restricting node and below, not from bindings above it', () => {
      const r = [restrict(f.a.id, 'operator', 'runs:approve')];
      const above = rawOf(f.root, {
        nodeBindings: [grant(f.root.id, 'operator', { inherit: true })],
      });
      const atA = rawOf(f.root, { nodeBindings: [grant(f.a.id, 'operator', { inherit: true })] });
      const below = rawOf(f.root, { nodeBindings: [grant(f.a1.id, 'operator')] });
      const withR = { ...opts, restrictions: r };
      // Bound above the restricting node: untouched, also when it is felt below it.
      expect(effectiveAt(above, f.a1, withR)[0]!.permissions).toContain('runs:approve');
      // Bound on the restricting node or below it: restricted.
      expect(effectiveAt(atA, f.a, withR)[0]!.permissions).not.toContain('runs:approve');
      expect(effectiveAt(atA, f.a1, withR)[0]!.permissions).not.toContain('runs:approve');
      expect(effectiveAt(below, f.a1, withR)[0]!.permissions).not.toContain('runs:approve');
      // Restrictions of an unrelated node do nothing.
      const sideways = { ...opts, restrictions: [restrict(f.b.id, 'operator', 'runs:approve')] };
      expect(effectiveAt(below, f.a1, sideways)[0]!.permissions).toContain('runs:approve');
    });

    it('apply to team and agent bindings by the restrictions of the node chain', () => {
      const raw = rawOf(f.a, {
        teamBindings: [{ tenantId: f.a.id, teamId: 't', role: 'operator' }],
      });
      const out = effectiveAt(raw, f.a, {
        ...opts,
        restrictions: [restrict(f.root.id, 'operator', 'runs:cancel')],
      });
      expect(out[0]!.permissions).not.toContain('runs:cancel');
    });

    it('never touch admin', () => {
      const raw = rawOf(f.a, { nodeBindings: [grant(f.a.id, 'admin')] });
      const out = effectiveAt(raw, f.a, {
        ...opts,
        restrictions: [restrict(f.a.id, 'admin', 'users:write')],
      });
      expect(out[0]!.permissions).toEqual(ROLE_PERMISSIONS.admin);
    });
  });
});

describe('fingerprints', () => {
  it('ignore order and duplicates, see role, scope and permissions', () => {
    const x: RoleBinding = { role: 'operator', teamId: 't' };
    const y: RoleBinding = { role: 'viewer', teamId: null };
    expect(sameBindings([x, y], [y, x, y])).toBe(true);
    expect(sameBindings([x], [{ ...x, teamId: 'u' }])).toBe(false);
    expect(sameBindings([x], [{ ...x, agentId: 'a' }])).toBe(false);
    expect(sameBindings([x], [{ ...x, permissions: ['runs:read'] }])).toBe(false);
    expect(
      sameBindings([x], [{ ...x, permissions: ROLE_PERMISSIONS.operator, source: 'team' }]),
    ).toBe(true);
    expect(sameBindings([], [])).toBe(true);
    expect(bindingFingerprint([x])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------- property tests

/** Reference implementation: walks parent pointers one by one, shares no code with the resolver. */
function naiveCovers(
  byId: Map<string, Node>,
  b: NodeRoleGrant,
  target: Node,
  homeRoot: string,
  now: Date,
): 'direct' | 'inherited' | 'scoped' | 'attached' | null {
  if (b.useCase !== null && b.role === 'pentest') return null;
  if (b.role === 'pentest' && b.expiresAt === null) return null;
  if (b.expiresAt && b.expiresAt.getTime() <= now.getTime()) return null;
  if (target.rootId !== homeRoot) return null;
  if (b.tenantId === target.id) return b.useCase !== null ? 'scoped' : 'direct';
  if (!b.inherit) return null;
  let below: Node = target;
  for (let cur = target.parentId ? byId.get(target.parentId) : undefined; cur;) {
    if (cur.id === b.tenantId) {
      if (b.useCase === null) return 'inherited';
      // a use-case binding reaches only the attached child on the chain (and its subtree)
      return b.attachedNodeIds?.includes(below.id) ? 'attached' : null;
    }
    below = cur;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return null;
}

function naivePermissions(
  byId: Map<string, Node>,
  raw: RawGrants,
  target: Node,
  now: Date,
  restrictions: readonly RoleRestriction[],
): Permission[] {
  if (raw.platformAdmin) return [...PERMISSIONS];
  const out = new Set<Permission>();
  const chainIds = (n: Node): string[] => {
    const ids: string[] = [];
    for (
      let cur: Node | undefined = n;
      cur;
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    )
      ids.push(cur.id);
    return ids;
  };
  const add = (role: Role, anchor: Node, scoped = false) => {
    const above = new Set(chainIds(anchor));
    for (const p of ROLE_PERMISSIONS[role]) {
      if (scoped && !USE_CASE_PERMISSIONS.includes(p)) continue;
      if (
        role !== 'admin' &&
        restrictions.some((r) => r.role === role && r.permission === p && above.has(r.tenantId))
      )
        continue;
      out.add(p);
    }
  };
  for (const b of raw.nodeBindings) {
    const how = naiveCovers(byId, b, target, raw.homeRootId, now);
    if (how) add(b.role, byId.get(b.tenantId)!, how === 'scoped');
  }
  if (target.rootId === raw.homeRootId) {
    for (const t of raw.teamBindings) if (t.tenantId === target.id) add(t.role, target);
    for (const a of raw.agentBindings) if (a.tenantId === target.id) add(a.role, target);
  }
  return PERMISSIONS.filter((p) => out.has(p));
}

function randomCase(seed: number) {
  const r = rng(seed);
  const nodes = forest(r, 1 + r.int(3), 6 + r.int(40));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const home = r.pick(nodes);
  const sameOrg = nodes.filter((n) => n.rootId === home.rootId);
  const node = (): Node => (r.bool(0.85) ? r.pick(sameOrg) : r.pick(nodes)); // some foreign-org nodes
  const nodeBindings: NodeRoleGrant[] = Array.from({ length: r.int(8) }, () => {
    const role = r.pick(ROLES);
    const expires = r.bool(0.3) ? new Date(NOW.getTime() + (r.int(3) - 1) * 1000 * r.int(3)) : null;
    const at = node();
    const useCase = r.bool(0.15) ? 'security' : null;
    // For a use-case binding that inherits: some of the children of its node count as attached.
    const kids = nodes.filter((n) => n.parentId === at.id && r.bool(0.6)).map((n) => n.id);
    const inherit = r.bool(0.5);
    return grant(at.id, role, {
      inherit,
      expiresAt: expires,
      useCase,
      ...(useCase !== null && inherit && kids.length > 0 ? { attachedNodeIds: kids } : {}),
    });
  });
  const raw: RawGrants = rawOf(home, {
    nodeBindings,
    teamBindings: Array.from({ length: r.int(4) }, (_, i) => ({
      tenantId: node().id,
      teamId: `team-${i}`,
      role: r.pick(ROLES),
    })),
    agentBindings: Array.from({ length: r.int(3) }, (_, i) => ({
      tenantId: node().id,
      agentId: `agent-${i}`,
      teamId: r.bool() ? `team-${i}` : null,
      role: r.pick(ROLES),
    })),
  });
  const restrictions: RoleRestriction[] = Array.from({ length: r.int(6) }, () => ({
    tenantId: node().id,
    role: r.pick(ROLES),
    permission: r.pick(PERMISSIONS),
  }));
  return { r, nodes, byId, home, raw, restrictions };
}

const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);

describe('property: the resolver agrees with a naive parent-walking reference', () => {
  it('on random forests (seeds 1..200)', () => {
    for (const seed of SEEDS) {
      const c = randomCase(seed);
      for (const n of c.nodes) {
        const got = permsOf(effectiveAt(c.raw, n, { now: NOW, restrictions: c.restrictions }));
        const want = naivePermissions(c.byId, c.raw, n, NOW, c.restrictions);
        expect(got, `seed ${seed} node ${n.id}`).toEqual(want);
      }
    }
  });
});

describe('property: nothing flows up, sideways or across organisations', () => {
  it('only bindings on the chain of the node contribute (seeds 1..200)', () => {
    for (const seed of SEEDS) {
      const c = randomCase(seed);
      const o = { now: NOW, restrictions: c.restrictions };
      for (const n of c.nodes) {
        const chain = new Set(n.path.split('/').filter(Boolean));
        const pruned: RawGrants = {
          ...c.raw,
          nodeBindings: c.raw.nodeBindings.filter(
            (b) => chain.has(b.tenantId) && (b.inherit || b.tenantId === n.id),
          ),
          teamBindings: c.raw.teamBindings.filter((t) => t.tenantId === n.id),
          agentBindings: c.raw.agentBindings.filter((a) => a.tenantId === n.id),
        };
        expect(bindingFingerprint(effectiveAt(c.raw, n, o)), `seed ${seed} node ${n.id}`).toEqual(
          bindingFingerprint(effectiveAt(pruned, n, o)),
        );
        for (const b of effectiveAt(c.raw, n, o)) {
          if (b.source === 'inherited') expect(n.rootId).toBe(c.home.rootId);
        }
      }
    }
  });

  it('a single binding covers exactly its node, or its subtree when inheriting (seeds 1..200)', () => {
    for (const seed of SEEDS) {
      const c = randomCase(seed);
      const r = rng(seed * 7919);
      const b = grant(r.pick(c.nodes).id, r.pick(ROLES.filter((x) => x !== 'pentest')), {
        inherit: r.bool(),
      });
      const raw = { ...c.raw, nodeBindings: [b], teamBindings: [], agentBindings: [] };
      const origin = c.byId.get(b.tenantId)!;
      for (const n of c.nodes) {
        const out = effectiveAt(raw, n, { now: NOW });
        const inSubtree = n.path.startsWith(origin.path);
        const sameOrg = n.rootId === c.home.rootId;
        const expected = sameOrg && (n.id === origin.id || (b.inherit && inSubtree));
        expect(out.length > 0, `seed ${seed} node ${n.id}`).toBe(expected);
      }
    }
  });

  it('without inherit flags nothing but own-node grants applies (seeds 1..200)', () => {
    for (const seed of SEEDS) {
      const c = randomCase(seed);
      const raw = {
        ...c.raw,
        nodeBindings: c.raw.nodeBindings.map((b) => ({ ...b, inherit: false })),
      };
      for (const n of c.nodes)
        for (const b of effectiveAt(raw, n, { now: NOW }))
          expect(['direct', 'team', 'agent'], `seed ${seed}`).toContain(b.source);
    }
  });

  it('bindings on foreign-organisation nodes change nothing anywhere (seeds 1..200)', () => {
    for (const seed of SEEDS) {
      const c = randomCase(seed);
      const foreign = (id: string) => c.byId.get(id)!.rootId !== c.home.rootId;
      const stripped: RawGrants = {
        ...c.raw,
        nodeBindings: c.raw.nodeBindings.filter((b) => !foreign(b.tenantId)),
        teamBindings: c.raw.teamBindings.filter((t) => !foreign(t.tenantId)),
        agentBindings: c.raw.agentBindings.filter((a) => !foreign(a.tenantId)),
      };
      for (const n of c.nodes)
        expect(bindingFingerprint(effectiveAt(c.raw, n, opts)), `seed ${seed}`).toEqual(
          bindingFingerprint(effectiveAt(stripped, n, opts)),
        );
    }
  });

  it('nodes of other organisations are never visible (seeds 1..200)', () => {
    for (const seed of SEEDS) {
      const c = randomCase(seed);
      const visible = visibleNodeIds(c.raw, c.nodes, { now: NOW });
      for (const id of visible) expect(c.byId.get(id)!.rootId).toBe(c.home.rootId);
    }
  });
});

describe('property: monotonicity, expiry, platform admin, role ceiling', () => {
  it('adding a binding never removes a permission; adding a restriction never adds one (seeds 1..200)', () => {
    for (const seed of SEEDS) {
      const c = randomCase(seed);
      const r = rng(seed * 104729);
      const extra = grant(r.pick(c.nodes).id, r.pick(ROLES.filter((x) => x !== 'pentest')), {
        inherit: r.bool(),
      });
      const more: RawGrants = { ...c.raw, nodeBindings: [...c.raw.nodeBindings, extra] };
      const restriction: RoleRestriction = {
        tenantId: r.pick(c.nodes).id,
        role: r.pick(ROLES),
        permission: r.pick(PERMISSIONS),
      };
      const o = { now: NOW, restrictions: c.restrictions };
      for (const n of c.nodes) {
        const before = permsOf(effectiveAt(c.raw, n, o));
        const after = permsOf(effectiveAt(more, n, o));
        for (const p of before) expect(after, `seed ${seed} grant`).toContain(p);
        const restricted = permsOf(
          effectiveAt(c.raw, n, { ...o, restrictions: [...c.restrictions, restriction] }),
        );
        for (const p of restricted) expect(before, `seed ${seed} restriction`).toContain(p);
      }
    }
  });

  it('a restriction never changes what a binding from above it grants (seeds 1..200)', () => {
    for (const seed of SEEDS) {
      const c = randomCase(seed);
      const r = rng(seed * 31);
      const above = r.pick(c.nodes);
      const below = c.nodes.filter((n) => n.path.startsWith(above.path) && n.id !== above.id);
      if (below.length === 0) continue;
      const restrictAt = r.pick(below);
      const role = r.pick(ROLES.filter((x) => x !== 'pentest'));
      const raw: RawGrants = {
        ...c.raw,
        nodeBindings: [grant(above.id, role, { inherit: true })],
        teamBindings: [],
        agentBindings: [],
      };
      const restriction: RoleRestriction = {
        tenantId: restrictAt.id,
        role,
        permission: r.pick(PERMISSIONS),
      };
      for (const n of c.nodes) {
        // R is below the binding's node, so R is not on the chain of the binding's node: untouched.
        const o = { now: NOW };
        expect(
          bindingFingerprint(effectiveAt(raw, n, { ...o, restrictions: [restriction] })),
          `seed ${seed} node ${n.id}`,
        ).toEqual(bindingFingerprint(effectiveAt(raw, n, o)));
      }
    }
  });

  it('a binding contributes one millisecond before its expiry and not at it (seeds 1..200)', () => {
    for (const seed of SEEDS) {
      const c = randomCase(seed);
      const r = rng(seed * 17);
      const t = new Date(NOW.getTime() + 1000 * (1 + r.int(1000)));
      const n = r.pick(c.nodes.filter((x) => x.rootId === c.home.rootId));
      const role = r.pick(ROLES);
      const raw: RawGrants = {
        ...c.raw,
        nodeBindings: [grant(n.id, role, { expiresAt: t })],
        teamBindings: [],
        agentBindings: [],
      };
      expect(effectiveAt(raw, n, { now: new Date(t.getTime() - 1) }), `seed ${seed}`).toHaveLength(
        1,
      );
      expect(effectiveAt(raw, n, { now: t }), `seed ${seed}`).toHaveLength(0);
    }
  });

  it('a platform admin is admin everywhere, whatever the bindings (seeds 1..200)', () => {
    for (const seed of SEEDS) {
      const c = randomCase(seed);
      const raw = { ...c.raw, platformAdmin: true };
      for (const n of c.nodes) {
        const out = effectiveAt(raw, n, { now: NOW, restrictions: c.restrictions });
        expect(out, `seed ${seed}`).toHaveLength(1);
        expect(out[0]).toMatchObject({ role: 'admin', source: 'platform' });
        expect(permsOf(out)).toEqual(PERMISSIONS);
      }
    }
  });

  it('without restrictions an inherited binding gives exactly its role, never more (seeds 1..200)', () => {
    let inherited = 0;
    for (const seed of SEEDS) {
      const c = randomCase(seed);
      for (const n of c.nodes)
        for (const b of effectiveAt(c.raw, n, { now: NOW }))
          if (b.source === 'inherited') {
            inherited++;
            expect([...b.permissions!].sort(), `seed ${seed}`).toEqual(
              [...ROLE_PERMISSIONS[b.role]].sort(),
            );
          }
    }
    expect(inherited).toBeGreaterThan(100);
  });

  it('every effective permission belongs to the role of the binding (seeds 1..200)', () => {
    for (const seed of SEEDS) {
      const c = randomCase(seed);
      for (const n of c.nodes)
        for (const b of effectiveAt(c.raw, n, { now: NOW, restrictions: c.restrictions }))
          for (const p of b.permissions)
            expect(ROLE_PERMISSIONS[b.role], `seed ${seed}`).toContain(p);
    }
  });
});

describe('S2: appliedAt is the one implementation behind effectiveAt', () => {
  it('returns the same bindings plus a correct anchor for each (seeds 1..200)', () => {
    for (const seed of SEEDS) {
      const c = randomCase(seed);
      for (const n of c.nodes) {
        const opts = { now: NOW, restrictions: c.restrictions };
        const plain = effectiveAt(c.raw, n, opts);
        const applied = appliedAt(c.raw, n, opts);
        expect(
          applied.map((b) => [b.role, b.teamId, b.agentId ?? null, b.source, [...b.permissions]]),
          `seed ${seed} node ${n.id}`,
        ).toEqual(
          plain.map((b) => [b.role, b.teamId, b.agentId ?? null, b.source, [...b.permissions!]]),
        );
        for (const b of applied) {
          if (b.source === 'direct' || b.source === 'team' || b.source === 'agent')
            expect(b.tenantId).toBe(n.id);
          if (b.source === 'inherited') {
            expect(b.inherit).toBe(true);
            expect(b.tenantId).not.toBe(n.id);
            expect(n.path.includes(`/${b.tenantId}/`), `seed ${seed}`).toBe(true);
          }
          if (b.expiresAt) expect(b.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
        }
      }
    }
  });
});

describe('S2: the visible set of a principal', () => {
  it('is exactly the grant nodes, plus their subtrees for inheriting ones, in the home organisation (seeds 1..200)', () => {
    for (const seed of SEEDS) {
      const r = rng(seed * 7919);
      const nodes = forest(r, 1 + r.int(3), 6 + r.int(40));
      const home = r.pick(nodes);
      const sameOrg = nodes.filter((n) => n.rootId === home.rootId);
      const grants = Array.from({ length: r.int(6) }, () =>
        grant(r.pick(sameOrg).id, r.pick(GRANTABLE_ROLES), { inherit: r.bool(0.5) }),
      );
      const raw = rawOf(home, { nodeBindings: grants });
      const got = new Set(visibleNodeIds(raw, nodes, { now: NOW, implicitPlatformAdmin: false }));
      const want = new Set<string>();
      for (const g of grants)
        for (const n of sameOrg)
          if (
            n.id === g.tenantId ||
            (g.inherit && n.path.startsWith(sameOrg.find((x) => x.id === g.tenantId)!.path))
          )
            want.add(n.id);
      expect([...got].sort(), `seed ${seed}`).toEqual([...want].sort());
      // never a node of another organisation, never an ancestor the grants do not cover
      for (const id of got) expect(nodes.find((n) => n.id === id)!.rootId).toBe(home.rootId);
    }
  });

  it('shrinks to nothing when every grant expires, and an inherited grant keeps its role', () => {
    const f = fixture();
    const raw = rawOf(f.root, {
      nodeBindings: [grant(f.root.id, 'admin', { inherit: true, expiresAt: ahead(1000) })],
    });
    const at = (ms: number) => ({ now: ahead(ms), implicitPlatformAdmin: false });
    expect(visibleNodeIds(raw, f.all, at(999)).length).toBe(
      f.all.filter((n) => n.rootId === f.root.rootId).length,
    );
    expect(visibleNodeIds(raw, f.all, at(1000))).toEqual([]);
    for (const b of effectiveAt(raw, f.a, at(0))) expect(b.source).toBe('inherited');
    expect(permsOf(effectiveAt(raw, f.a, at(0)))).toEqual(
      PERMISSIONS.filter((p) => ROLE_PERMISSIONS.admin.includes(p)),
    );
  });
});

// ---------------------------------------------------------------------------- use cases (S8)

describe('use-case bindings (ADR 0014 section 3.3)', () => {
  const f = fixture();
  const opts = { now: NOW };
  const scoped = (b: ReturnType<typeof effectiveAt>[number]) => b.useCase;

  it('apply at their own node only, limited to the use-case permissions', () => {
    const raw = rawOf(f.a, {
      nodeBindings: [grant(f.a.id, 'admin', { useCase: 'security', inherit: true })],
    });
    const out = effectiveAt(raw, f.a, opts);
    expect(out).toHaveLength(1);
    expect(scoped(out[0]!)).toBe('security');
    expect(out[0]!.source).toBe('direct');
    expect(out[0]!.teamId).toBeNull();
    // Node-wide permissions (connections, settings, tokens, audit verification) are never carried.
    for (const p of PERMISSIONS)
      expect(out[0]!.permissions.includes(p), p).toBe(USE_CASE_PERMISSIONS.includes(p));
    // Not below (no attachment), not above, not beside.
    for (const n of [f.root, f.a1, f.b, f.x]) expect(effectiveAt(raw, n, opts), n.id).toEqual([]);
  });

  it('reach an attached child and its whole subtree, unrestricted, only with inherit', () => {
    const attached = [f.a.id];
    const base = grant(f.root.id, 'operator', { useCase: 'security', attachedNodeIds: attached });
    const without = rawOf(f.root, { nodeBindings: [{ ...base, inherit: false }] });
    for (const n of [f.a, f.a1]) expect(effectiveAt(without, n, opts)).toEqual([]);
    const withInherit = rawOf(f.root, { nodeBindings: [{ ...base, inherit: true }] });
    for (const n of [f.a, f.a1]) {
      const out = effectiveAt(withInherit, n, opts);
      expect(out, n.id).toHaveLength(1);
      expect(out[0]!.source).toBe('attached');
      expect(out[0]!.useCase).toBeNull();
      expect(out[0]!.permissions).toEqual(ROLE_PERMISSIONS.operator);
    }
    // The sibling that is not listed, the node itself (scoped) and other organisations.
    expect(effectiveAt(withInherit, f.b, opts)).toEqual([]);
    expect(effectiveAt(withInherit, f.root, opts)[0]!.useCase).toBe('security');
    expect(effectiveAt(withInherit, f.x, opts)).toEqual([]);
  });

  it('never attach through a missing, empty or foreign attachment list (fail closed)', () => {
    for (const attachedNodeIds of [undefined, [], [f.b.id], [f.x.id], ['nope']]) {
      const raw = rawOf(f.root, {
        nodeBindings: [
          grant(f.root.id, 'admin', {
            useCase: 'security',
            inherit: true,
            ...(attachedNodeIds ? { attachedNodeIds } : {}),
          }),
        ],
      });
      for (const n of [f.a, f.a1]) expect(effectiveAt(raw, n, opts), `${n.id}`).toEqual([]);
    }
    // A grandchild listed as "attached" is not a child of the binding's node: it does not count.
    const raw = rawOf(f.root, {
      nodeBindings: [
        grant(f.root.id, 'admin', {
          useCase: 'security',
          inherit: true,
          attachedNodeIds: [f.a1.id],
        }),
      ],
    });
    expect(effectiveAt(raw, f.a1, opts)).toEqual([]);
  });

  it('respect expiry and the platform-admin short cut', () => {
    const t = ahead(1000);
    const raw = rawOf(f.root, {
      nodeBindings: [
        grant(f.root.id, 'admin', {
          useCase: 'security',
          inherit: true,
          attachedNodeIds: [f.a.id],
          expiresAt: t,
        }),
      ],
    });
    expect(effectiveAt(raw, f.a, { now: new Date(t.getTime() - 1) })).toHaveLength(1);
    expect(effectiveAt(raw, f.a, { now: t })).toEqual([]);
    expect(effectiveAt(raw, f.root, { now: t })).toEqual([]);
  });

  it('are removed from role restrictions only like any binding, never admin', () => {
    const raw = rawOf(f.a, {
      nodeBindings: [grant(f.a.id, 'operator', { useCase: 'security' })],
    });
    const out = effectiveAt(raw, f.a, {
      ...opts,
      restrictions: [{ tenantId: f.a.id, role: 'operator', permission: 'runs:approve' }],
    });
    expect(out[0]!.permissions).not.toContain('runs:approve');
    expect(out[0]!.permissions).toContain('runs:execute');
  });
});

/** Naive reference for the loader: the children of `parent` attached to `useCase` or below it. */
function attachedChildren(
  nodes: readonly (Node & { useCase?: string | null })[],
  parent: Node,
  useCase: string,
): string[] {
  return nodes
    .filter(
      (n) =>
        n.parentId === parent.id &&
        typeof n.useCase === 'string' &&
        (n.useCase === useCase || n.useCase.startsWith(`${useCase}/`)),
    )
    .map((n) => n.id);
}

describe('property: the attach invariant (ADR 0014 section 13)', () => {
  const USE_CASES = ['sec', 'sec/appsec', 'sec/infra', 'ops', 'ops/oncall'];

  /** The raw grants of a user with the attachments resolved for the given node attachments. */
  function withAttachments(
    raw: RawGrants,
    nodes: readonly (Node & { useCase?: string | null })[],
    byId: Map<string, Node>,
  ): RawGrants {
    return {
      ...raw,
      nodeBindings: raw.nodeBindings.map((b) => {
        if (b.useCase === null || !b.inherit) return { ...b, attachedNodeIds: undefined };
        const ids = attachedChildren(nodes, byId.get(b.tenantId)!, b.useCase);
        return ids.length > 0
          ? { ...b, attachedNodeIds: ids }
          : { ...b, attachedNodeIds: undefined };
      }),
    };
  }

  it("attaching C to u changes effective permissions only inside subtree(C), only for inheriting use-case holders on C's parent (seeds 1..200)", () => {
    let checked = 0;
    let changed = 0;
    for (const seed of SEEDS) {
      const r = rng(seed * 104729);
      const nodes: (Node & { useCase?: string | null })[] = forest(
        r,
        1 + r.int(2),
        8 + r.int(30),
      ).map((n) => ({ ...n, useCase: null }));
      const byId = new Map(nodes.map((n) => [n.id, n as Node]));
      // a few nodes start out attached
      for (const n of nodes) if (n.parentId && r.bool(0.2)) n.useCase = r.pick(USE_CASES);
      // several users with random use-case and plain bindings
      const home = r.pick(nodes);
      const users: RawGrants[] = Array.from({ length: 4 }, (_, i) =>
        rawOf(home, {
          userId: `user-${i}`,
          nodeBindings: Array.from({ length: 1 + r.int(5) }, () => {
            const at = r.pick(nodes.filter((n) => n.rootId === home.rootId));
            return grant(at.id, r.pick(ROLES.filter((x) => x !== 'pentest')), {
              useCase: r.bool(0.7) ? r.pick(USE_CASES) : null,
              inherit: r.bool(0.7),
            });
          }),
        }),
      );
      const candidates = nodes.filter((n) => n.parentId !== null);
      const target = r.pick(candidates);
      const parent = byId.get(target.parentId!)!;
      const newUseCase = r.pick(USE_CASES);
      const before = target.useCase ?? null;
      target.useCase = null; // baseline: detached
      const detached = users.map((u) => withAttachments(u, nodes, byId));
      target.useCase = newUseCase;
      const attached = users.map((u) => withAttachments(u, nodes, byId));
      target.useCase = before;
      for (let i = 0; i < users.length; i++) {
        for (const n of nodes) {
          const a = bindingFingerprint(effectiveAt(detached[i]!, n, { now: NOW }));
          const b = bindingFingerprint(effectiveAt(attached[i]!, n, { now: NOW }));
          checked++;
          const inside = n.path.startsWith(target.path);
          if (!inside) {
            expect(b, `seed ${seed} user ${i} node ${n.id} outside subtree(C)`).toEqual(a);
            continue;
          }
          if (JSON.stringify(a) === JSON.stringify(b)) continue;
          changed++;
          // Something changed inside subtree(C): the user must hold an inheriting use-case
          // binding on C's parent whose use case is u or an ancestor use case of u.
          const holder = users[i]!.nodeBindings.some(
            (bd) =>
              bd.tenantId === parent.id &&
              bd.useCase !== null &&
              bd.inherit &&
              (newUseCase === bd.useCase || newUseCase.startsWith(`${bd.useCase}/`)),
          );
          expect(holder, `seed ${seed} user ${i} node ${n.id}`).toBe(true);
          // And only ever more: attaching adds permissions, never removes one (monotone).
          const pa = new Set(permsOf(effectiveAt(detached[i]!, n, { now: NOW })));
          for (const p of permsOf(effectiveAt(attached[i]!, n, { now: NOW }))) pa.delete(p);
          expect([...pa], `seed ${seed} user ${i} node ${n.id} lost permissions`).toEqual([]);
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(changed).toBeGreaterThan(0);
  });

  it('detaching is the same statement in reverse: permissions never grow (seeds 1..200)', () => {
    for (const seed of SEEDS) {
      const r = rng(seed * 15485863);
      const nodes: (Node & { useCase?: string | null })[] = forest(r, 1, 6 + r.int(25)).map(
        (n) => ({
          ...n,
          useCase: null,
        }),
      );
      const byId = new Map(nodes.map((n) => [n.id, n as Node]));
      const root = nodes[0]!;
      const target = r.pick(nodes.filter((n) => n.parentId !== null));
      target.useCase = 'sec';
      const raw = rawOf(root, {
        nodeBindings: [
          grant(target.parentId!, 'admin', { useCase: 'sec', inherit: true }),
          grant(root.id, 'viewer', { inherit: true }),
        ],
      });
      const on = withAttachments(raw, nodes, byId);
      target.useCase = null;
      const off = withAttachments(raw, nodes, byId);
      for (const n of nodes) {
        const pOn = new Set(permsOf(effectiveAt(on, n, { now: NOW })));
        for (const p of permsOf(effectiveAt(off, n, { now: NOW }))) pOn.delete(p);
        // everything the detached state has, the attached state has too
        expect(
          permsOf(effectiveAt(off, n, { now: NOW })).every((p) =>
            permsOf(effectiveAt(on, n, { now: NOW })).includes(p),
          ),
        ).toBe(true);
      }
    }
  });
});
