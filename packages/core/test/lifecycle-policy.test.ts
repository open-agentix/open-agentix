import { describe, expect, it } from 'vitest';
import {
  LIFECYCLE_KEYS,
  lifecycleDefaults,
  lifecyclePolicyDigest,
  parseLifecycleInput,
  proposeLifecyclePolicy,
  resolveLifecyclePolicy,
  wideningKeys,
  changedKeys,
  isProductionUseCase,
  type LifecyclePolicy,
  type LifecyclePolicyInput,
} from '../src/index.js';

const DEFAULTS = lifecycleDefaults({ requireApprovalForPublish: 'on' });

/** The effective policy of a child below a parent that stored `parent`. */
const below = (parent: LifecyclePolicyInput, child: LifecyclePolicyInput | undefined) =>
  resolveLifecyclePolicy(DEFAULTS, [parent, child]);

/** Whether storing `child` below `parentOwn` is narrowing. */
const narrowing = (parentOwn: LifecyclePolicyInput, child: LifecyclePolicyInput) => {
  const parentEff = resolveLifecyclePolicy(DEFAULTS, [parentOwn]);
  return wideningKeys(parentEff, proposeLifecyclePolicy(parentEff, child));
};

describe('defaults (ADR 0017 section 6)', () => {
  it('match the decided values', () => {
    expect(DEFAULTS).toMatchObject({
      selfApproval: 'never',
      minApprovals: 1,
      allowedApproverRoles: ['admin', 'agent-maintainer'],
      approverScope: 'tenant',
      approvalExpiryHours: 168,
      allowTokenApprovals: false,
      approverIdentitySources: ['local', 'oidc', 'ldap'],
      publishBy: 'any-publisher',
      allowDraftRuns: 'development-credentials',
      allowPersonalSecretsInDevRuns: true,
      allowPersonalSecretsInPublishedAgents: 'never',
      allowProductionSecretsInDraftRuns: false,
      gitUnsignedContributors: 'refuse',
      productionUseCases: [],
    });
  });
  it('contain neither break-glass keys nor a binding age', () => {
    expect(Object.keys(DEFAULTS).some((k) => k.startsWith('breakGlass'))).toBe(false);
    expect(Object.keys(DEFAULTS)).not.toContain('approverBindingMinAgeHours');
    expect(LIFECYCLE_KEYS).toHaveLength(15);
  });
});

describe('input validation', () => {
  it('refuses removed and unknown keys by name', () => {
    for (const key of [
      'breakGlass',
      'breakGlassRatifyHours',
      'approverBindingMinAgeHours',
      'pathRules',
      'x',
    ]) {
      const r = parseLifecycleInput({ [key]: true });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues[0]?.message).toContain(`"${key}"`);
    }
  });
  it('refuses values outside the domain', () => {
    const bad: Record<string, unknown>[] = [
      { minApprovals: 0 },
      { minApprovals: 6 },
      { minApprovals: 1.5 },
      { approvalExpiryHours: 0 },
      { approvalExpiryHours: 721 },
      { allowedApproverRoles: [] },
      { allowedApproverRoles: ['viewer'] },
      { allowedApproverRoles: ['admin', 'admin'] },
      { approverIdentitySources: [] },
      { approverIdentitySources: ['scim'] },
      { approverScope: 'everyone' },
      { selfApproval: 'always' },
      { allowTokenApprovals: 'yes' },
      { productionUseCases: ['bad glob!'] },
      { productionUseCases: Array.from({ length: 51 }, (_, i) => `a${i}`) },
      { requireApprovalForPublish: 'sometimes' },
    ];
    for (const b of bad) expect(parseLifecycleInput(b).ok, JSON.stringify(b)).toBe(false);
  });
  it('accepts a full valid object and drops undefined', () => {
    const r = parseLifecycleInput({
      minApprovals: 2,
      productionUseCases: ['prod/**', 'support-*'],
    });
    expect(r).toEqual({
      ok: true,
      value: { minApprovals: 2, productionUseCases: ['prod/**', 'support-*'] },
    });
  });
  it('refuses a non-object', () => {
    expect(parseLifecycleInput('x').ok).toBe(false);
    expect(parseLifecycleInput(null).ok).toBe(false);
    expect(parseLifecycleInput([]).ok).toBe(false);
  });
});

describe('the root chooses freely, descendants only narrow', () => {
  it('lets the root of an organisation widen the installation default', () => {
    const eff = resolveLifecyclePolicy(DEFAULTS, [
      {
        allowedApproverRoles: ['admin', 'agent-maintainer', 'agent-developer'],
        allowTokenApprovals: true,
      },
    ]);
    expect(eff.allowedApproverRoles).toEqual(['admin', 'agent-maintainer', 'agent-developer']);
    expect(eff.allowTokenApprovals).toBe(true);
  });

  // One row per key: a narrowing write, a widening write, and what a stored widening resolves to.
  const table: {
    key: keyof LifecyclePolicy;
    parent: LifecyclePolicyInput;
    ok: LifecyclePolicyInput;
    widens: LifecyclePolicyInput;
    clamped: unknown;
  }[] = [
    {
      key: 'requireApprovalForPublish',
      parent: { requireApprovalForPublish: 'production-only' },
      ok: { requireApprovalForPublish: 'on' },
      widens: { requireApprovalForPublish: 'off' },
      clamped: 'production-only',
    },
    {
      key: 'minApprovals',
      parent: { minApprovals: 2 },
      ok: { minApprovals: 3 },
      widens: { minApprovals: 1 },
      clamped: 2,
    },
    {
      key: 'allowedApproverRoles',
      parent: { allowedApproverRoles: ['admin', 'agent-maintainer', 'operator'] },
      ok: { allowedApproverRoles: ['agent-maintainer'] },
      widens: { allowedApproverRoles: ['agent-maintainer', 'agent-developer'] },
      clamped: ['agent-maintainer'],
    },
    {
      key: 'approverScope',
      parent: { approverScope: 'other-team' },
      ok: { approverScope: 'other-team' },
      widens: { approverScope: 'tenant' },
      clamped: 'other-team',
    },
    {
      key: 'approvalExpiryHours',
      parent: { approvalExpiryHours: 48 },
      ok: { approvalExpiryHours: 24 },
      widens: { approvalExpiryHours: 72 },
      clamped: 48,
    },
    {
      key: 'allowTokenApprovals',
      parent: { allowTokenApprovals: false },
      ok: { allowTokenApprovals: false },
      widens: { allowTokenApprovals: true },
      clamped: false,
    },
    {
      key: 'approverIdentitySources',
      parent: { approverIdentitySources: ['oidc', 'ldap'] },
      ok: { approverIdentitySources: ['oidc'] },
      widens: { approverIdentitySources: ['oidc', 'local'] },
      clamped: ['oidc'],
    },
    {
      key: 'publishBy',
      parent: { publishBy: 'approver-only' },
      ok: { publishBy: 'approver-only' },
      widens: { publishBy: 'any-publisher' },
      clamped: 'approver-only',
    },
    {
      key: 'allowDraftRuns',
      parent: { allowDraftRuns: 'development-credentials' },
      ok: { allowDraftRuns: 'off' },
      widens: { allowDraftRuns: 'on' },
      clamped: 'development-credentials',
    },
    {
      key: 'allowPersonalSecretsInDevRuns',
      parent: { allowPersonalSecretsInDevRuns: false },
      ok: { allowPersonalSecretsInDevRuns: false },
      widens: { allowPersonalSecretsInDevRuns: true },
      clamped: false,
    },
    {
      key: 'allowPersonalSecretsInPublishedAgents',
      parent: { allowPersonalSecretsInPublishedAgents: 'never' },
      ok: { allowPersonalSecretsInPublishedAgents: 'never' },
      widens: { allowPersonalSecretsInPublishedAgents: 'with-approval' },
      clamped: 'never',
    },
    {
      key: 'allowProductionSecretsInDraftRuns',
      parent: { allowProductionSecretsInDraftRuns: false },
      ok: { allowProductionSecretsInDraftRuns: false },
      widens: { allowProductionSecretsInDraftRuns: true },
      clamped: false,
    },
    {
      key: 'gitUnsignedContributors',
      parent: { gitUnsignedContributors: 'refuse' },
      ok: { gitUnsignedContributors: 'refuse' },
      widens: { gitUnsignedContributors: 'declared-non-production' },
      clamped: 'refuse',
    },
  ];
  for (const row of table) {
    it(`${row.key}: narrowing is accepted, widening is refused and clamped`, () => {
      expect(narrowing(row.parent, row.ok)).toEqual([]);
      expect(narrowing(row.parent, row.widens)).toEqual([row.key]);
      // A stored widening (the parent tightened later, or a hand-edited row) never takes effect.
      expect(below(row.parent, row.widens)[row.key]).toEqual(row.clamped);
    });
  }

  it('allowedApproverRoles never ends empty: a disjoint child falls back to the parent', () => {
    const eff = below(
      { allowedApproverRoles: ['agent-maintainer'] },
      { allowedApproverRoles: ['operator'] },
    );
    expect(eff.allowedApproverRoles).toEqual(['agent-maintainer']);
  });
  it('productionUseCases adds up along the chain and can never be shortened', () => {
    const eff = below({ productionUseCases: ['prod/**'] }, { productionUseCases: ['support-*'] });
    expect(eff.productionUseCases).toEqual(['prod/**', 'support-*']);
    const dropped = below({ productionUseCases: ['prod/**'] }, { productionUseCases: [] });
    expect(dropped.productionUseCases).toEqual(['prod/**']);
    expect(narrowing({ productionUseCases: ['prod/**'] }, { productionUseCases: [] })).toEqual([]);
  });
  it('selfApproval is fixed', () => {
    expect(below({}, {}).selfApproval).toBe('never');
  });
  it('a child with no values inherits the parent effective policy', () => {
    const parent: LifecyclePolicyInput = { minApprovals: 3, publishBy: 'approver-only' };
    expect(below(parent, undefined)).toEqual(resolveLifecyclePolicy(DEFAULTS, [parent]));
  });
  it('narrowing holds for a deep chain, whatever the middle nodes store', () => {
    const chain: LifecyclePolicyInput[] = [
      { minApprovals: 2, allowTokenApprovals: true },
      { allowTokenApprovals: false },
      { allowTokenApprovals: true, minApprovals: 1 },
      {},
    ];
    const eff = resolveLifecyclePolicy(DEFAULTS, chain);
    expect(eff.allowTokenApprovals).toBe(false);
    expect(eff.minApprovals).toBe(2);
  });
  it('changedKeys lists the keys that differ', () => {
    const a = resolveLifecyclePolicy(DEFAULTS, [{ minApprovals: 2 }]);
    expect(changedKeys(DEFAULTS, a)).toEqual(['minApprovals']);
  });
});

describe('policy digest', () => {
  it('is stable across key order and set order', () => {
    const a: LifecyclePolicy = { ...DEFAULTS, allowedApproverRoles: ['agent-maintainer', 'admin'] };
    const b: LifecyclePolicy = { ...DEFAULTS, allowedApproverRoles: ['admin', 'agent-maintainer'] };
    const reordered = Object.fromEntries(Object.entries(b).reverse()) as unknown as LifecyclePolicy;
    expect(lifecyclePolicyDigest(a)).toBe(lifecyclePolicyDigest(b));
    expect(lifecyclePolicyDigest(reordered)).toBe(lifecyclePolicyDigest(b));
  });
  it('changes with every key', () => {
    const base = lifecyclePolicyDigest(DEFAULTS);
    const variants: LifecyclePolicyInput[] = [
      { requireApprovalForPublish: 'off' },
      { minApprovals: 2 },
      { allowedApproverRoles: ['admin'] },
      { approverScope: 'team' },
      { approvalExpiryHours: 24 },
      { allowTokenApprovals: true },
      { approverIdentitySources: ['oidc'] },
      { publishBy: 'approver-only' },
      { allowDraftRuns: 'off' },
      { allowPersonalSecretsInDevRuns: false },
      { allowPersonalSecretsInPublishedAgents: 'with-approval' },
      { allowProductionSecretsInDraftRuns: true },
      { gitUnsignedContributors: 'declared-non-production' },
      { productionUseCases: ['x'] },
    ];
    const seen = new Set([base]);
    for (const v of variants) {
      const d = lifecyclePolicyDigest(proposeLifecyclePolicy(DEFAULTS, v));
      expect(seen.has(d), JSON.stringify(v)).toBe(false);
      seen.add(d);
    }
  });
  it('includes the rules and is independent of their order', () => {
    const r1 = { name: 'a', minApprovals: 2 };
    const r2 = { name: 'b', minApprovals: 3 };
    expect(lifecyclePolicyDigest(DEFAULTS, [r1, r2])).toBe(
      lifecyclePolicyDigest(DEFAULTS, [r2, r1]),
    );
    expect(lifecyclePolicyDigest(DEFAULTS, [r1])).not.toBe(lifecyclePolicyDigest(DEFAULTS));
  });
  it('cannot collide with a differently split input', () => {
    const a = lifecyclePolicyDigest(
      proposeLifecyclePolicy(DEFAULTS, { productionUseCases: ['a,b'] }),
    );
    const b = lifecyclePolicyDigest(
      proposeLifecyclePolicy(DEFAULTS, { productionUseCases: ['a', 'b'] }),
    );
    expect(a).not.toBe(b);
  });
});

describe('isProductionUseCase', () => {
  it('matches globs per segment and across segments', () => {
    expect(isProductionUseCase('prod/support', ['prod/**'])).toBe(true);
    expect(isProductionUseCase('prod', ['prod/**'])).toBe(true);
    expect(isProductionUseCase('prod/a/b', ['prod/*'])).toBe(false);
    expect(isProductionUseCase('prod/a', ['prod/*'])).toBe(true);
    expect(isProductionUseCase('support-x', ['support-*'])).toBe(true);
    expect(isProductionUseCase('prodx', ['prod/**'])).toBe(false);
    expect(isProductionUseCase('a.b', ['a.b'])).toBe(true);
    expect(isProductionUseCase('axb', ['a.b'])).toBe(false);
    expect(isProductionUseCase('ab', ['a?'])).toBe(true);
  });
  it('never covers a missing use case or an empty list', () => {
    expect(isProductionUseCase(null, ['**'])).toBe(false);
    expect(isProductionUseCase('x', [])).toBe(false);
  });
});
