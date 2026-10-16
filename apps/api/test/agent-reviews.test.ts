import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  agentDraftRevisions,
  agentReviewDecisions,
  agentReviews,
  agentVersions,
  agents,
  auditLog,
} from '../src/db/schema.js';
import { agentSource } from './fixtures.js';
import { PG_URL, openPglite, openPostgres, type Sql } from './db-targets.js';
import { testNode, type TestNode } from './helpers.js';

/**
 * ADR 0017 slice S1: draft revisions, reviews, decisions and the approval rules over HTTP, on the
 * legacy read path (OAX_ROLE_BINDINGS_READ=legacy); the resolver path is `agent-reviews-bindings`.
 */
const PW = 'long-password-123';
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let n: TestNode;
let db: Sql;
let clockOffsetMs = 0;
let adminA: string; // tenant administrator of org-a (not a platform operator)
let adminB: string;
let orgA: string;
let teamSec: string;
const uid: Record<string, string> = {};
const tok: Record<string, string> = {};
let agentSeq = 0;

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

/** The id of a new agent of team-security, written by `by`. */
async function newAgent(by: string, extra = '', version = '1.0.0') {
  const name = `rev-agent-${++agentSeq}`;
  const res = await req(by, 'POST', '/v1/agents', {
    source: agentSource(name, 'team-sec', version, extra),
  });
  expect(res.statusCode, res.body).toBe(201);
  return { id: j(res).id as string, name };
}
const edit = (by: string, a: { id: string; name: string }, version: string, extra = '') =>
  req(by, 'PUT', `/v1/agents/${a.id}/draft`, {
    source: agentSource(a.name, 'team-sec', version, extra),
  });
const open = (by: string, agentId: string) => req(by, 'POST', `/v1/agents/${agentId}/reviews`);
const getReview = async (by: string, id: string) => {
  const res = await req(by, 'GET', `/v1/reviews/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return j(res);
};
const decide = (by: string, review: Json, decision: string, extra: Json = {}) =>
  req(by, 'POST', `/v1/reviews/${review.id}/decisions`, {
    decision,
    expectedDigest: review.revision.digest,
    expectedExpansionDigest: review.digests.expansionDigest,
    expectedResolutionDigest: review.digests.resolutionDigest,
    expectedPolicyDigest: review.digests.policyDigest,
    ...extra,
  });
const auditActions = async (target: string, action?: string) =>
  (await n.ctx.db.select().from(auditLog).where(eq(auditLog.target, target)).orderBy(auditLog.seq))
    .filter((e) => !action || e.action === action)
    .map((e) => ({ action: e.action, actor: e.actor, payload: e.payload as Json }));
const setPolicy = async (patch: Json, tenant = orgA, by = adminA) => {
  const res = await req(by, 'PATCH', `/v1/tenants/${tenant}/settings/agent-lifecycle`, patch);
  expect(res.statusCode, res.body).toBe(200);
  return j(res);
};

beforeAll(async () => {
  // On a real PostgreSQL (OAX_TEST_DATABASE_URL) the locks are real; PGlite serialises everything.
  db = PG_URL ? await openPostgres() : await openPglite();
  n = await testNode(
    {
      OAX_DATABASE_URL: db.url,
      OAX_LIFECYCLE_REQUIRE_APPROVAL: 'on',
      OAX_RATE_LIMIT_LOGIN_MAX: '1000',
    },
    { now: () => new Date(Date.now() + clockOffsetMs) },
  );
  for (const slug of ['org-a', 'org-b']) {
    const r = await n.req({
      method: 'POST',
      url: '/v1/tenants',
      payload: {
        slug,
        name: slug,
        admin: { email: `admin@${slug}.example.org`, displayName: `Admin ${slug}`, password: PW },
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    if (slug === 'org-a') orgA = j(r).id;
  }
  adminA = await n.login('admin@org-a.example.org', PW);
  adminB = await n.login('admin@org-b.example.org', PW);
  teamSec = j(await req(adminA, 'POST', '/v1/teams', { slug: 'team-sec', name: 'Security' })).id;
  await mkUser('author', ['agent-maintainer']);
  await mkUser('rev1', ['agent-maintainer']);
  await mkUser('rev2', ['agent-maintainer']);
  await mkUser('dev', ['agent-developer']);
  await mkUser('coauthor', ['agent-developer']);
  await mkUser('viewer', ['viewer']);
  await mkUser('auditor', ['auditor']);
  await mkUser('oper', ['operator']);
  await mkUser('admin2', ['admin']);
}, 120_000);
afterAll(async () => {
  await n?.close();
  await db?.close();
});

describe('draft revisions', () => {
  it('creates a revision with its author on create and on every changing save', async () => {
    const a = await newAgent(tok['author']!);
    expect((await edit(tok['author']!, a, '1.0.1')).statusCode).toBe(200);
    expect((await edit(tok['coauthor']!, a, '1.0.2')).statusCode).toBe(200);
    const list = j(await req(tok['author']!, 'GET', `/v1/agents/${a.id}/revisions`));
    expect(list.items.map((r: Json) => [r.seq, r.authorId, r.authorKind])).toEqual([
      [3, uid['coauthor'], 'user'],
      [2, uid['author'], 'user'],
      [1, uid['author'], 'user'],
    ]);
    expect(list.head).toBe(list.items[0].id);
    expect(list.items[0].parentId).toBe(list.items[1].id);
    expect(list.items[2].parentId).toBeNull();
    const detail = j(await req(tok['author']!, 'GET', `/v1/agents/${a.id}/revisions/2`));
    expect(detail.source).toContain('version: 1.0.1');
    expect(detail.digest).toMatch(/^[0-9a-f]{64}$/);
    expect((await auditActions(a.id, 'agent.revision.created')).length).toBe(3);
  });

  it('creates none for identical content, also when only line endings and trailing space differ', async () => {
    const a = await newAgent(tok['author']!);
    const src = agentSource(a.name, 'team-sec');
    for (const body of [src, src + '\n\n', src.replace(/\n/g, '\r\n'), src.trimEnd()]) {
      const res = await req(tok['author']!, 'PUT', `/v1/agents/${a.id}/draft`, { source: body });
      expect(res.statusCode, res.body).toBe(200);
    }
    const rows = await n.ctx.db
      .select()
      .from(agentDraftRevisions)
      .where(eq(agentDraftRevisions.agentId, a.id));
    expect(rows).toHaveLength(1);
    // the draft stays byte for byte the source of its newest revision
    const [row] = await n.ctx.db.select().from(agents).where(eq(agents.id, a.id));
    expect(row!.draftSource).toBe(rows[0]!.source);
    expect(row!.draftRevisionId).toBe(rows[0]!.id);
  });

  it('gives an agent from before the revisions one system revision per agent, once', async () => {
    const a = await newAgent(tok['author']!);
    // the state of an installation upgraded from before migration 0032
    await n.ctx.db.update(agents).set({ draftRevisionId: null }).where(eq(agents.id, a.id));
    await n.ctx.db.delete(agentDraftRevisions).where(eq(agentDraftRevisions.agentId, a.id));
    expect(await n.services.agentReviews.backfillRevisions()).toBeGreaterThanOrEqual(1);
    expect(await n.services.agentReviews.backfillRevisions()).toBe(0);
    const rows = await n.ctx.db
      .select()
      .from(agentDraftRevisions)
      .where(eq(agentDraftRevisions.agentId, a.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ authorKind: 'system', authorId: null, seq: 1 });
    // a save on top of it appends a user revision
    expect((await edit(tok['author']!, a, '1.0.5')).statusCode).toBe(200);
    const list = j(await req(tok['author']!, 'GET', `/v1/agents/${a.id}/revisions`));
    expect(list.items.map((r: Json) => r.authorKind)).toEqual(['user', 'system']);
  });

  it('creates the system revision on the first save of a legacy agent, without a backfill', async () => {
    const a = await newAgent(tok['author']!);
    await n.ctx.db.update(agents).set({ draftRevisionId: null }).where(eq(agents.id, a.id));
    await n.ctx.db.delete(agentDraftRevisions).where(eq(agentDraftRevisions.agentId, a.id));
    expect((await edit(tok['coauthor']!, a, '1.0.9')).statusCode).toBe(200);
    const list = j(await req(tok['author']!, 'GET', `/v1/agents/${a.id}/revisions`));
    expect(list.items.map((r: Json) => r.authorKind)).toEqual(['user', 'system']);
  });

  it('pages the list, 404s a missing revision and hides foreign agents', async () => {
    const a = await newAgent(tok['author']!);
    for (const v of ['1.0.1', '1.0.2']) await edit(tok['author']!, a, v);
    const p1 = j(await req(tok['author']!, 'GET', `/v1/agents/${a.id}/revisions?limit=2`));
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBe('1');
    const p2 = j(
      await req(
        tok['author']!,
        'GET',
        `/v1/agents/${a.id}/revisions?limit=2&cursor=${p1.nextCursor}`,
      ),
    );
    expect(p2.items.map((r: Json) => r.seq)).toEqual([1]);
    expect((await req(tok['author']!, 'GET', `/v1/agents/${a.id}/revisions/99`)).statusCode).toBe(
      404,
    );
    expect((await req(adminB, 'GET', `/v1/agents/${a.id}/revisions`)).statusCode).toBe(404);
    expect((await req(adminB, 'GET', `/v1/agents/${a.id}/revisions/1`)).statusCode).toBe(404);
    expect(
      (await req(tok['author']!, 'GET', `/v1/agents/${a.id}/revisions?cursor=abc`)).statusCode,
    ).toBe(400);
  });

  it('refuses to change a revision in the database', async () => {
    const a = await newAgent(tok['author']!);
    await expect(
      n.ctx.db
        .update(agentDraftRevisions)
        .set({ source: 'x' })
        .where(eq(agentDraftRevisions.agentId, a.id)),
    ).rejects.toThrow();
  });
});

describe('opening a review', () => {
  it('records the digests an approval binds to and the policy', async () => {
    const a = await newAgent(tok['author']!);
    const res = await open(tok['author']!, a.id);
    expect(res.statusCode, res.body).toBe(201);
    const r = j(res);
    expect(r).toMatchObject({
      agentId: a.id,
      status: 'open',
      state: 'review_requested',
      openedBy: uid['author'],
      requiredApprovals: 1,
      approvalRequired: true,
      baseVersion: null,
    });
    expect(r.digests.digest).toBe(r.revision.digest);
    for (const k of ['expansionDigest', 'resolutionDigest', 'policyDigest'])
      expect(r.digests[k]).toMatch(/^[0-9a-f]{64}$/);
    expect(r.contributors).toEqual([uid['author']]);
    const [opened] = await auditActions(a.id, 'agent.review.opened');
    expect(opened!.payload).toMatchObject({
      review: r.id,
      digest: r.digests.digest,
      requiredApprovals: 1,
    });
    expect(JSON.stringify(opened!.payload)).not.toContain('instructions');
  });

  it('allows one open review per agent and frees the slot when it is withdrawn', async () => {
    const a = await newAgent(tok['author']!);
    const first = j(await open(tok['author']!, a.id));
    const dup = await open(tok['rev1']!, a.id);
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ error: 'review_open', details: { reviewId: first.id } });
    expect((await req(tok['author']!, 'POST', `/v1/reviews/${first.id}/withdraw`)).statusCode).toBe(
      200,
    );
    expect((await open(tok['rev1']!, a.id)).statusCode).toBe(201);
  });

  it('has nothing to review when the draft equals the latest published version', async () => {
    const a = await newAgent(tok['author']!);
    expect((await req(tok['author']!, 'POST', `/v1/agents/${a.id}/publish`)).statusCode).toBe(201);
    const res = await open(tok['author']!, a.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('nothing_to_review');
    await edit(tok['author']!, a, '1.0.1');
    const ok = await open(tok['author']!, a.id);
    expect(ok.statusCode).toBe(201);
    expect(j(ok).baseVersion).toMatchObject({ version: '1.0.0' });
  });

  it('needs agents:write on the agent', async () => {
    const a = await newAgent(tok['author']!);
    for (const who of ['viewer', 'auditor', 'oper'])
      expect((await open(tok[who]!, a.id)).statusCode, who).toBe(403);
  });

  it('is invisible across tenants: the same 404 as an unknown agent', async () => {
    const a = await newAgent(tok['author']!);
    const foreign = await open(adminB, a.id);
    const unknown = await open(adminB, randomUUID());
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual({ ...unknown.json(), message: foreign.json().message });
    expect(unknown.statusCode).toBe(404);
  });
});

describe('who may decide (rules A1 to A7, A10)', () => {
  it('lets a distinct maintainer approve and records every binding field of the approval', async () => {
    const a = await newAgent(tok['author']!);
    const review = j(await open(tok['author']!, a.id));
    const res = await decide(tok['rev1']!, review, 'approve', {
      expectedExpansionDigest: review.digests.expansionDigest,
      expectedResolutionDigest: review.digests.resolutionDigest,
      expectedPolicyDigest: review.digests.policyDigest,
    });
    expect(res.statusCode, res.body).toBe(201);
    const { decision, review: after } = j(res);
    expect(after.state).toBe('approved');
    expect(decision).toMatchObject({
      reviewerId: uid['rev1'],
      decision: 'approve',
      revisionId: review.revision.id,
      digest: review.revision.digest,
      expansionDigest: review.digests.expansionDigest,
      resolutionDigest: review.digests.resolutionDigest,
      policyDigest: review.digests.policyDigest,
      baseVersionId: null,
      reviewerAuth: 'session',
      actingTenantId: orgA,
      counted: true,
      current: true,
    });
    expect(decision.bindingRefs).toEqual([
      expect.objectContaining({
        role: 'agent-maintainer',
        source: 'mirror',
        grantedBy: expect.any(String),
      }),
    ]);
    expect(Date.parse(decision.expiresAt) - Date.parse(decision.decidedAt)).toBe(168 * 3_600_000);
    // the stored row carries the same fields
    const [row] = await n.ctx.db
      .select()
      .from(agentReviewDecisions)
      .where(eq(agentReviewDecisions.id, decision.id));
    expect(row).toMatchObject({ digest: review.revision.digest, reviewerAuth: 'session' });
    const [e] = await auditActions(a.id, 'agent.review.decided');
    expect(e!.payload).toMatchObject({
      review: review.id,
      decision: 'approve',
      reviewer: uid['rev1'],
      authMethod: 'session',
    });
    expect(JSON.stringify(e!.payload)).not.toContain('comment');
  });

  it.each([
    ['the author', 'author'],
    ['a co-author who edited a later revision', 'coauthor'],
    ['the opener', 'rev2'],
    ['an administrator who wrote the draft', 'admin2'],
  ])('refuses %s with 403 self_approval', async (_name, who) => {
    const a = await newAgent(who === 'admin2' ? tok['admin2']! : tok['author']!);
    if (who === 'coauthor') await edit(tok['coauthor']!, a, '1.0.1');
    const opener =
      who === 'rev2' ? tok['rev2']! : who === 'admin2' ? tok['admin2']! : tok['author']!;
    const review = j(await open(opener, a.id));
    const res = await decide(tok[who]!, review, 'approve');
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('self_approval');
    // they cannot request changes or reject either: it is not their review to decide
    expect(
      (await decide(tok[who]!, review, 'request_changes', { comment: 'x' })).json().error,
    ).toBe('self_approval');
    expect((await decide(tok[who]!, review, 'reject', { comment: 'x' })).json().error).toBe(
      'self_approval',
    );
  });

  it('refuses a platform administrator who wrote the draft, even acting in the tenant', async () => {
    const created = await n.req({
      method: 'POST',
      url: '/v1/agents',
      headers: { 'x-oax-tenant': 'org-a' },
      payload: { source: agentSource('platform-authored', 'team-sec') },
    });
    expect(created.statusCode, created.body).toBe(201);
    const review = j(
      await n.req({
        method: 'POST',
        url: `/v1/agents/${created.json().id}/reviews`,
        headers: { 'x-oax-tenant': 'org-a' },
      }),
    );
    const res = await n.req({
      method: 'POST',
      url: `/v1/reviews/${review.id}/decisions`,
      headers: { 'x-oax-tenant': 'org-a' },
      payload: {
        decision: 'approve',
        expectedDigest: review.revision.digest,
        expectedExpansionDigest: review.digests.expansionDigest,
        expectedResolutionDigest: review.digests.resolutionDigest,
        expectedPolicyDigest: review.digests.policyDigest,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('self_approval');
    // The operator made the organisation administrator, so a review the operator contributed to that
    // stays unfinished would stop that administrator from loosening the policy in later tests (#356).
    await n.ctx.db
      .update(agentReviews)
      .set({ status: 'published', closedAt: new Date() })
      .where(eq(agentReviews.id, review.id));
  });

  it('lets a platform administrator approve the work of somebody else, as a distinct person', async () => {
    const a = await newAgent(tok['author']!);
    const review = j(await open(tok['author']!, a.id));
    const res = await n.req({
      method: 'POST',
      url: `/v1/reviews/${review.id}/decisions`,
      headers: { 'x-oax-tenant': 'org-a' },
      payload: {
        decision: 'approve',
        expectedDigest: review.revision.digest,
        expectedExpansionDigest: review.digests.expansionDigest,
        expectedResolutionDigest: review.digests.resolutionDigest,
        expectedPolicyDigest: review.digests.policyDigest,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(j(res).decision.bindingRefs[0]).toMatchObject({ source: 'platform', grantedBy: null });
  });

  it('refuses an API token unless the tenant allows token approvals; a contributor never, not even then', async () => {
    const mkToken = async (who: string, scopes: string[]) => {
      const t = await req(tok[who]!, 'POST', '/v1/tokens', { name: `t-${who}`, scopes });
      expect(t.statusCode, t.body).toBe(201);
      return { secret: j(t).token as string, id: j(t).id as string };
    };
    const reviewer = await mkToken('rev1', ['agents:read', 'agents:approve']);
    const authorTok = await mkToken('author', ['agents:read', 'agents:approve']);
    const a = await newAgent(tok['author']!);
    const review = j(await open(tok['author']!, a.id));
    const refused = await decide(reviewer.secret, review, 'approve');
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe('token_approval_disabled');
    // loosening the policy does not relax a review that is already open (finding 2 of #343) ...
    await setPolicy({ allowTokenApprovals: true });
    try {
      expect((await decide(reviewer.secret, review, 'approve')).json().error).toBe(
        'token_approval_disabled',
      );
      // ... a review opened afterwards is judged by the new policy
      const b = await newAgent(tok['author']!);
      const fresh = j(await open(tok['author']!, b.id));
      const ok = await decide(reviewer.secret, fresh, 'approve');
      expect(ok.statusCode, ok.body).toBe(201);
      expect(j(ok).decision.reviewerAuth).toBe(`token:${reviewer.id}`);
      const mine = await decide(authorTok.secret, fresh, 'approve');
      expect(mine.statusCode).toBe(403);
      expect(mine.json().error).toBe('self_approval');
    } finally {
      await setPolicy({ allowTokenApprovals: null });
    }
  });

  it('needs the scope: a token without agents:approve cannot decide at all', async () => {
    const t = await req(tok['rev1']!, 'POST', '/v1/tokens', {
      name: 'ro',
      scopes: ['agents:read'],
    });
    const a = await newAgent(tok['author']!);
    const review = j(await open(tok['author']!, a.id));
    expect((await decide(j(t).token, review, 'approve')).statusCode).toBe(403);
  });

  it.each(['viewer', 'auditor'])('refuses %s at the route (no agents:approve)', async (who) => {
    const a = await newAgent(tok['author']!);
    const review = j(await open(tok['author']!, a.id));
    expect((await decide(tok[who]!, review, 'approve')).statusCode).toBe(403);
  });

  it('keeps developers and operators out by default and lets the tenant widen the list', async () => {
    const a = await newAgent(tok['author']!);
    const review = j(await open(tok['author']!, a.id));
    for (const who of ['dev', 'oper']) {
      const res = await decide(tok[who]!, review, 'approve');
      expect(res.statusCode, who).toBe(403);
      expect(res.json().error, who).toBe('not_eligible');
    }
    await setPolicy({ allowedApproverRoles: ['admin', 'agent-maintainer', 'agent-developer'] });
    try {
      // the review that is already open keeps the roles of its snapshot ...
      expect((await decide(tok['dev']!, review, 'approve')).json().error).toBe('not_eligible');
      // ... one opened afterwards uses the widened list
      const b = await newAgent(tok['author']!);
      const fresh = j(await open(tok['author']!, b.id));
      const ok = await decide(tok['dev']!, fresh, 'approve');
      expect(ok.statusCode, ok.body).toBe(201);
      expect((await decide(tok['oper']!, fresh, 'approve')).json().error).toBe('not_eligible');
    } finally {
      await setPolicy({ allowedApproverRoles: null });
    }
  });

  it('is invisible to a reviewer who cannot read the agent (404, like an unknown review)', async () => {
    const a = await newAgent(tok['author']!);
    const review = j(await open(tok['author']!, a.id));
    const foreign = await decide(adminB, review, 'approve');
    const unknown = await req(adminB, 'POST', `/v1/reviews/${randomUUID()}/decisions`, {
      decision: 'approve',
      expectedDigest: review.revision.digest,
      expectedExpansionDigest: review.digests.expansionDigest,
      expectedResolutionDigest: review.digests.resolutionDigest,
      expectedPolicyDigest: review.digests.policyDigest,
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual(unknown.json());
    expect((await req(adminB, 'GET', `/v1/reviews/${review.id}`)).statusCode).toBe(404);
    expect((await req(adminB, 'POST', `/v1/reviews/${review.id}/withdraw`)).statusCode).toBe(404);
    expect((await req(adminB, 'GET', `/v1/agents/${a.id}/reviews`)).statusCode).toBe(404);
  });

  describe('A4: bindings that a contributor granted', () => {
    it('does not make a reviewer eligible when the grantor wrote the draft (node binding)', async () => {
      await mkUser('made-by-admin2', ['agent-maintainer'], tok['admin2']!);
      const a = await newAgent(tok['admin2']!);
      const review = j(await open(tok['admin2']!, a.id));
      const res = await decide(tok['made-by-admin2']!, review, 'approve');
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('binding_granted_by_contributor');
      // the same person may approve work that the grantor did not touch
      const other = await newAgent(tok['author']!);
      const r2 = j(await open(tok['author']!, other.id));
      expect((await decide(tok['made-by-admin2']!, r2, 'approve')).statusCode).toBe(201);
    });

    it('does not count a team membership that a contributor added, and keeps the grantor of one that stays', async () => {
      await mkUser('team-made', ['viewer']);
      await mkUser('team-kept', ['viewer']);
      const members = [
        { userId: uid['team-kept'], role: 'agent-maintainer' },
        { userId: uid['rev1'], role: 'viewer' },
      ];
      expect(
        (await req(adminA, 'PUT', `/v1/teams/${teamSec}/members`, { members })).statusCode,
      ).toBe(204);
      // a contributor adds one more and re-sends the others
      const withNew = [...members, { userId: uid['team-made'], role: 'agent-maintainer' }];
      expect(
        (await req(tok['admin2']!, 'PUT', `/v1/teams/${teamSec}/members`, { members: withNew }))
          .statusCode,
      ).toBe(204);
      const a = await newAgent(tok['admin2']!);
      const review = j(await open(tok['admin2']!, a.id));
      expect((await decide(tok['team-made']!, review, 'approve')).json().error).toBe(
        'binding_granted_by_contributor',
      );
      // the membership that stayed is still attributed to the administrator who made it
      const ok = await decide(tok['team-kept']!, review, 'approve');
      expect(ok.statusCode, ok.body).toBe(201);
      expect(j(ok).decision.bindingRefs[0]).toMatchObject({
        source: 'team',
        grantedBy: expect.any(String),
      });
      expect(j(ok).decision.bindingRefs[0].grantedBy).not.toBe(uid['admin2']);
    });

    it('does not count an agent binding that a contributor added', async () => {
      await mkUser('agent-bound', ['viewer']);
      const a = await newAgent(tok['admin2']!);
      const put = await req(tok['admin2']!, 'PUT', `/v1/agents/${a.id}/members`, {
        members: [{ userId: uid['agent-bound'], role: 'agent-maintainer' }],
      });
      expect(put.statusCode, put.body).toBe(204);
      const review = j(await open(tok['admin2']!, a.id));
      expect((await decide(tok['agent-bound']!, review, 'approve')).json().error).toBe(
        'binding_granted_by_contributor',
      );
    });
  });

  describe('A7: approver scope', () => {
    it('other-team keeps the members of the agent team out; team keeps everybody else out', async () => {
      await mkUser('inteam', ['viewer']);
      const members = [{ userId: uid['inteam'], role: 'agent-maintainer' }];
      expect(
        (await req(adminA, 'PUT', `/v1/teams/${teamSec}/members`, { members })).statusCode,
      ).toBe(204);
      const a = await newAgent(tok['author']!);
      await setPolicy({ approverScope: 'other-team' });
      const review = j(await open(tok['author']!, a.id));
      try {
        expect((await decide(tok['inteam']!, review, 'approve')).json().error).toBe(
          'approver_scope',
        );
        expect((await decide(tok['rev1']!, review, 'approve')).statusCode).toBe(201);
      } finally {
        await setPolicy({ approverScope: null });
      }
      const b = await newAgent(tok['author']!);
      await setPolicy({ approverScope: 'team' });
      const r2 = j(await open(tok['author']!, b.id));
      try {
        expect((await decide(tok['rev2']!, r2, 'approve')).json().error).toBe('approver_scope');
        expect((await decide(tok['inteam']!, r2, 'approve')).statusCode).toBe(201);
      } finally {
        await setPolicy({ approverScope: null });
        await req(adminA, 'PUT', `/v1/teams/${teamSec}/members`, { members: [] });
      }
    });
  });

  describe('A6: identity source', () => {
    it('lets the tenant exclude local accounts', async () => {
      const a = await newAgent(tok['author']!);
      const review = j(await open(tok['author']!, a.id));
      await setPolicy({ approverIdentitySources: ['oidc', 'ldap'] });
      try {
        const res = await decide(tok['rev1']!, review, 'approve');
        expect(res.statusCode).toBe(403);
        expect(res.json().error).toBe('identity_source_not_allowed');
      } finally {
        await setPolicy({ approverIdentitySources: null });
      }
    });
  });
});

describe('digests, stale views and revisions saved during a review', () => {
  it('refuses a decision on a digest the reviewer did not see (409 stale_view)', async () => {
    const a = await newAgent(tok['author']!);
    const review = j(await open(tok['author']!, a.id));
    const wrong = await req(tok['rev1']!, 'POST', `/v1/reviews/${review.id}/decisions`, {
      decision: 'approve',
      expectedDigest: 'a'.repeat(64),
    });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error).toBe('stale_view');
    for (const k of [
      'expectedExpansionDigest',
      'expectedPolicyDigest',
      'expectedResolutionDigest',
    ]) {
      const res = await decide(tok['rev1']!, review, 'approve', {
        [k]: k === 'expectedExpansionDigest' ? 'x' : 'b'.repeat(64),
      });
      expect(res.statusCode, k).toBe(409);
    }
    // nothing was recorded
    expect(
      await n.ctx.db
        .select()
        .from(agentReviewDecisions)
        .where(eq(agentReviewDecisions.reviewId, review.id)),
    ).toHaveLength(0);
  });

  it('does not tell an ineligible caller that the digest is stale', async () => {
    const a = await newAgent(tok['author']!);
    const review = j(await open(tok['author']!, a.id));
    const res = await req(tok['author']!, 'POST', `/v1/reviews/${review.id}/decisions`, {
      decision: 'approve',
      expectedDigest: 'a'.repeat(64),
    });
    expect(res.json().error).toBe('self_approval');
  });

  it('turns an approval stale when a revision is saved after it, and binds a new one to the new digests', async () => {
    const a = await newAgent(tok['author']!);
    const review = j(await open(tok['author']!, a.id));
    const first = j(await decide(tok['rev1']!, review, 'approve'));
    expect(first.review.state).toBe('approved');
    // the author fixes something after the approval
    expect((await edit(tok['author']!, a, '1.0.1')).statusCode).toBe(200);
    const after = await getReview(tok['rev2']!, review.id);
    expect(after.state).toBe('review_requested');
    expect(after.revision.digest).not.toBe(review.revision.digest);
    expect(after.approvals[0]).toMatchObject({
      counted: false,
      current: false,
      reasons: ['revision_changed'],
    });
    // a decision on the old digest is refused, one on the new digest binds to it
    const old = await req(tok['rev2']!, 'POST', `/v1/reviews/${review.id}/decisions`, {
      decision: 'approve',
      expectedDigest: review.revision.digest,
      expectedExpansionDigest: review.digests.expansionDigest,
      expectedResolutionDigest: review.digests.resolutionDigest,
      expectedPolicyDigest: review.digests.policyDigest,
    });
    expect(old.statusCode).toBe(409);
    const fresh = await decide(tok['rev2']!, after, 'approve');
    expect(fresh.statusCode, fresh.body).toBe(201);
    expect(j(fresh).decision).toMatchObject({
      digest: after.revision.digest,
      revisionId: after.revision.id,
    });
    expect(j(fresh).review.state).toBe('approved');
    const [stale] = await auditActions(a.id, 'agent.review.stale');
    expect(stale!.payload).toMatchObject({
      review: review.id,
      approvals: 1,
      reason: 'revision_changed',
    });
  });

  it('makes the person who saves the new revision a contributor who can no longer approve it', async () => {
    const a = await newAgent(tok['author']!);
    const review = j(await open(tok['author']!, a.id));
    expect((await decide(tok['rev1']!, review, 'approve')).statusCode).toBe(201);
    expect((await edit(tok['rev1']!, a, '1.0.1')).statusCode).toBe(200);
    const current = await getReview(tok['rev2']!, review.id);
    expect(current.contributors).toContain(uid['rev1']);
    expect(current.you.eligible).toBe(true);
    const res = await decide(tok['rev1']!, current, 'approve');
    expect(res.json().error).toBe('self_approval');
  });

  it('computes the same expansion digest for the same content and a different one when the content changes', async () => {
    const a = await newAgent(tok['author']!);
    const b = await newAgent(tok['author']!);
    const ra = j(await open(tok['author']!, a.id));
    const rb = j(await open(tok['author']!, b.id));
    // different names, same grants: the expansion covers grants, not the name
    expect(ra.digests.expansionDigest).toBe(rb.digests.expansionDigest);
    expect(ra.digests.resolutionDigest).toBe(rb.digests.resolutionDigest);
    expect(ra.digests.digest).not.toBe(rb.digests.digest);
    expect(ra.digests.policyDigest).toBe(rb.digests.policyDigest);
  });
});

describe('counting approvals (A2, A8) and the other outcomes', () => {
  it('needs the configured number of distinct approvers, and counts one reviewer once', async () => {
    await setPolicy({ minApprovals: 2 });
    try {
      const a = await newAgent(tok['author']!);
      const review = j(await open(tok['author']!, a.id));
      expect(review.requiredApprovals).toBe(2);
      const one = j(await decide(tok['rev1']!, review, 'approve'));
      expect(one.review.state).toBe('review_requested');
      const again = j(await decide(tok['rev1']!, review, 'approve'));
      expect(again.review.state).toBe('review_requested');
      expect(again.review.approvals.filter((x: Json) => x.counted)).toHaveLength(1);
      const two = j(await decide(tok['rev2']!, review, 'approve'));
      expect(two.review.state).toBe('approved');
    } finally {
      await setPolicy({ minApprovals: null });
    }
  });

  it('keeps the required number at the maximum of the review and the policy', async () => {
    const a = await newAgent(tok['author']!);
    const review = j(await open(tok['author']!, a.id));
    expect(review.requiredApprovals).toBe(1);
    await setPolicy({ minApprovals: 3 });
    try {
      expect((await getReview(tok['rev1']!, review.id)).requiredApprovals).toBe(3);
    } finally {
      await setPolicy({ minApprovals: null });
    }
    expect((await getReview(tok['rev1']!, review.id)).requiredApprovals).toBe(1);
  });

  it('requires a comment to request changes or reject, and a request blocks until the reviewer approves', async () => {
    const a = await newAgent(tok['author']!);
    const review = j(await open(tok['author']!, a.id));
    expect((await decide(tok['rev1']!, review, 'request_changes')).statusCode).toBe(400);
    expect((await decide(tok['rev1']!, review, 'reject', { comment: '   ' })).statusCode).toBe(400);
    expect(
      (await decide(tok['rev1']!, review, 'approve', { comment: 'x'.repeat(10_001) })).statusCode,
    ).toBe(400);
    const blocked = j(
      await decide(tok['rev1']!, review, 'request_changes', {
        comment: 'please fix the owner​ field',
      }),
    );
    expect(blocked.review.state).toBe('changes_requested');
    expect(blocked.decision.comment).toBe('please fix the owner field');
    // another approval does not lift the request
    expect(j(await decide(tok['rev2']!, review, 'approve')).review.state).toBe('changes_requested');
    // the reviewer who asked lifts it by approving
    expect(j(await decide(tok['rev1']!, review, 'approve')).review.state).toBe('approved');
    // comments never reach the audit chain
    const events = await auditActions(a.id);
    expect(JSON.stringify(events)).not.toContain('please fix');
  });

  it('closes the review on reject and refuses every further decision and withdrawal', async () => {
    const a = await newAgent(tok['author']!);
    const review = j(await open(tok['author']!, a.id));
    const rejected = j(await decide(tok['rev1']!, review, 'reject', { comment: 'not this' }));
    expect(rejected.review).toMatchObject({ status: 'rejected', state: 'rejected' });
    const late = await decide(tok['rev2']!, review, 'approve');
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toBe('review_closed');
    expect(
      (await req(tok['author']!, 'POST', `/v1/reviews/${review.id}/withdraw`)).statusCode,
    ).toBe(409);
    const [closed] = await auditActions(a.id, 'agent.review.closed');
    expect(closed!.payload).toMatchObject({ review: review.id, outcome: 'rejected' });
    // a new review can be opened on the same draft
    expect((await open(tok['author']!, a.id)).statusCode).toBe(201);
  });

  it('expires an approval after approvalExpiryHours', async () => {
    await setPolicy({ approvalExpiryHours: 1 });
    try {
      const a = await newAgent(tok['author']!);
      const review = j(await open(tok['author']!, a.id));
      const res = j(await decide(tok['rev1']!, review, 'approve'));
      expect(Date.parse(res.decision.expiresAt) - Date.parse(res.decision.decidedAt)).toBe(
        3_600_000,
      );
      clockOffsetMs = 2 * 3_600_000;
      const later = await getReview(tok['rev2']!, review.id);
      expect(later.state).toBe('review_requested');
      expect(later.approvals[0]).toMatchObject({ counted: false, reasons: ['expired'] });
    } finally {
      clockOffsetMs = 0;
      await setPolicy({ approvalExpiryHours: null });
    }
  });

  it('applies a stricter expiry to an existing approval at once, a looser one never revives it', async () => {
    const a = await newAgent(tok['author']!);
    const review = j(await open(tok['author']!, a.id));
    await decide(tok['rev1']!, review, 'approve');
    clockOffsetMs = 2 * 3_600_000;
    try {
      expect((await getReview(tok['rev2']!, review.id)).state).toBe('approved');
      await setPolicy({ approvalExpiryHours: 1 });
      expect((await getReview(tok['rev2']!, review.id)).state).toBe('review_requested');
    } finally {
      clockOffsetMs = 0;
      await setPolicy({ approvalExpiryHours: null });
    }
  });

  it('drops an approval whose reviewer lost the role, and one whose binding the policy no longer accepts', async () => {
    const a = await newAgent(tok['author']!);
    const review = j(await open(tok['author']!, a.id));
    await mkUser('shortlived', ['agent-maintainer']);
    await decide(tok['shortlived']!, review, 'approve');
    expect((await getReview(tok['rev2']!, review.id)).state).toBe('approved');
    // roles narrowed to admins only: a maintainer's earlier approval no longer counts
    await setPolicy({ allowedApproverRoles: ['admin'] });
    try {
      const v = await getReview(tok['rev2']!, review.id);
      expect(v.state).toBe('review_requested');
      expect(v.approvals[0]).toMatchObject({ counted: false, reasons: ['not_eligible'] });
    } finally {
      await setPolicy({ allowedApproverRoles: null });
    }
    // the maintainer role is taken away
    const patched = await req(adminA, 'PATCH', `/v1/users/${uid['shortlived']}`, {
      globalRoles: ['viewer'],
    });
    expect(patched.statusCode, patched.body).toBe(200);
    const v = await getReview(tok['rev2']!, review.id);
    expect(v.approvals[0]).toMatchObject({ counted: false });
    expect(v.state).toBe('review_requested');
  });

  it('shows the caller whether they may decide, and why not', async () => {
    const a = await newAgent(tok['author']!);
    const review = j(await open(tok['author']!, a.id));
    expect((await getReview(tok['rev1']!, review.id)).you).toEqual({
      eligible: true,
      code: null,
      message: null,
    });
    expect((await getReview(tok['author']!, review.id)).you).toMatchObject({
      eligible: false,
      code: 'self_approval',
    });
    expect((await getReview(tok['dev']!, review.id)).you).toMatchObject({
      eligible: false,
      code: 'not_eligible',
    });
    expect((await getReview(tok['viewer']!, review.id)).you).toMatchObject({ eligible: false });
  });

  it('lists the reviews of an agent, newest first, and pages them', async () => {
    const a = await newAgent(tok['author']!);
    for (let i = 0; i < 3; i++) {
      const r = j(await open(tok['author']!, a.id));
      await req(tok['author']!, 'POST', `/v1/reviews/${r.id}/withdraw`);
    }
    const p1 = j(await req(tok['viewer']!, 'GET', `/v1/agents/${a.id}/reviews?limit=2`));
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toEqual(expect.any(String));
    const p2 = j(
      await req(
        tok['viewer']!,
        'GET',
        `/v1/agents/${a.id}/reviews?limit=2&cursor=${p1.nextCursor}`,
      ),
    );
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    expect(
      (await req(tok['viewer']!, 'GET', `/v1/agents/${a.id}/reviews?cursor=!!`)).statusCode,
    ).toBe(400);
  });
});

describe('withdrawing', () => {
  it('lets the opener or an administrator withdraw, nobody else', async () => {
    const a = await newAgent(tok['author']!);
    const review = j(await open(tok['author']!, a.id));
    expect((await req(tok['rev1']!, 'POST', `/v1/reviews/${review.id}/withdraw`)).statusCode).toBe(
      403,
    );
    expect(
      (await req(tok['viewer']!, 'POST', `/v1/reviews/${review.id}/withdraw`)).statusCode,
    ).toBe(403);
    const byAdmin = await req(adminA, 'POST', `/v1/reviews/${review.id}/withdraw`);
    expect(byAdmin.statusCode, byAdmin.body).toBe(200);
    expect(j(byAdmin)).toMatchObject({
      status: 'withdrawn',
      state: 'withdrawn',
      closedBy: expect.any(String),
    });
    expect((await auditActions(a.id, 'agent.review.closed'))[0]!.payload).toMatchObject({
      outcome: 'withdrawn',
    });
  });

  it('refuses a decision that arrives after the withdrawal, and a withdrawal after a decision is fine', async () => {
    const a = await newAgent(tok['author']!);
    const review = j(await open(tok['author']!, a.id));
    await decide(tok['rev1']!, review, 'approve');
    expect(
      (await req(tok['author']!, 'POST', `/v1/reviews/${review.id}/withdraw`)).statusCode,
    ).toBe(200);
    const late = await decide(tok['rev2']!, review, 'approve');
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toBe('review_closed');
    const rows = await n.ctx.db
      .select()
      .from(agentReviewDecisions)
      .where(eq(agentReviewDecisions.reviewId, review.id));
    expect(rows).toHaveLength(1);
  });

  it('settles a withdrawal and a decision that race: one order or the other, never a decision on an open review after it closed', async () => {
    const a = await newAgent(tok['author']!);
    const review = j(await open(tok['author']!, a.id));
    const [w, d] = await Promise.all([
      req(tok['author']!, 'POST', `/v1/reviews/${review.id}/withdraw`),
      decide(tok['rev1']!, review, 'approve'),
    ]);
    expect(w.statusCode).toBe(200);
    expect([201, 409]).toContain(d.statusCode);
    const [row] = await n.ctx.db.select().from(agentReviews).where(eq(agentReviews.id, review.id));
    expect(row!.status).toBe('withdrawn');
    const decisions = await n.ctx.db
      .select()
      .from(agentReviewDecisions)
      .where(eq(agentReviewDecisions.reviewId, review.id));
    for (const x of decisions)
      expect(x.decidedAt.getTime()).toBeLessThanOrEqual(row!.closedAt!.getTime());
    expect(decisions.length).toBe(d.statusCode === 201 ? 1 : 0);
  });

  it('lets two reviewers decide at the same time without losing either', async () => {
    const a = await newAgent(tok['author']!);
    await setPolicy({ minApprovals: 2 });
    const review = j(await open(tok['author']!, a.id));
    try {
      const [x, y] = await Promise.all([
        decide(tok['rev1']!, review, 'approve'),
        decide(tok['rev2']!, review, 'approve'),
      ]);
      expect([x.statusCode, y.statusCode]).toEqual([201, 201]);
      expect((await getReview(tok['author']!, review.id)).state).toBe('approved');
    } finally {
      await setPolicy({ minApprovals: null });
    }
  });

  it('settles a draft save and a decision that race: the decision binds to the revision it saw or is refused as stale', async () => {
    const a = await newAgent(tok['author']!);
    const review = j(await open(tok['author']!, a.id));
    const [e, d] = await Promise.all([
      edit(tok['coauthor']!, a, '1.0.1'),
      decide(tok['rev1']!, review, 'approve'),
    ]);
    expect(e.statusCode).toBe(200);
    expect([201, 409]).toContain(d.statusCode);
    const decisions = await n.ctx.db
      .select()
      .from(agentReviewDecisions)
      .where(eq(agentReviewDecisions.reviewId, review.id));
    const after = await getReview(tok['rev2']!, review.id);
    expect(after.revision.digest).not.toBe(review.revision.digest);
    for (const x of decisions) {
      // whatever was recorded names the revision it was recorded against, never the new head
      expect(x.revisionId).toBe(review.revision.id);
      expect(x.digest).toBe(review.revision.digest);
    }
    expect(after.approvals.every((x: Json) => !x.counted)).toBe(true);
  });
});

describe('shadow mode of publish', () => {
  it('reports the refusal publish would get without refusing, in the response and the audit entry', async () => {
    const a = await newAgent(tok['author']!);
    const none = await req(tok['author']!, 'POST', `/v1/agents/${a.id}/publish`);
    expect(none.statusCode, none.body).toBe(201);
    expect(j(none).shadow).toMatchObject({
      enforced: false,
      approvalRequired: true,
      wouldRefuse: true,
      reviewId: null,
      reasons: [{ code: 'no_review' }],
    });
    const [published] = await auditActions(a.id, 'agent.published');
    expect(published!.payload.shadow).toMatchObject({ wouldRefuse: true, enforced: false });
    expect(published!.payload.revision).toEqual(expect.any(String));
    const [version] = await n.ctx.db
      .select()
      .from(agentVersions)
      .where(eq(agentVersions.agentId, a.id));
    expect(version!.revisionId).toBe(published!.payload.revision);
  });

  it('would refuse an unapproved review, and would not refuse an approved one', async () => {
    const a = await newAgent(tok['author']!);
    const review = j(await open(tok['author']!, a.id));
    const dry = await req(tok['author']!, 'POST', `/v1/agents/${a.id}/publish`);
    expect(j(dry).shadow).toMatchObject({
      wouldRefuse: true,
      reviewId: review.id,
      state: 'review_requested',
      reasons: [{ code: 'approval_insufficient' }],
    });
    const b = await newAgent(tok['author']!);
    const rb = j(await open(tok['author']!, b.id));
    await decide(tok['rev1']!, rb, 'approve');
    const ok = await req(tok['author']!, 'POST', `/v1/agents/${b.id}/publish`);
    expect(ok.statusCode).toBe(201);
    expect(j(ok).shadow).toMatchObject({ wouldRefuse: false, state: 'approved', reasons: [] });
    const c = await newAgent(tok['author']!);
    const rc = j(await open(tok['author']!, c.id));
    await decide(tok['rev1']!, rc, 'request_changes', { comment: 'no' });
    expect(
      j(await req(tok['author']!, 'POST', `/v1/agents/${c.id}/publish`)).shadow.reasons[0].code,
    ).toBe('changes_requested');
  });

  it('says approval is not required when the policy is off, and for production-only outside production use cases', async () => {
    await setPolicy({ requireApprovalForPublish: 'off' });
    try {
      const a = await newAgent(tok['author']!);
      const res = await req(tok['author']!, 'POST', `/v1/agents/${a.id}/publish`);
      expect(j(res).shadow).toMatchObject({ approvalRequired: false, wouldRefuse: false });
    } finally {
      await setPolicy({ requireApprovalForPublish: null });
    }
    await setPolicy({
      requireApprovalForPublish: 'production-only',
      productionUseCases: ['prod/**'],
    });
    try {
      const plain = await newAgent(tok['author']!);
      expect(
        j(await req(tok['author']!, 'POST', `/v1/agents/${plain.id}/publish`)).shadow
          .approvalRequired,
      ).toBe(false);
      const prod = await newAgent(tok['author']!, 'labels:\n  useCase: prod/support');
      expect(
        j(await req(tok['author']!, 'POST', `/v1/agents/${prod.id}/publish`)).shadow,
      ).toMatchObject({
        approvalRequired: true,
        wouldRefuse: true,
      });
    } finally {
      await setPolicy({ requireApprovalForPublish: null, productionUseCases: null });
    }
  });

  it('does not change what publish does: the version is created either way and a republish stays idempotent', async () => {
    const a = await newAgent(tok['author']!);
    const first = await req(tok['author']!, 'POST', `/v1/agents/${a.id}/publish`);
    const again = await req(tok['author']!, 'POST', `/v1/agents/${a.id}/publish`);
    expect([first.statusCode, again.statusCode]).toEqual([201, 200]);
    expect(j(again).created).toBe(false);
    expect(j(again).shadow).toBeDefined();
  });
});

describe('audit trail', () => {
  it('rate-limits repeated refusals and never writes comment text or sources', async () => {
    const a = await newAgent(tok['author']!);
    const review = j(await open(tok['author']!, a.id));
    for (let i = 0; i < 4; i++) await decide(tok['dev']!, review, 'approve');
    const refused = await auditActions(a.id, 'agent.review.refused');
    expect(refused.filter((e) => e.actor === uid['dev']).length).toBe(1);
    expect(refused[0]!.payload).toEqual({ review: review.id, code: 'not_eligible' });
  });

  it('records the lifecycle of a review in the chain', async () => {
    const a = await newAgent(tok['author']!);
    const review = j(await open(tok['author']!, a.id));
    await decide(tok['rev1']!, review, 'approve');
    await req(tok['author']!, 'POST', `/v1/reviews/${review.id}/withdraw`);
    const actions = (await auditActions(a.id)).map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'agent.created',
        'agent.revision.created',
        'agent.review.opened',
        'agent.review.decided',
        'agent.review.closed',
      ]),
    );
    const bad = await decide(tok['dev']!, review, 'approve');
    expect(bad.statusCode).toBe(409);
  });
});

describe('guards in the database', () => {
  it('stops a closed review, a decision and a revision from being changed', async () => {
    const a = await newAgent(tok['author']!);
    const review = j(await open(tok['author']!, a.id));
    await decide(tok['rev1']!, review, 'approve');
    await expect(
      n.ctx.db
        .update(agentReviewDecisions)
        .set({ decision: 'reject' })
        .where(eq(agentReviewDecisions.reviewId, review.id)),
    ).rejects.toThrow();
    await expect(
      n.ctx.db
        .update(agentReviews)
        .set({ policyDigest: 'f'.repeat(64) })
        .where(eq(agentReviews.id, review.id)),
    ).rejects.toThrow();
    await req(tok['author']!, 'POST', `/v1/reviews/${review.id}/withdraw`);
    await expect(
      n.ctx.db
        .update(agentReviews)
        .set({ status: 'open', closedAt: null })
        .where(and(eq(agentReviews.id, review.id))),
    ).rejects.toThrow();
  });
});
