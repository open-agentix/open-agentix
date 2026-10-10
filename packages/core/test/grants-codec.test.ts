import { describe, expect, it } from 'vitest';
import {
  GRANTS_WIRE_VERSION,
  dateFromWire,
  dateToWire,
  effectiveAt,
  reviveGrants,
  serializeGrants,
  type GrantsAndHome,
  type NodeRoleGrant,
  type Role,
} from '../src/index.js';

/**
 * ADR 0014 section 6.2 (#217): raw grants are cached as JSON. A `Date` does not survive a JSON
 * round trip, so the cache form carries canonical ISO strings that are parsed back strictly.
 */
const ROOT = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-10T12:00:00.000Z');
const ahead = (ms: number) => new Date(NOW.getTime() + ms);

const grant = (role: Role, over: Partial<NodeRoleGrant> = {}): NodeRoleGrant => ({
  tenantId: CHILD,
  role,
  useCase: null,
  inherit: false,
  expiresAt: null,
  ...over,
});

const loaded = (nodeBindings: NodeRoleGrant[]): GrantsAndHome => ({
  raw: {
    userId: 'u1',
    homeTenantId: CHILD,
    homeRootId: ROOT,
    platformAdmin: false,
    nodeBindings,
    teamBindings: [{ tenantId: CHILD, teamId: 't1', role: 'operator' }],
    agentBindings: [{ tenantId: CHILD, agentId: 'a1', teamId: null, role: 'viewer' }],
  },
  home: { id: CHILD, rootId: ROOT, path: `/${ROOT}/${CHILD}/` },
});

/** What a Valkey cache does to a value. */
const viaJson = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

const rolesAt = (g: GrantsAndHome, now: Date) =>
  effectiveAt(g.raw, g.home, { now, implicitPlatformAdmin: false })
    .map((b) => b.role)
    .sort();

describe('raw grants cache representation', () => {
  it('the plain JSON round trip of the raw grants loses every expiring binding (the bug)', () => {
    // This is the failure the codec exists to prevent: documented as a test so it stays visible.
    const g = loaded([grant('pentest', { expiresAt: ahead(3_600_000) })]);
    const naive = viaJson(g) as GrantsAndHome;
    expect(typeof naive.raw.nodeBindings[0]!.expiresAt).toBe('string');
    expect(rolesAt(naive, NOW)).not.toContain('pentest'); // fail closed: the binding silently disappeared
    expect(rolesAt(g, NOW)).toContain('pentest');
  });

  it('round-trips through JSON: dates are real again, the binding applies until expiry', () => {
    const g = loaded([
      grant('pentest', { expiresAt: ahead(3_600_000) }),
      grant('viewer'),
      grant('auditor', { inherit: true, expiresAt: ahead(1_000) }),
    ]);
    const back = reviveGrants(viaJson(serializeGrants(g)));
    expect(back).toBeDefined();
    for (const b of back!.raw.nodeBindings)
      expect(b.expiresAt === null || b.expiresAt instanceof Date).toBe(true);
    expect(back).toEqual(g);
    // equal resolution before, at and after the expiry
    for (const t of [NOW, ahead(999), ahead(1_000), ahead(3_599_999), ahead(3_600_000), ahead(9e9)])
      expect(rolesAt(back!, t)).toEqual(rolesAt(g, t));
    expect(rolesAt(back!, NOW)).toContain('pentest');
    expect(rolesAt(back!, ahead(3_600_000))).not.toContain('pentest'); // expired exactly at the instant
    expect(rolesAt(back!, ahead(3_599_999))).toContain('pentest');
  });

  it('keeps team and agent grants and the home node, and is versioned', () => {
    const w = serializeGrants(loaded([grant('viewer')]));
    expect(w.v).toBe(GRANTS_WIRE_VERSION);
    const back = reviveGrants(viaJson(w))!;
    expect(back.raw.teamBindings).toHaveLength(1);
    expect(back.raw.agentBindings).toHaveLength(1);
    expect(back.home.path).toBe(`/${ROOT}/${CHILD}/`);
  });

  it('does not write a binding whose expiry is not a valid Date', () => {
    const w = serializeGrants(
      loaded([grant('viewer', { expiresAt: new Date('nope') }), grant('auditor')]),
    );
    expect(w.raw.nodeBindings.map((b) => b.role)).toEqual(['auditor']);
    expect(JSON.stringify(w)).not.toContain('Invalid');
  });

  describe('strict parsing, invalid is fail closed (whole entry unusable)', () => {
    const good = () =>
      viaJson(serializeGrants(loaded([grant('viewer', { expiresAt: ahead(5) })]))) as {
        v: number;
        raw: { nodeBindings: Record<string, unknown>[] } & Record<string, unknown>;
        home: Record<string, unknown>;
      };
    const mutate = (f: (w: ReturnType<typeof good>) => void) => {
      const w = good();
      f(w);
      return reviveGrants(w);
    };

    it('accepts the untouched value (control)', () => {
      expect(reviveGrants(good())).toBeDefined();
    });

    it.each([
      ['unknown version', (w: ReturnType<typeof good>) => (w.v = 2)],
      ['missing version', (w: ReturnType<typeof good>) => delete (w as { v?: number }).v],
      [
        'date as epoch number',
        (w: ReturnType<typeof good>) => (w.raw.nodeBindings[0]!.expiresAt = 1_791_000_000_000),
      ],
      [
        'date without millis',
        (w: ReturnType<typeof good>) => (w.raw.nodeBindings[0]!.expiresAt = '2026-10-10T12:00:05Z'),
      ],
      [
        'date with an offset',
        (w: ReturnType<typeof good>) =>
          (w.raw.nodeBindings[0]!.expiresAt = '2026-10-10T14:00:00.005+02:00'),
      ],
      [
        'date with trailing text',
        (w: ReturnType<typeof good>) =>
          (w.raw.nodeBindings[0]!.expiresAt = '2026-10-10T12:00:00.005Zjunk'),
      ],
      [
        'impossible date',
        (w: ReturnType<typeof good>) =>
          (w.raw.nodeBindings[0]!.expiresAt = '2026-02-31T12:00:00.000Z'),
      ],
      [
        '"Invalid Date"',
        (w: ReturnType<typeof good>) => (w.raw.nodeBindings[0]!.expiresAt = 'Invalid Date'),
      ],
      [
        'empty date string',
        (w: ReturnType<typeof good>) => (w.raw.nodeBindings[0]!.expiresAt = ''),
      ],
      ['undefined expiry', (w: ReturnType<typeof good>) => delete w.raw.nodeBindings[0]!.expiresAt],
      ['unknown role', (w: ReturnType<typeof good>) => (w.raw.nodeBindings[0]!.role = 'root')],
      [
        'inherit as string',
        (w: ReturnType<typeof good>) => (w.raw.nodeBindings[0]!.inherit = 'true'),
      ],
      ['missing inherit', (w: ReturnType<typeof good>) => delete w.raw.nodeBindings[0]!.inherit],
      ['empty use case', (w: ReturnType<typeof good>) => (w.raw.nodeBindings[0]!.useCase = '')],
      [
        'bindings not an array',
        (w: ReturnType<typeof good>) => ((w.raw as Record<string, unknown>).nodeBindings = {}),
      ],
      [
        'platformAdmin as string',
        (w: ReturnType<typeof good>) =>
          ((w.raw as Record<string, unknown>).platformAdmin = 'false'),
      ],
      ['bad home path', (w: ReturnType<typeof good>) => (w.home.path = 'not-a-path')],
      ['missing home', (w: ReturnType<typeof good>) => delete (w as { home?: unknown }).home],
    ])('%s', (_name, f) => {
      expect(mutate(f)).toBeUndefined();
    });

    it.each([null, undefined, 'x', 7, [], {}, { v: 1 }])('rejects %j', (v) => {
      expect(reviveGrants(v)).toBeUndefined();
    });

    it('one bad binding poisons the entry: nothing partial is ever returned', () => {
      const w = good();
      w.raw.nodeBindings.push({ ...w.raw.nodeBindings[0]!, expiresAt: 'garbage' });
      expect(reviveGrants(w)).toBeUndefined();
    });
  });

  describe('an entry belongs to exactly one user and home node', () => {
    const OTHER = '33333333-3333-4333-8333-333333333333';
    const w = () =>
      viaJson(serializeGrants(loaded([grant('admin')]))) as {
        raw: Record<string, unknown>;
        home: Record<string, unknown>;
      };

    it('is accepted for its owner, and refused for any other user or home tenant', () => {
      expect(reviveGrants(w(), { userId: 'u1' })).toBeDefined();
      expect(reviveGrants(w(), { userId: 'u1', homeTenantId: CHILD })).toBeDefined();
      expect(reviveGrants(w(), { userId: 'u2' })).toBeUndefined();
      expect(reviveGrants(w(), { userId: 'u1', homeTenantId: OTHER })).toBeUndefined();
    });

    it.each([
      ['home node is not homeTenantId', (v: ReturnType<typeof w>) => (v.raw.homeTenantId = OTHER)],
      ['home root is not homeRootId', (v: ReturnType<typeof w>) => (v.raw.homeRootId = OTHER)],
      [
        'path ends at another node',
        (v: ReturnType<typeof w>) => (v.home.path = `/${ROOT}/${OTHER}/`),
      ],
      [
        'path starts at another root',
        (v: ReturnType<typeof w>) => (v.home.path = `/${OTHER}/${CHILD}/`),
      ],
    ])('an inconsistent entry is a miss: %s', (_name, f) => {
      const v = w();
      f(v);
      expect(reviveGrants(v)).toBeUndefined();
    });

    it('JSON "__proto__" keys neither pollute prototypes nor fill missing fields', () => {
      const v = w();
      delete v.raw.platformAdmin;
      const text = JSON.stringify(v).replace(
        '"raw":{',
        '"raw":{"__proto__":{"platformAdmin":true},',
      );
      expect(reviveGrants(JSON.parse(text))).toBeUndefined();
      const ok = JSON.stringify(w()).replace('"raw":{', '"raw":{"__proto__":{"isAdmin":true},');
      const back = reviveGrants(JSON.parse(ok));
      expect(back).toBeDefined();
      expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
      expect(Object.keys(back!.raw)).not.toContain('__proto__');
    });
  });

  describe('date helpers', () => {
    it('round-trip expiries outside the four-digit years (toISOString writes them signed)', () => {
      for (const d of [
        new Date('+010000-01-01T00:00:00.000Z'),
        new Date('+275760-09-13T00:00:00.000Z'),
        new Date('0000-01-01T00:00:00.000Z'),
        new Date('9999-12-31T23:59:59.999Z'),
      ]) {
        const s = dateToWire(d)!;
        expect(dateFromWire(s)).toEqual(d);
      }
      const far = loaded([
        grant('auditor', { expiresAt: new Date('+010000-01-01T00:00:00.000Z') }),
      ]);
      const back = reviveGrants(viaJson(serializeGrants(far)));
      expect(back).toEqual(far); // the user stays cacheable and keeps the binding
      expect(rolesAt(back!, NOW)).toContain('auditor');
    });

    it('refuses leap seconds, a signed "-000000" year and non-canonical signed years', () => {
      for (const s of [
        '2026-12-31T23:59:60.000Z',
        '-000000-01-01T00:00:00.000Z',
        '+002026-10-10T12:00:00.000Z', // a four-digit year written in the long form
        '10000-01-01T00:00:00.000Z',
      ])
        expect(dateFromWire(s)).toBeUndefined();
    });

    it('are strict inverses', () => {
      const d = new Date('2026-10-10T12:00:00.123Z');
      expect(dateFromWire(dateToWire(d))).toEqual(d);
      expect(dateToWire(new Date(NaN))).toBeUndefined();
      expect(dateFromWire(undefined)).toBeUndefined();
      expect(dateFromWire(d)).toBeUndefined(); // a Date object is not a wire string
    });
  });
});
