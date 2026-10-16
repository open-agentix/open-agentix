import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  agentDraftRevisions,
  agents,
  teamMembers,
  tenantRoleBindings,
  users,
} from '../src/db/schema.js';
import { followGrantChain } from '../src/services/approver-facts.js';
import { sourceDigest } from '../src/services/agent-revisions.js';
import { mirrorGlobalRoles, reconcileUserBindings } from '../src/services/role-bindings.js';
import { agentSource } from './fixtures.js';
import { PG_URL, openPglite, openPostgres, type Sql } from './db-targets.js';
import { testNode, type TestNode } from './helpers.js';

/**
 * Blockers 1 to 5 and follow-ups 6 and 8 of the S1 review of ADR 0017 (#343), over HTTP: the grant
 * chain of rule A4, the policy an open review is judged by, the digests an approval must carry, the
 * head revision of a diverged draft, unknown versus absent grantors, non-user authors and the
 * withdraw check. Runs on PGlite and, with OAX_TEST_DATABASE_URL, on a real PostgreSQL.
 */
const PW = 'long-password-123';
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let n: TestNode;
let db: Sql;
let adminA: string; // organisation administrator, never a contributor in these tests
let orgA: string;
const uid: Record<string, string> = {};
const tok: Record<string, string> = {};
let seq = 0;

const req = (
  token: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
) =>
  n.req({ method, url, token, ...(payload === undefined ? {} : { payload: payload as object }) });
const j = (res: { json: () => unknown }) => res.json() as Json;

async function mkUser(key: string, globalRoles: string[], by = adminA) {
  const res = await req(by, 'POST', '/v1/users', {
    email: `${key}@org-a.example.org`,
    displayName: key,
    password: PW,
    globalRoles,
  });
  expect(res.statusCode, res.body).toBe(201);
  uid[key] = j(res).id;
  tok[key] = await n.login(`${key}@org-a.example.org`, PW);
}
async function newAgent(by: string, extra = '') {
  const name = `blk-agent-${++seq}`;
  const res = await req(by, 'POST', '/v1/agents', {
    source: agentSource(name, 'nobody', '1.0.0', extra),
  });
  expect(res.statusCode, res.body).toBe(201);
  return { id: j(res).id as string, name };
}
const open = async (by: string, agentId: string) => {
  const res = await req(by, 'POST', `/v1/agents/${agentId}/reviews`);
  expect(res.statusCode, res.body).toBe(201);
  return j(res);
};
const bound = (review: Json) => ({
  expectedDigest: review.revision.digest,
  expectedExpansionDigest: review.digests.expansionDigest,
  expectedResolutionDigest: review.digests.resolutionDigest,
  expectedPolicyDigest: review.digests.policyDigest,
});
const decide = (by: string, review: Json, decision = 'approve', extra: Json = {}) =>
  req(by, 'POST', `/v1/reviews/${review.id}/decisions`, {
    decision,
    ...bound(review),
    ...(decision === 'approve' ? {} : { comment: 'because' }),
    ...extra,
  });
const getReview = async (by: string, id: string) => j(await req(by, 'GET', `/v1/reviews/${id}`));
const setPolicy = async (patch: Json, by = adminA) =>
  req(by, 'PATCH', `/v1/tenants/${orgA}/settings/agent-lifecycle`, patch);
const resetPolicy = async () => {
  const res = await setPolicy({
    requireApprovalForPublish: 'on',
    minApprovals: 1,
    allowedApproverRoles: ['admin', 'agent-maintainer'],
  });
  expect(res.statusCode, res.body).toBe(200);
};

beforeAll(async () => {
  db = PG_URL ? await openPostgres() : await openPglite();
  n = await testNode({
    OAX_DATABASE_URL: db.url,
    OAX_LIFECYCLE_REQUIRE_APPROVAL: 'on',
    OAX_ROLE_BINDINGS_READ: 'bindings',
    OAX_RATE_LIMIT_LOGIN_MAX: '1000',
  });
  const r = await n.req({
    method: 'POST',
    url: '/v1/tenants',
    payload: {
      slug: 'org-a',
      name: 'org-a',
      admin: { email: 'admin@org-a.example.org', displayName: 'Admin', password: PW },
    },
  });
  expect(r.statusCode, r.body).toBe(201);
  orgA = j(r).id;
  adminA = await n.login('admin@org-a.example.org', PW);
  await mkUser('author', ['agent-maintainer']);
  await mkUser('rev1', ['agent-maintainer']);
  await mkUser('rev2', ['agent-maintainer']);
  await mkUser('oper', ['operator']);
  await mkUser('admin2', ['admin']);
}, 120_000);
afterAll(async () => {
  await n?.close();
  await db?.close();
});

describe('finding 1: the grant chain of rule A4', () => {
  it('refuses an approver made through a second administrator account of a contributor (two-step laundering)', async () => {
    // C (admin2) creates account D with the admin role; as D, C creates X as a maintainer. X is
    // granted by D and created by D, and neither D nor X ever touched the draft.
    const dRes = await req(tok['admin2']!, 'POST', '/v1/users', {
      email: 'laundry-d@org-a.example.org',
      displayName: 'D',
      password: PW,
      globalRoles: ['admin'],
    });
    expect(dRes.statusCode, dRes.body).toBe(201);
    const dTok = await n.login('laundry-d@org-a.example.org', PW);
    const xRes = await req(dTok, 'POST', '/v1/users', {
      email: 'laundry-x@org-a.example.org',
      displayName: 'X',
      password: PW,
      globalRoles: ['agent-maintainer'],
    });
    expect(xRes.statusCode, xRes.body).toBe(201);
    const xTok = await n.login('laundry-x@org-a.example.org', PW);

    const a = await newAgent(tok['admin2']!); // C is a contributor
    const review = await open(tok['admin2']!, a.id);
    expect(review.contributors).not.toContain(j(dRes).id);
    expect(review.contributors).not.toContain(j(xRes).id);
    const res = await decide(xTok, review);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error).toBe('binding_granted_by_contributor');

    // the same account may approve work that neither C nor D touched
    const other = await newAgent(tok['author']!);
    const r2 = await open(tok['author']!, other.id);
    const ok = await decide(xTok, r2);
    expect(ok.statusCode, ok.body).toBe(201);
  });

  it('follows the chain through the roles that let the grantor grant, when every account was made by a clean administrator', async () => {
    // X and D are both made by the clean administrator without roles. The contributor C then grants
    // D the admin role through the role-binding API, and D grants X the maintainer role. Neither
    // created_by nor the direct grantor reaches C: only the walk over D's own admin binding does.
    await mkUser('plain-x', []);
    await mkUser('plain-d', []);
    const adminGrant = await req(tok['admin2']!, 'POST', `/v1/tenants/${orgA}/role-bindings`, {
      userId: uid['plain-d'],
      role: 'admin',
      inherit: false,
    });
    expect(adminGrant.statusCode, adminGrant.body).toBe(201);
    tok['plain-d'] = await n.login('plain-d@org-a.example.org', PW);
    const granted = await req(tok['plain-d']!, 'POST', `/v1/tenants/${orgA}/role-bindings`, {
      userId: uid['plain-x'],
      role: 'agent-maintainer',
      inherit: false,
    });
    expect(granted.statusCode, granted.body).toBe(201);
    await n.login('plain-x@org-a.example.org', PW).then((t) => (tok['plain-x'] = t));
    const a = await newAgent(tok['admin2']!);
    const review = await open(tok['admin2']!, a.id);
    const res = await decide(tok['plain-x']!, review);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error).toBe('binding_granted_by_contributor');
    // the same binding works for work that neither C nor D touched
    const other = await newAgent(tok['author']!);
    expect((await decide(tok['plain-x']!, await open(tok['author']!, other.id))).statusCode).toBe(
      201,
    );
  });

  it('refuses a reviewer whose account a contributor made, although a clean administrator granted the role', async () => {
    const yRes = await req(tok['admin2']!, 'POST', '/v1/users', {
      email: 'made-by-c@org-a.example.org',
      displayName: 'Y',
      password: PW,
      globalRoles: [],
    });
    expect(yRes.statusCode, yRes.body).toBe(201);
    const [created] = await n.ctx.db
      .select()
      .from(users)
      .where(eq(users.id, j(yRes).id));
    expect(created!.createdBy).toBe(uid['admin2']);
    // the clean administrator gives the role afterwards
    const patch = await req(adminA, 'PATCH', `/v1/users/${j(yRes).id}`, {
      globalRoles: ['agent-maintainer'],
    });
    expect(patch.statusCode, patch.body).toBe(200);
    const yTok = await n.login('made-by-c@org-a.example.org', PW);
    const a = await newAgent(tok['admin2']!);
    const review = await open(tok['admin2']!, a.id);
    const res = await decide(yTok, review);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error).toBe('binding_granted_by_contributor');
  });

  it('follows the chain through the roles that allow granting, depth limited, and reports an end it cannot see', async () => {
    const [d] = await n.ctx.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'laundry-d@org-a.example.org'));
    const full = await followGrantChain(n.ctx.db, [{ userId: d!.id, unknown: false }], new Date());
    expect(full.users).toEqual(expect.arrayContaining([d!.id, uid['admin2']!]));
    expect(full.unknown).toBe(false);
    // one hop is not enough to reach the end of the chain: the rest counts as unknown
    const short = await followGrantChain(
      n.ctx.db,
      [{ userId: d!.id, unknown: false }],
      new Date(),
      1,
    );
    expect(short.unknown).toBe(true);
    expect(
      (await followGrantChain(n.ctx.db, [{ userId: null, unknown: true }], new Date())).unknown,
    ).toBe(true);
  });
});

describe('finding 5 and follow-up on mirror rows: nobody versus unknown', () => {
  const flagOf = async (userId: string) => {
    const [row] = await n.ctx.db
      .select()
      .from(tenantRoleBindings)
      .where(and(eq(tenantRoleBindings.userId, userId), eq(tenantRoleBindings.source, 'mirror')));
    return row!;
  };
  it('fails closed on an unknown grantor unless the installation allows it, and accepts "nobody"', async () => {
    await mkUser('unk', ['agent-maintainer']);
    await n.ctx.db
      .update(tenantRoleBindings)
      .set({ grantedBy: null, grantorUnknown: true })
      .where(eq(tenantRoleBindings.userId, uid['unk']!));
    const a = await newAgent(tok['author']!);
    const review = await open(tok['author']!, a.id);
    const refused = await decide(tok['unk']!, review);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().error).toBe('binding_grantor_unknown');
    expect(j(await req(tok['unk']!, 'GET', `/v1/reviews/${review.id}`)).you).toMatchObject({
      eligible: false,
      code: 'binding_grantor_unknown',
    });

    const lifecycle = n.ctx.config.lifecycle;
    lifecycle.unknownGrantor = 'allow';
    try {
      const allowed = await decide(tok['unk']!, review);
      expect(allowed.statusCode, allowed.body).toBe(201);
    } finally {
      lifecycle.unknownGrantor = 'refuse';
    }

    // nobody granted it (identity provider, bootstrap): not unknown, not contributor-made
    await mkUser('nobody', ['agent-maintainer']);
    await n.ctx.db
      .update(tenantRoleBindings)
      .set({ grantedBy: null, grantorUnknown: false })
      .where(eq(tenantRoleBindings.userId, uid['nobody']!));
    const b = await newAgent(tok['author']!);
    const r2 = await open(tok['author']!, b.id);
    const ok = await decide(tok['nobody']!, r2);
    expect(ok.statusCode, ok.body).toBe(201);
  });

  it('marks a mirror row that the reconcile re-creates as unknown, and one the login mirror writes as nobody', async () => {
    await mkUser('recon', ['agent-maintainer']);
    await n.ctx.db.delete(tenantRoleBindings).where(eq(tenantRoleBindings.userId, uid['recon']!));
    const fixed = await reconcileUserBindings(n.ctx.db, uid['recon']!);
    expect(fixed).toMatchObject({ added: 1 });
    expect(await flagOf(uid['recon']!)).toMatchObject({ grantedBy: null, grantorUnknown: true });
    const a = await newAgent(tok['author']!);
    const review = await open(tok['author']!, a.id);
    expect((await decide(tok['recon']!, review)).json().error).toBe('binding_grantor_unknown');

    // the identity-provider login mirrors roles without a grantor: nobody, not unknown
    await mkUser('idp-like', []);
    await mirrorGlobalRoles(n.ctx.db, { id: uid['idp-like']!, tenantId: orgA }, [
      'agent-maintainer',
    ]);
    expect(await flagOf(uid['idp-like']!)).toMatchObject({
      grantedBy: null,
      grantorUnknown: false,
    });
  });

  it('keeps an unknown grantor unknown when a team member list is saved again, and a new member known', async () => {
    const team = j(await req(adminA, 'POST', '/v1/teams', { slug: 'team-x', name: 'X' })).id;
    await mkUser('tm-old', ['viewer']);
    await mkUser('tm-new', ['viewer']);
    await n.ctx.db.insert(teamMembers).values({
      teamId: team,
      userId: uid['tm-old']!,
      role: 'agent-maintainer',
      grantedBy: null,
      grantorUnknown: true,
    });
    const members = [
      { userId: uid['tm-old'], role: 'agent-maintainer' },
      { userId: uid['tm-new'], role: 'agent-maintainer' },
    ];
    expect((await req(adminA, 'PUT', `/v1/teams/${team}/members`, { members })).statusCode).toBe(
      204,
    );
    const rows = await n.ctx.db.select().from(teamMembers).where(eq(teamMembers.teamId, team));
    const by = (u: string) => rows.find((r) => r.userId === u)!;
    expect(by(uid['tm-old']!)).toMatchObject({ grantedBy: null, grantorUnknown: true });
    expect(by(uid['tm-new']!)).toMatchObject({
      grantedBy: expect.any(String),
      grantorUnknown: false,
    });
  });
});

describe('finding 2: an open review is judged by the stricter policy', () => {
  it('does not relax an open review when the policy is loosened, and tightening applies at once', async () => {
    expect(
      (
        await setPolicy({
          requireApprovalForPublish: 'on',
          minApprovals: 2,
          allowedApproverRoles: ['admin', 'agent-maintainer'],
        })
      ).statusCode,
    ).toBe(200);
    const a = await newAgent(tok['author']!);
    const review = await open(tok['author']!, a.id);
    expect(review.requiredApprovals).toBe(2);
    // a clean administrator loosens everything
    const loosen = await setPolicy({
      requireApprovalForPublish: 'off',
      minApprovals: 1,
      allowedApproverRoles: ['admin', 'agent-maintainer', 'operator'],
      approvalExpiryHours: 720,
    });
    expect(loosen.statusCode, loosen.body).toBe(200);
    const after = await getReview(tok['rev1']!, review.id);
    expect(after.approvalRequired).toBe(true);
    expect(after.requiredApprovals).toBe(2);
    expect(after.digests.policyDigest).toBe(review.digests.policyDigest);
    // the role the snapshot did not list still cannot decide
    expect((await decide(tok['oper']!, after)).json().error).toBe('not_eligible');
    // and one approval is still not enough
    const one = await decide(tok['rev1']!, after);
    expect(one.statusCode, one.body).toBe(201);
    expect(j(one).review.state).toBe('review_requested');
    // tightening applies at once
    expect((await setPolicy({ minApprovals: 3, requireApprovalForPublish: 'on' })).statusCode).toBe(
      200,
    );
    expect((await getReview(tok['rev1']!, review.id)).requiredApprovals).toBe(3);
    await resetPolicy();
    expect((await setPolicy({ minApprovals: null, allowedApproverRoles: null })).statusCode).toBe(
      200,
    );
  });

  it('refuses a contributor of an open review who loosens the policy; another administrator may', async () => {
    await resetPolicy();
    const a = await newAgent(tok['admin2']!);
    await open(tok['admin2']!, a.id);
    const refused = await setPolicy({ requireApprovalForPublish: 'off' }, tok['admin2']!);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().error).toBe('policy_loosening_by_contributor');
    // tightening is fine for the contributor
    expect((await setPolicy({ minApprovals: 2 }, tok['admin2']!)).statusCode).toBe(200);
    // somebody who is not a contributor of any open review loosens
    const ok = await setPolicy({ minApprovals: 1 });
    expect(ok.statusCode, ok.body).toBe(200);
    await resetPolicy();
  });
});

describe('finding 3: the digests an approval binds to are required', () => {
  it('refuses an approval without them, and any decision without them while approval is required', async () => {
    await resetPolicy();
    const a = await newAgent(tok['author']!);
    const review = await open(tok['author']!, a.id);
    const only = { decision: 'approve', expectedDigest: review.revision.digest };
    const approve = await req(tok['rev1']!, 'POST', `/v1/reviews/${review.id}/decisions`, only);
    expect(approve.statusCode, approve.body).toBe(400);
    expect(approve.json().error).toBe('validation_failed');
    expect(
      approve
        .json()
        .details.map((d: Json) => d.path)
        .sort(),
    ).toEqual(['expectedExpansionDigest', 'expectedPolicyDigest', 'expectedResolutionDigest']);
    const changes = await req(tok['rev1']!, 'POST', `/v1/reviews/${review.id}/decisions`, {
      decision: 'request_changes',
      comment: 'no',
      expectedDigest: review.revision.digest,
      expectedPolicyDigest: review.digests.policyDigest,
    });
    expect(changes.statusCode, changes.body).toBe(400);
    // nothing was recorded
    expect((await getReview(tok['rev1']!, review.id)).approvals).toHaveLength(0);
    // each one alone is enough to be refused
    for (const k of [
      'expectedExpansionDigest',
      'expectedResolutionDigest',
      'expectedPolicyDigest',
    ]) {
      const body = { ...bound(review), decision: 'approve' } as Json;
      delete body[k];
      const res = await req(tok['rev1']!, 'POST', `/v1/reviews/${review.id}/decisions`, body);
      expect(res.statusCode, k).toBe(400);
    }
    // an ineligible caller is refused first, whatever is missing (nothing to learn)
    const self = await req(tok['author']!, 'POST', `/v1/reviews/${review.id}/decisions`, only);
    expect(self.json().error).toBe('self_approval');
  });

  it('lets a comment without the digests through only when approval is not required, never an approval', async () => {
    expect((await setPolicy({ requireApprovalForPublish: 'off' })).statusCode).toBe(200);
    const a = await newAgent(tok['author']!);
    const review = await open(tok['author']!, a.id);
    const note = await req(tok['rev1']!, 'POST', `/v1/reviews/${review.id}/decisions`, {
      decision: 'request_changes',
      comment: 'note',
      expectedDigest: review.revision.digest,
    });
    expect(note.statusCode, note.body).toBe(201);
    const approve = await req(tok['rev2']!, 'POST', `/v1/reviews/${review.id}/decisions`, {
      decision: 'approve',
      expectedDigest: review.revision.digest,
    });
    expect(approve.statusCode, approve.body).toBe(400);
    await resetPolicy();
  });
});

describe('finding 4: a draft that diverged from its head revision', () => {
  it('appends a system revision for the draft before a review is opened, and before a save', async () => {
    const a = await newAgent(tok['author']!);
    const diverged = agentSource(a.name, 'nobody', '1.0.7');
    await n.ctx.db.update(agents).set({ draftSource: diverged }).where(eq(agents.id, a.id));
    const review = await open(tok['author']!, a.id);
    expect(review.revision.digest).toBe(sourceDigest(diverged));
    expect(review.revision).toMatchObject({ seq: 2, authorKind: 'system', authorId: null });
    expect(review.unknownAuthor).toBe(true);
    const list = j(await req(tok['author']!, 'GET', `/v1/agents/${a.id}/revisions`)).items;
    expect(list.map((r: Json) => r.seq)).toEqual([2, 1]);

    // a save over a diverged draft records the content it overwrites first
    const b = await newAgent(tok['author']!);
    const divergedB = agentSource(b.name, 'nobody', '1.0.8');
    await n.ctx.db.update(agents).set({ draftSource: divergedB }).where(eq(agents.id, b.id));
    const saved = await req(tok['author']!, 'PUT', `/v1/agents/${b.id}/draft`, {
      source: agentSource(b.name, 'nobody', '1.0.9'),
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const revs = await n.ctx.db
      .select()
      .from(agentDraftRevisions)
      .where(eq(agentDraftRevisions.agentId, b.id))
      .orderBy(agentDraftRevisions.seq);
    expect(revs.map((r) => [r.seq, r.authorKind])).toEqual([
      [1, 'user'],
      [2, 'system'],
      [3, 'user'],
    ]);
    expect(revs[1]!.digest).toBe(sourceDigest(divergedB));
    expect(revs[2]!.parentId).toBe(revs[1]!.id);
  });

  it('does nothing for a draft that matches its head', async () => {
    const a = await newAgent(tok['author']!);
    await open(tok['author']!, a.id);
    const revs = await n.ctx.db
      .select()
      .from(agentDraftRevisions)
      .where(eq(agentDraftRevisions.agentId, a.id));
    expect(revs).toHaveLength(1);
  });
});

describe('follow-up 6: every author that is not a user is unknown', () => {
  it('counts the creator and the audited editors for a repo revision that has an author id', async () => {
    const a = await newAgent(tok['author']!);
    const [agent] = await n.ctx.db.select().from(agents).where(eq(agents.id, a.id));
    const repoId = randomUUID();
    const rev = randomUUID();
    await n.ctx.db.insert(agentDraftRevisions).values({
      id: rev,
      agentId: a.id,
      tenantId: agent!.tenantId,
      seq: 2,
      digest: sourceDigest(agent!.draftSource),
      source: agent!.draftSource,
      authorId: repoId,
      authorKind: 'repo',
      parentId: agent!.draftRevisionId,
    });
    await n.ctx.db.update(agents).set({ draftRevisionId: rev }).where(eq(agents.id, a.id));
    const review = await open(tok['rev1']!, a.id);
    expect(review.revision).toMatchObject({ authorKind: 'repo', authorId: repoId });
    expect(review.unknownAuthor).toBe(true);
    // the creator of the agent and the opener count; the creator cannot approve their own agent
    expect(review.contributors).toEqual(expect.arrayContaining([uid['author'], uid['rev1']]));
    expect((await decide(tok['author']!, review)).json().error).toBe('self_approval');
    expect((await decide(tok['rev2']!, review)).statusCode).toBe(201);
  });
});

describe('follow-up 8: withdraw checks the administrator from the database, at the agent node', () => {
  it('does not let a cached administrator principal withdraw once the binding is gone', async () => {
    // The legacy read path keeps the roles of a principal until its cache entry expires, which is
    // what a stale administrator looks like; the resolver path would already refuse the route.
    const auth = n.ctx.config.auth;
    auth.roleBindingsRead = 'legacy';
    try {
      await staleAdminCannotWithdraw();
    } finally {
      auth.roleBindingsRead = 'bindings';
    }
  });
});

async function staleAdminCannotWithdraw() {
  await mkUser('ex-admin', ['admin']);
  const a = await newAgent(tok['author']!);
  const review = await open(tok['author']!, a.id);
  // warm the principal cache, then take the role away in the database only
  expect((await req(tok['ex-admin']!, 'GET', `/v1/reviews/${review.id}`)).statusCode).toBe(200);
  await n.ctx.db
    .update(users)
    .set({ globalRoles: ['agent-maintainer'] })
    .where(eq(users.id, uid['ex-admin']!));
  const res = await req(tok['ex-admin']!, 'POST', `/v1/reviews/${review.id}/withdraw`);
  expect(res.statusCode, res.body).toBe(403);
  expect(res.json().message).toContain('only the person who opened the review');
  expect((await getReview(adminA, review.id)).status).toBe('open');
  // the current administrator still can
  expect((await req(adminA, 'POST', `/v1/reviews/${review.id}/withdraw`)).statusCode).toBe(200);
}

describe('widening a binding keeps its grantor (review of #354)', () => {
  const rowOf = async (id: string) =>
    (await n.ctx.db.select().from(tenantRoleBindings).where(eq(tenantRoleBindings.id, id)))[0]!;
  const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
  const rbUrl = () => `/v1/tenants/${orgA}/role-bindings`;
  const grant = async (key: string, by: string) => {
    await mkUser(key, []);
    const res = await req(by, 'POST', rbUrl(), {
      userId: uid[key],
      role: 'agent-maintainer',
      inherit: false,
      expiresAt: day(1),
    });
    expect(res.statusCode, res.body).toBe(201);
    return j(res).id as string;
  };
  const adminAId = async () =>
    (await n.ctx.db.select().from(users).where(eq(users.email, 'admin@org-a.example.org')))[0]!.id;

  it('does not replace the grantor when somebody else extends the expiry, nor clear an unknown one', async () => {
    const id = await grant('ext-1', adminA);
    const patch = (by: string, days: number) =>
      req(by, 'PATCH', `${rbUrl()}/${id}`, { expiresAt: day(days) });
    expect((await patch(tok['admin2']!, 3)).statusCode).toBe(200);
    expect(await rowOf(id)).toMatchObject({ grantedBy: await adminAId(), grantorUnknown: false });
    // an unknown grantor stays unknown and is not given to the person who widens
    await n.ctx.db
      .update(tenantRoleBindings)
      .set({ grantedBy: null, grantorUnknown: true })
      .where(eq(tenantRoleBindings.id, id));
    expect((await patch(adminA, 6)).statusCode).toBe(200);
    expect(await rowOf(id)).toMatchObject({ grantedBy: null, grantorUnknown: true });
    // a row that nobody granted is now granted by the person who widened it
    await n.ctx.db
      .update(tenantRoleBindings)
      .set({ grantedBy: null, grantorUnknown: false })
      .where(eq(tenantRoleBindings.id, id));
    expect((await patch(tok['admin2']!, 9)).statusCode).toBe(200);
    expect(await rowOf(id)).toMatchObject({ grantedBy: uid['admin2'], grantorUnknown: false });
  });

  it('keeps grantor and unknown mark through the organisation-wide opt-in (last: it widens every binding)', async () => {
    const known = await grant('ext-known', tok['admin2']!);
    const unknown = await grant('ext-unknown', adminA);
    await n.ctx.db
      .update(tenantRoleBindings)
      .set({ grantedBy: null, grantorUnknown: true })
      .where(eq(tenantRoleBindings.id, unknown));
    const res = await n.req({
      method: 'POST',
      url: `${rbUrl()}/enable-inheritance`,
      payload: { roles: ['agent-maintainer'], dryRun: false },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await rowOf(known)).toMatchObject({ inherit: true, grantedBy: uid['admin2'] });
    expect(await rowOf(unknown)).toMatchObject({
      inherit: true,
      grantedBy: null,
      grantorUnknown: true,
    });
  });
});

describe('clearing an unknown grantor takes two steps (review of #354)', () => {
  it('re-listing the role keeps the unknown mark; removing it and adding it again clears it', async () => {
    await mkUser('clear-me', ['agent-maintainer']);
    const mirror = () =>
      n.ctx.db
        .select()
        .from(tenantRoleBindings)
        .where(
          and(
            eq(tenantRoleBindings.userId, uid['clear-me']!),
            eq(tenantRoleBindings.source, 'mirror'),
          ),
        );
    await n.ctx.db
      .update(tenantRoleBindings)
      .set({ grantedBy: null, grantorUnknown: true })
      .where(eq(tenantRoleBindings.userId, uid['clear-me']!));
    const patch = (roles: string[]) =>
      req(adminA, 'PATCH', `/v1/users/${uid['clear-me']}`, { globalRoles: roles });
    expect((await patch(['agent-maintainer'])).statusCode).toBe(200);
    expect((await mirror())[0]).toMatchObject({ grantedBy: null, grantorUnknown: true });
    expect((await patch([])).statusCode).toBe(200);
    expect((await patch(['agent-maintainer'])).statusCode).toBe(200);
    expect((await mirror())[0]).toMatchObject({ grantorUnknown: false });
    expect((await mirror())[0]!.grantedBy).not.toBeNull();
  });
});
