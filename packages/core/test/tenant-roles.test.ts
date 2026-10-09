import { describe, expect, it } from 'vitest';
import {
  GRANTABLE_ROLES,
  INHERITED_READ_ONLY,
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  bindingFingerprint,
  bindingPermissions,
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

  it('clamps inherited bindings to reads by default and only then', () => {
    const raw = rawOf(f.root, { nodeBindings: [grant(f.root.id, 'admin', { inherit: true })] });
    const clamped = effectiveAt(raw, f.a1, opts);
    expect(clamped).toHaveLength(1);
    expect(clamped[0]!.permissions.every((p) => INHERITED_READ_ONLY.includes(p))).toBe(true);
    expect(clamped[0]!.permissions).not.toContain('agents:write');
    expect(INHERITED_READ_ONLY).toContain('audit:verify');
    expect(INHERITED_READ_ONLY).not.toContain('audit:export');
    // The binding at the node itself is never clamped.
    expect(effectiveAt(raw, f.root, opts)[0]!.permissions).toEqual(ROLE_PERMISSIONS.admin);
    // Slice S5 switches the clamp off.
    expect(effectiveAt(raw, f.a1, { ...opts, clampInherited: false })[0]!.permissions).toEqual(
      ROLE_PERMISSIONS.admin,
    );
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

  it('fails closed: pentest without expiry, use-case bindings, unknown roles, bad nodes', () => {
    const bad = rawOf(f.a, {
      nodeBindings: [
        grant(f.a.id, 'pentest'),
        grant(f.a.id, 'admin', { useCase: 'security' }),
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
      const withR = { ...opts, restrictions: r, clampInherited: false };
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
): 'direct' | 'inherited' | null {
  if (b.useCase !== null) return null;
  if (b.role === 'pentest' && b.expiresAt === null) return null;
  if (b.expiresAt && b.expiresAt.getTime() <= now.getTime()) return null;
  if (target.rootId !== homeRoot) return null;
  if (b.tenantId === target.id) return 'direct';
  if (!b.inherit) return null;
  for (let cur = target.parentId ? byId.get(target.parentId) : undefined; cur;) {
    if (cur.id === b.tenantId) return 'inherited';
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
  clamp: boolean,
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
  const add = (role: Role, anchor: Node, source: string) => {
    const above = new Set(chainIds(anchor));
    for (const p of ROLE_PERMISSIONS[role]) {
      if (
        role !== 'admin' &&
        restrictions.some((r) => r.role === role && r.permission === p && above.has(r.tenantId))
      )
        continue;
      if (source === 'inherited' && clamp && !(p.endsWith(':read') || p === 'audit:verify'))
        continue;
      out.add(p);
    }
  };
  for (const b of raw.nodeBindings) {
    const how = naiveCovers(byId, b, target, raw.homeRootId, now);
    if (how) add(b.role, byId.get(b.tenantId)!, how);
  }
  if (target.rootId === raw.homeRootId) {
    for (const t of raw.teamBindings) if (t.tenantId === target.id) add(t.role, target, 'team');
    for (const a of raw.agentBindings) if (a.tenantId === target.id) add(a.role, target, 'agent');
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
    return grant(node().id, role, {
      inherit: r.bool(0.5),
      expiresAt: expires,
      useCase: r.bool(0.05) ? 'security' : null,
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
  return { r, nodes, byId, home, raw, restrictions, clamp: r.bool(0.7) };
}

const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);

describe('property: the resolver agrees with a naive parent-walking reference', () => {
  it('on random forests (seeds 1..200)', () => {
    for (const seed of SEEDS) {
      const c = randomCase(seed);
      for (const n of c.nodes) {
        const got = permsOf(
          effectiveAt(c.raw, n, {
            now: NOW,
            restrictions: c.restrictions,
            clampInherited: c.clamp,
          }),
        );
        const want = naivePermissions(c.byId, c.raw, n, NOW, c.restrictions, c.clamp);
        expect(got, `seed ${seed} node ${n.id}`).toEqual(want);
      }
    }
  });
});

describe('property: nothing flows up, sideways or across organisations', () => {
  it('only bindings on the chain of the node contribute (seeds 1..200)', () => {
    for (const seed of SEEDS) {
      const c = randomCase(seed);
      const o = { now: NOW, restrictions: c.restrictions, clampInherited: c.clamp };
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
        const out = effectiveAt(raw, n, { now: NOW, clampInherited: false });
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

describe('property: monotonicity, expiry, platform admin, clamp', () => {
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
      const o = { now: NOW, restrictions: c.restrictions, clampInherited: c.clamp };
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
        const o = { now: NOW, clampInherited: false };
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

  it('with the clamp on, inherited bindings yield reads only (seeds 1..200)', () => {
    for (const seed of SEEDS) {
      const c = randomCase(seed);
      for (const n of c.nodes)
        for (const b of effectiveAt(c.raw, n, { now: NOW, restrictions: c.restrictions }))
          if (b.source === 'inherited')
            for (const p of b.permissions)
              expect(p === 'audit:verify' || p.endsWith(':read'), `seed ${seed} ${p}`).toBe(true);
    }
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
