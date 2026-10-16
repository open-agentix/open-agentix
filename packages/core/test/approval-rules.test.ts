import { describe, expect, it } from 'vitest';
import {
  REFUSAL_STATUS,
  checkApprover,
  collectContributors,
  declaredSecretReferences,
  requiredApprovals,
  reviewState,
  secretResolutionDigest,
  summariseDecisions,
  type ApprovalContext,
  type ApproverBinding,
  type ApproverFacts,
  type DecisionFact,
} from '../src/index.js';

const DEFAULT_POLICY: ApprovalContext['policy'] = {
  allowedApproverRoles: ['admin', 'agent-maintainer'],
  allowTokenApprovals: false,
  approverIdentitySources: ['local', 'oidc', 'ldap'],
  approverScope: 'tenant',
  minApprovals: 1,
};

const maintainer = (grantedBy: string | null = 'granter'): ApproverBinding => ({
  id: 'b-maintainer',
  role: 'agent-maintainer',
  source: 'grant',
  grantedBy,
});

const facts = (over: Partial<ApproverFacts> = {}): ApproverFacts => ({
  userId: 'reviewer',
  actor: 'user',
  auth: { kind: 'session' },
  identitySource: 'local',
  canRead: true,
  bindings: [maintainer()],
  inAgentTeam: true,
  ...over,
});

const ctx = (over: Partial<ApprovalContext> = {}): ApprovalContext => ({
  contributors: new Set(['author', 'opener']),
  policy: DEFAULT_POLICY,
  view: { expected: 'd1', current: 'd1' },
  ...over,
});

describe('checkApprover (rules A1 to A7 and A10)', () => {
  it('lets a distinct maintainer with a session approve and names the bindings used', () => {
    const r = checkApprover(facts(), ctx());
    expect(r).toEqual({ ok: true, via: [maintainer()] });
  });

  describe('A1: a contributor never approves', () => {
    const table: [string, Partial<ApproverFacts>][] = [
      ['author', { userId: 'author' }],
      ['co-author (any revision author)', { userId: 'author' }],
      ['opener', { userId: 'opener' }],
      [
        'admin author',
        {
          userId: 'author',
          bindings: [{ id: 'a', role: 'admin', source: 'mirror', grantedBy: null }],
        },
      ],
      [
        'platform admin author',
        {
          userId: 'author',
          bindings: [{ id: 'p', role: 'admin', source: 'platform', grantedBy: null }],
        },
      ],
      ['author with a token', { userId: 'author', auth: { kind: 'token', tokenId: 't' } }],
      ['author as a non-human actor', { userId: 'author', actor: 'repo' }],
    ];
    for (const [name, over] of table)
      it(`refuses ${name} with self_approval (also with tokens allowed)`, () => {
        for (const allowTokenApprovals of [false, true]) {
          const r = checkApprover(
            facts(over),
            ctx({ policy: { ...DEFAULT_POLICY, allowTokenApprovals } }),
          );
          expect(r).toMatchObject({ ok: false, code: 'self_approval' });
          expect(REFUSAL_STATUS.self_approval).toBe(403);
        }
      });

    it('is not configurable: no policy field can switch it off', () => {
      const r = checkApprover(
        facts({ userId: 'author' }),
        ctx({
          policy: {
            ...DEFAULT_POLICY,
            allowTokenApprovals: true,
            allowedApproverRoles: ['admin', 'agent-maintainer', 'agent-developer', 'operator'],
            approverScope: 'tenant',
          },
        }),
      );
      expect(r).toMatchObject({ ok: false, code: 'self_approval' });
    });
  });

  describe('A5: authentication', () => {
    it('refuses an API token unless the tenant allows it', () => {
      const f = facts({ auth: { kind: 'token', tokenId: 'tok' } });
      expect(checkApprover(f, ctx())).toMatchObject({ ok: false, code: 'token_approval_disabled' });
      expect(
        checkApprover(f, ctx({ policy: { ...DEFAULT_POLICY, allowTokenApprovals: true } })),
      ).toMatchObject({ ok: true });
    });
    for (const actor of ['repo', 'node', 'guest', 'system'] as const)
      it(`never lets the non-human actor "${actor}" decide`, () => {
        const c = ctx({ policy: { ...DEFAULT_POLICY, allowTokenApprovals: true } });
        expect(checkApprover(facts({ actor }), c)).toMatchObject({
          ok: false,
          code: 'actor_not_human',
        });
      });
    it('treats an unknown actor kind as non-human (fail closed)', () => {
      expect(checkApprover(facts({ actor: 'robot' as never }), ctx())).toMatchObject({
        ok: false,
        code: 'actor_not_human',
      });
    });
  });

  describe('A6: identity source', () => {
    it('refuses a local account when only directory sources are allowed', () => {
      const policy = { ...DEFAULT_POLICY, approverIdentitySources: ['oidc', 'ldap'] as const };
      expect(
        checkApprover(
          facts(),
          ctx({ policy: { ...policy, approverIdentitySources: ['oidc', 'ldap'] } }),
        ),
      ).toMatchObject({
        ok: false,
        code: 'identity_source_not_allowed',
      });
      expect(
        checkApprover(
          facts({ identitySource: 'oidc' }),
          ctx({ policy: { ...policy, approverIdentitySources: ['oidc', 'ldap'] } }),
        ),
      ).toMatchObject({ ok: true });
    });
    it('refuses an unknown identity source', () => {
      expect(checkApprover(facts({ identitySource: 'scim' }), ctx())).toMatchObject({
        ok: false,
        code: 'identity_source_not_allowed',
      });
    });
  });

  describe('A3: role and binding', () => {
    it('refuses a guest without bindings', () => {
      expect(checkApprover(facts({ bindings: [] }), ctx())).toMatchObject({
        ok: false,
        code: 'not_eligible',
      });
    });
    it('refuses a viewer-like binding that is not an approver role', () => {
      const b: ApproverBinding = { id: 'v', role: 'viewer', source: 'grant', grantedBy: null };
      expect(checkApprover(facts({ bindings: [b] }), ctx())).toMatchObject({
        ok: false,
        code: 'not_eligible',
      });
    });
    it('does not count a developer by default, and counts one when the tenant adds the role', () => {
      const dev: ApproverBinding = {
        id: 'd',
        role: 'agent-developer',
        source: 'grant',
        grantedBy: 'granter',
      };
      expect(checkApprover(facts({ bindings: [dev] }), ctx())).toMatchObject({
        ok: false,
        code: 'not_eligible',
      });
      const widened = {
        ...DEFAULT_POLICY,
        allowedApproverRoles: ['admin', 'agent-maintainer', 'agent-developer'] as const,
      };
      expect(
        checkApprover(
          facts({ bindings: [dev] }),
          ctx({
            policy: {
              ...widened,
              allowedApproverRoles: ['admin', 'agent-maintainer', 'agent-developer'],
            },
          }),
        ),
      ).toMatchObject({ ok: true });
    });
    it('counts a maintainer and an admin, whatever the source', () => {
      for (const source of ['mirror', 'grant', 'directory', 'team', 'agent', 'platform'] as const)
        for (const role of ['admin', 'agent-maintainer'] as const)
          expect(
            checkApprover(facts({ bindings: [{ id: 'x', role, source, grantedBy: null }] }), ctx()),
          ).toMatchObject({ ok: true });
    });
    it('refuses a reviewer who cannot read the agent (404, not 403)', () => {
      expect(checkApprover(facts({ canRead: false }), ctx())).toMatchObject({
        ok: false,
        code: 'cannot_read',
      });
      expect(REFUSAL_STATUS.cannot_read).toBe(404);
    });
  });

  describe('A4: bindings granted by a contributor', () => {
    it('refuses when the only qualifying binding was granted by the author', () => {
      expect(checkApprover(facts({ bindings: [maintainer('author')] }), ctx())).toMatchObject({
        ok: false,
        code: 'binding_granted_by_contributor',
      });
    });
    it('refuses when the only binding was granted by the opener', () => {
      expect(checkApprover(facts({ bindings: [maintainer('opener')] }), ctx())).toMatchObject({
        ok: false,
        code: 'binding_granted_by_contributor',
      });
    });
    it('refuses a directory binding whose mapping a contributor created', () => {
      const b: ApproverBinding = {
        id: 'm',
        role: 'agent-maintainer',
        source: 'directory',
        grantedBy: 'author',
      };
      expect(checkApprover(facts({ bindings: [b] }), ctx())).toMatchObject({
        ok: false,
        code: 'binding_granted_by_contributor',
      });
    });
    it('accepts a directory binding whose mapping a distinct person created, and counts the mapping creator as granter', () => {
      const b: ApproverBinding = {
        id: 'm',
        role: 'agent-maintainer',
        source: 'directory',
        grantedBy: 'someone',
      };
      expect(checkApprover(facts({ bindings: [b] }), ctx())).toMatchObject({ ok: true });
    });
    it('stays eligible through a second binding that no contributor granted, and reports only that one', () => {
      const clean: ApproverBinding = { id: 'c', role: 'admin', source: 'mirror', grantedBy: null };
      const r = checkApprover(facts({ bindings: [maintainer('author'), clean] }), ctx());
      expect(r).toEqual({ ok: true, via: [clean] });
    });
    it('has no minimum binding age: a fresh binding counts', () => {
      // The rule module has no clock at all.
      expect(checkApprover(facts(), ctx())).toMatchObject({ ok: true });
    });
    it('does not count a binding granted by a contributor to somebody else as a problem', () => {
      expect(checkApprover(facts({ bindings: [maintainer('granter')] }), ctx())).toMatchObject({
        ok: true,
      });
    });
  });

  describe('A7: approver scope', () => {
    const team = { ...DEFAULT_POLICY, approverScope: 'team' as const };
    const other = { ...DEFAULT_POLICY, approverScope: 'other-team' as const };
    it('team needs a member of the agent team', () => {
      expect(checkApprover(facts({ inAgentTeam: false }), ctx({ policy: team }))).toMatchObject({
        ok: false,
        code: 'approver_scope',
      });
      expect(checkApprover(facts({ inAgentTeam: true }), ctx({ policy: team }))).toMatchObject({
        ok: true,
      });
    });
    it('other-team needs somebody outside the agent team', () => {
      expect(checkApprover(facts({ inAgentTeam: true }), ctx({ policy: other }))).toMatchObject({
        ok: false,
        code: 'approver_scope',
      });
      expect(checkApprover(facts({ inAgentTeam: false }), ctx({ policy: other }))).toMatchObject({
        ok: true,
      });
    });
  });

  describe('A10: the reviewer saw the current revision', () => {
    it('refuses a stale view with 409', () => {
      const r = checkApprover(facts(), ctx({ view: { expected: 'old', current: 'new' } }));
      expect(r).toMatchObject({ ok: false, code: 'stale_view' });
      expect(REFUSAL_STATUS.stale_view).toBe(409);
    });
    it('tells an ineligible caller nothing about the digest: the eligibility refusal comes first', () => {
      const r = checkApprover(
        facts({ bindings: [] }),
        ctx({ view: { expected: 'old', current: 'new' } }),
      );
      expect(r).toMatchObject({ ok: false, code: 'not_eligible' });
      const own = checkApprover(
        facts({ userId: 'author' }),
        ctx({ view: { expected: 'old', current: 'new' } }),
      );
      expect(own).toMatchObject({ ok: false, code: 'self_approval' });
    });
  });
});

describe('collectContributors', () => {
  it('collects revision authors and the opener', () => {
    const c = collectContributors({
      revisionAuthors: [
        { authorId: 'a', authorKind: 'user' },
        { authorId: 'b', authorKind: 'user' },
      ],
      opener: 'o',
      unknownAuthorFallback: ['ignored'],
    });
    expect([...c].sort()).toEqual(['a', 'b', 'o']);
  });
  it('treats a system revision (unknown author) as every user who edited, and the creator', () => {
    const c = collectContributors({
      revisionAuthors: [{ authorId: null, authorKind: 'system' }],
      opener: 'o',
      unknownAuthorFallback: ['e1', 'e2'],
      agentCreator: 'creator',
    });
    expect([...c].sort()).toEqual(['creator', 'e1', 'e2', 'o']);
  });
  it('treats a repo revision without a linked user as unknown too, and adds linked signers', () => {
    const c = collectContributors({
      revisionAuthors: [{ authorId: null, authorKind: 'repo' }],
      opener: 'o',
      unknownAuthorFallback: ['e1'],
      linkedSigners: ['s1'],
    });
    expect([...c].sort()).toEqual(['e1', 'o', 's1']);
  });
});

const decision = (
  over: Partial<DecisionFact> & Pick<DecisionFact, 'id' | 'reviewerId'>,
): DecisionFact => ({
  decision: 'approve',
  revisionId: 'r2',
  decidedAt: new Date('2026-10-16T10:00:00Z'),
  expiresAt: new Date('2026-10-23T10:00:00Z'),
  ...over,
});

describe('summariseDecisions (A2) and reviewState (A8)', () => {
  const now = new Date('2026-10-16T12:00:00Z');
  it('counts one reviewer once, whatever the number of decisions', () => {
    const s = summariseDecisions(
      [
        decision({ id: '1', reviewerId: 'x' }),
        decision({ id: '2', reviewerId: 'x', decidedAt: new Date('2026-10-16T11:00:00Z') }),
      ],
      'r2',
      now,
    );
    expect(s.approvers).toEqual(['x']);
  });
  it('lets the latest decision of a reviewer win', () => {
    const s = summariseDecisions(
      [
        decision({ id: '1', reviewerId: 'x' }),
        decision({
          id: '2',
          reviewerId: 'x',
          decision: 'request_changes',
          expiresAt: null,
          decidedAt: new Date('2026-10-16T11:00:00Z'),
        }),
      ],
      'r2',
      now,
    );
    expect(s.approvers).toEqual([]);
    expect(s.changesRequested).toEqual(['x']);
    expect(reviewState(s, 1)).toBe('changes_requested');
  });
  it('lists an approval of an older revision as stale and does not count it', () => {
    const s = summariseDecisions(
      [decision({ id: '1', reviewerId: 'x', revisionId: 'r1' })],
      'r2',
      now,
    );
    expect(s.approvers).toEqual([]);
    expect(s.stale).toEqual([{ decisionId: '1', reviewerId: 'x', reason: 'revision_changed' }]);
    expect(reviewState(s, 1)).toBe('review_requested');
  });
  it('lists an expired approval as stale', () => {
    const s = summariseDecisions(
      [decision({ id: '1', reviewerId: 'x', expiresAt: new Date('2026-10-16T12:00:00Z') })],
      'r2',
      now,
    );
    expect(s.approvers).toEqual([]);
    expect(s.stale[0]?.reason).toBe('expired');
  });
  it('a change request on an older revision does not block', () => {
    const s = summariseDecisions(
      [
        decision({
          id: '1',
          reviewerId: 'x',
          revisionId: 'r1',
          decision: 'request_changes',
          expiresAt: null,
        }),
      ],
      'r2',
      now,
    );
    expect(s.changesRequested).toEqual([]);
  });
  it('is approved at the required number of distinct approvers', () => {
    const s = summariseDecisions(
      [decision({ id: '1', reviewerId: 'x' }), decision({ id: '2', reviewerId: 'y' })],
      'r2',
      now,
    );
    expect(reviewState(s, 2)).toBe('approved');
    expect(reviewState(s, 3)).toBe('review_requested');
  });
  it('requiredApprovals is the maximum of policy and rules, within 1 to 5', () => {
    expect(requiredApprovals(1)).toBe(1);
    expect(requiredApprovals(2, [3, 1])).toBe(3);
    expect(requiredApprovals(1, [9])).toBe(5);
    expect(requiredApprovals(0)).toBe(1);
    expect(requiredApprovals(Number.NaN)).toBe(1);
  });
});

describe('secret resolution digest', () => {
  it('is independent of order and duplicates, and differs for different references', () => {
    expect(secretResolutionDigest(['b', 'a', 'a'])).toBe(secretResolutionDigest(['a', 'b']));
    expect(secretResolutionDigest(['a'])).not.toBe(secretResolutionDigest(['b']));
    expect(secretResolutionDigest([])).toMatch(/^[0-9a-f]{64}$/);
  });
  it('cannot be confused with an adjacent list', () => {
    expect(secretResolutionDigest(['a,b'])).not.toBe(secretResolutionDigest(['a', 'b']));
  });
  it('reads the declared references from the steps', () => {
    expect(
      declaredSecretReferences({
        agents: [
          { credentials: [{ secret: 'x' }, { secret: 'y' }] },
          {},
          { credentials: [{ secret: 'x' }] },
        ],
      }),
    ).toEqual(['x', 'y']);
  });
});
