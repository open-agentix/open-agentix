import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  agentDraftRevisions,
  agentReviewDecisions,
  agentReviews,
  agentVersionDeprecations,
  agentVersions,
  agents,
  auditLog,
  tenantRoleBindings,
  users,
} from '../src/db/schema.js';
import { PG_URL, openPglite, openPostgres, type Sql } from './db-targets.js';
import { insertVersion, testNode, type TestNode } from './helpers.js';

/**
 * ADR 0017 slice S3 (#246): approval is a gate at publish, over HTTP, on the resolver read path
 * (the only path on which approval is enforced). Every refusal has its test, every guard of the gate
 * and of the version rules its mutation check (see the PR). Runs on PGlite and, with
 * OAX_TEST_DATABASE_URL, on a real PostgreSQL, where the races are real.
 */
const PW = 'long-password-123';
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let n: TestNode;
let db: Sql;
let clockOffsetMs = 0;
let adminA: string;
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

const JIRA = {
  transport: 'in-memory',
  tools: {
    get_issue: { access: 'read' },
    search_issues: { access: 'read' },
    list_projects: { access: 'read' },
  },
  profiles: { read: ['get_issue', 'search_issues'] },
};
const PROFILE_TOOLS = '      - { server: jira, profile: read }';

interface TestAgent {
  id: string;
  name: string;
  extra: string;
  tools: string;
}

/** An agents.md source; `extra` goes into the front matter, `tools` into the step (read-only). */
const source = (name: string, version: string, extra = '', tools = '') => `---
apiVersion: openagentix.io/v1alpha1
kind: Agent
name: ${name}
version: ${version}
owner: nobody
${extra}
agents:
  - id: a
    provider: simulated
    model: sim-1
    instructions: Summarise the event.
${tools ? `    access: read-only\n    tools:\n${tools}\n` : ''}---
`;

async function newAgent(by: string, extra = '', tools = ''): Promise<TestAgent> {
  const name = `gate-agent-${++seq}`;
  const res = await req(by, 'POST', '/v1/agents', { source: source(name, '1.0.0', extra, tools) });
  expect(res.statusCode, res.body).toBe(201);
  return { id: j(res).id as string, name, extra, tools };
}
const edit = (by: string, a: TestAgent, version: string, extra = a.extra) =>
  req(by, 'PUT', `/v1/agents/${a.id}/draft`, { source: source(a.name, version, extra, a.tools) });
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
const publish = (by: string, agentId: string, body?: Json) =>
  req(by, 'POST', `/v1/agents/${agentId}/publish`, body);
const publishReview = (by: string, agentId: string, review: Json, extra: Json = {}) =>
  publish(by, agentId, { reviewId: review.id, expectedDigest: review.revision.digest, ...extra });
const setPolicy = async (patch: Json, by = adminA) =>
  req(by, 'PATCH', `/v1/tenants/${orgA}/settings/agent-lifecycle`, patch);
const resetPolicy = async () => {
  const res = await setPolicy({
    requireApprovalForPublish: 'on',
    minApprovals: 1,
    allowedApproverRoles: ['admin', 'agent-maintainer'],
    approvalExpiryHours: null,
    publishBy: 'any-publisher',
    productionUseCases: [],
  });
  expect(res.statusCode, res.body).toBe(200);
};
const audit = async (target: string, action?: string) =>
  (await n.ctx.db.select().from(auditLog).where(eq(auditLog.target, target)).orderBy(auditLog.seq))
    .filter((e) => !action || e.action === action)
    .map((e) => ({ action: e.action, actor: e.actor, payload: e.payload as Json }));
const versionsOf = (agentId: string) =>
  n.ctx.db.select().from(agentVersions).where(eq(agentVersions.agentId, agentId));

/** A new agent with an open review that `rev1` approved; the draft is not changed afterwards. */
async function approved(extra = '', tools = '') {
  const a = await newAgent(tok['author']!, extra, tools);
  const review = await open(tok['author']!, a.id);
  expect((await decide(tok['rev1']!, review)).statusCode).toBe(201);
  return { a, review: await getReview(tok['author']!, review.id) };
}

beforeAll(async () => {
  db = PG_URL ? await openPostgres() : await openPglite();
  n = await testNode(
    {
      OAX_DATABASE_URL: db.url,
      OAX_LIFECYCLE_REQUIRE_APPROVAL: 'on',
      OAX_ROLE_BINDINGS_READ: 'bindings',
      OAX_RATE_LIMIT_LOGIN_MAX: '1000',
    },
    { now: () => new Date(Date.now() + clockOffsetMs) },
  );
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
  await mkUser('admin2', ['admin']);
  const c = await req(adminA, 'POST', '/v1/connections', { name: 'jira', config: JIRA });
  expect(c.statusCode, c.body).toBe(201);
}, 120_000);
afterAll(async () => {
  await n?.close();
  await db?.close();
});

describe('the gate: what publish needs where approval is required', () => {
  it('refuses a publish that names no review, one that names half of it, and says what is missing', async () => {
    const a = await newAgent(tok['author']!);
    const none = await publish(tok['author']!, a.id);
    expect(none.statusCode, none.body).toBe(409);
    expect(j(none)).toMatchObject({
      error: 'approval_required',
      details: { missing: ['reviewId', 'expectedDigest'] },
    });
    const review = await open(tok['author']!, a.id);
    const noDigest = await publish(tok['author']!, a.id, { reviewId: review.id });
    expect(j(noDigest)).toMatchObject({
      error: 'approval_required',
      details: { missing: ['expectedDigest'] },
    });
    const noReview = await publish(tok['author']!, a.id, {
      expectedDigest: review.revision.digest,
    });
    expect(j(noReview)).toMatchObject({
      error: 'approval_required',
      details: { missing: ['reviewId'] },
    });
    expect(await versionsOf(a.id)).toHaveLength(0);
    // the refusal is audited, once per agent, user and code and minute
    expect(await audit(a.id, 'agent.publish.refused')).toHaveLength(1);
  });

  it('refuses a review that is not approved, with the count and the reasons', async () => {
    const a = await newAgent(tok['author']!);
    const review = await open(tok['author']!, a.id);
    const res = await publishReview(tok['author']!, a.id, review);
    expect(res.statusCode, res.body).toBe(409);
    expect(j(res)).toMatchObject({
      error: 'approval_insufficient',
      details: { required: 1, counted: 0, changesRequested: false },
    });
    expect(await versionsOf(a.id)).toHaveLength(0);
    expect((await getReview(tok['author']!, review.id)).status).toBe('open');
  });

  it('refuses while a reviewer asks for changes, although another reviewer approved', async () => {
    const a = await newAgent(tok['author']!);
    const review = await open(tok['author']!, a.id);
    await decide(tok['rev1']!, review);
    await decide(tok['rev2']!, review, 'request_changes');
    const res = await publishReview(tok['author']!, a.id, review);
    expect(res.statusCode).toBe(409);
    expect(j(res)).toMatchObject({
      error: 'approval_insufficient',
      details: { changesRequested: true },
    });
  });

  it('refuses a review of another agent, a closed review and an unknown one', async () => {
    const { a: other, review: otherReview } = await approved();
    const a = await newAgent(tok['author']!);
    await open(tok['author']!, a.id);
    const wrong = await publish(tok['author']!, a.id, {
      reviewId: otherReview.id,
      expectedDigest: otherReview.revision.digest,
    });
    expect(wrong.statusCode, wrong.body).toBe(409);
    expect(j(wrong).error).toBe('review_closed');
    expect((await publishReview(tok['author']!, other.id, otherReview)).statusCode).toBe(201);
    // the review is published now: it cannot publish again
    const again = await publish(tok['author']!, other.id, {
      reviewId: otherReview.id,
      expectedDigest: otherReview.revision.digest,
    });
    expect([200, 409]).toContain(again.statusCode);
    const unknown = await publish(tok['author']!, a.id, {
      reviewId: randomUUID(),
      expectedDigest: otherReview.revision.digest,
    });
    expect(unknown.statusCode).toBe(409);
  });

  it('publishes an approved review: version, approval record, review closed, audit', async () => {
    const { a, review } = await approved();
    const res = await publishReview(tok['author']!, a.id, review);
    expect(res.statusCode, res.body).toBe(201);
    const body = j(res);
    expect(body.approval).toMatchObject({ reviewId: review.id, approvedBy: [uid['rev1']] });
    expect(body.version).toMatchObject({ reviewId: review.id, deprecated: null });
    const [v] = await versionsOf(a.id);
    expect(v).toMatchObject({
      reviewId: review.id,
      approvedBy: [uid['rev1']],
      policyDigest: review.digests.policyDigest,
      expansionDigest: review.digests.expansionDigest,
      resolutionDigest: review.digests.resolutionDigest,
      secretResolution: [],
    });
    // published from the revision's source
    const [rev] = await n.ctx.db
      .select()
      .from(agentDraftRevisions)
      .where(eq(agentDraftRevisions.id, review.revision.id));
    expect(v!.revisionId).toBe(rev!.id);
    expect(v!.source).toBe(rev!.source);
    const closed = await getReview(tok['author']!, review.id);
    expect(closed).toMatchObject({ status: 'published', state: 'published' });
    const [row] = await n.ctx.db.select().from(agentReviews).where(eq(agentReviews.id, review.id));
    expect(row).toMatchObject({ publishedVersionId: v!.id, closedBy: uid['author'] });
    const [published] = await audit(a.id, 'agent.published');
    expect(published!.payload).toMatchObject({
      review: review.id,
      approved: true,
      approvedBy: [uid['rev1']],
      policyDigest: review.digests.policyDigest,
    });
    expect(await audit(a.id, 'agent.review.closed')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ outcome: 'published' }) }),
    ]);
    expect((await n.services.audit.verify()).valid).toBe(true);
    // idempotent: the same content again creates nothing and needs nothing
    const again = await publish(tok['author']!, a.id);
    expect(again.statusCode).toBe(200);
    expect(j(again).created).toBe(false);
    expect(await versionsOf(a.id)).toHaveLength(1);
  });

  it('lets a new review start after a publish, against the published version', async () => {
    const { a, review } = await approved();
    await publishReview(tok['author']!, a.id, review);
    expect((await edit(tok['author']!, a, '1.0.1')).statusCode).toBe(200);
    const second = await open(tok['author']!, a.id);
    expect(second.baseVersion).toMatchObject({ version: '1.0.0' });
  });
});

describe('what changes between the approval and the publish', () => {
  it('draft changed: a stale digest is draft_changed, the new digest finds the approval stale', async () => {
    const { a, review } = await approved();
    expect((await edit(tok['author']!, a, '1.0.1')).statusCode).toBe(200);
    const old = await publishReview(tok['author']!, a.id, review);
    expect(old.statusCode, old.body).toBe(409);
    expect(j(old).error).toBe('draft_changed');
    const head = await getReview(tok['author']!, review.id);
    const fresh = await publishReview(tok['author']!, a.id, head);
    expect(fresh.statusCode).toBe(409);
    expect(j(fresh)).toMatchObject({ error: 'approval_insufficient', details: { counted: 0 } });
    expect(j(fresh).details.approvals[0].reasons).toContain('revision_changed');
    expect(await versionsOf(a.id)).toHaveLength(0);
  });

  it('expansion changed: a profile that widened after the approval is approval_stale', async () => {
    const a = await newAgent(tok['author']!, '', PROFILE_TOOLS);
    const review = await open(tok['author']!, a.id);
    expect((await decide(tok['rev1']!, review)).statusCode).toBe(201);
    const current = await getReview(tok['author']!, review.id);
    // the connection widens its `read` profile with one more read tool
    const conn = j(await req(adminA, 'GET', '/v1/connections')).items.find(
      (c: Json) => c.name === 'jira',
    );
    const widen = (profiles: Record<string, string[]>) =>
      req(adminA, 'PUT', `/v1/connections/${conn.id}`, { config: { ...JIRA, profiles } });
    expect(
      (await widen({ read: ['get_issue', 'search_issues', 'list_projects'] })).statusCode,
    ).toBe(200);
    try {
      const res = await publishReview(tok['author']!, a.id, current);
      expect(res.statusCode, res.body).toBe(409);
      expect(j(res)).toMatchObject({
        error: 'approval_stale',
        details: { reason: 'expansion_changed' },
      });
      expect(await versionsOf(a.id)).toHaveLength(0);
    } finally {
      await widen(JIRA.profiles);
    }
    // restoring the profile does not revive the approval: the connection is a new version of itself
    // and the reviewer approved the expansion of the old one
    const still = await publishReview(tok['author']!, a.id, current);
    expect(j(still)).toMatchObject({
      error: 'approval_stale',
      details: { reason: 'expansion_changed' },
    });
  });

  it('secret resolution changed: an approval bound to another resolution is approval_stale', async () => {
    const { a, review } = await approved();
    // A later decision of the same reviewer that bound to another resolution digest (what the
    // resolution looks like once secret scopes exist, ADR 0017 S4): the latest decision counts.
    const [d] = await n.ctx.db
      .select()
      .from(agentReviewDecisions)
      .where(eq(agentReviewDecisions.reviewId, review.id));
    await n.ctx.db.insert(agentReviewDecisions).values({
      ...d!,
      id: randomUUID(),
      resolutionDigest: 'f'.repeat(64),
      decidedAt: new Date(d!.decidedAt.getTime() + 1000),
    });
    const res = await publishReview(tok['author']!, a.id, review);
    expect(res.statusCode, res.body).toBe(409);
    expect(j(res)).toMatchObject({
      error: 'approval_stale',
      details: { reason: 'secret_resolution_changed' },
    });
    expect(await versionsOf(a.id)).toHaveLength(0);
  });

  it('approval expired', async () => {
    await setPolicy({ approvalExpiryHours: 1 });
    try {
      const { a, review } = await approved();
      clockOffsetMs = 2 * 3_600_000;
      try {
        const res = await publishReview(tok['author']!, a.id, review);
        expect(res.statusCode, res.body).toBe(409);
        expect(j(res).error).toBe('approval_insufficient');
        expect(j(res).details.approvals[0].reasons).toContain('expired');
      } finally {
        clockOffsetMs = 0;
      }
      expect((await publishReview(tok['author']!, a.id, review)).statusCode).toBe(201);
    } finally {
      await resetPolicy();
    }
  });

  it('binding revoked: the reviewer lost the approver role', async () => {
    await mkUser('shortlived', ['agent-maintainer']);
    const a = await newAgent(tok['author']!);
    const review = await open(tok['author']!, a.id);
    await decide(tok['shortlived']!, review);
    const patched = await req(adminA, 'PATCH', `/v1/users/${uid['shortlived']}`, {
      globalRoles: ['viewer'],
    });
    expect(patched.statusCode, patched.body).toBe(200);
    const res = await publishReview(tok['author']!, a.id, review);
    expect(res.statusCode, res.body).toBe(409);
    expect(j(res).error).toBe('approval_insufficient');
    expect(j(res).details.approvals[0].reasons).toEqual(['not_eligible']);
  });

  it('policy tightened: more approvals, fewer roles, shorter expiry', async () => {
    const { a, review } = await approved();
    await setPolicy({ minApprovals: 2 });
    try {
      const res = await publishReview(tok['author']!, a.id, review);
      expect(res.statusCode, res.body).toBe(409);
      expect(j(res)).toMatchObject({
        error: 'approval_insufficient',
        details: { required: 2, counted: 1 },
      });
    } finally {
      await resetPolicy();
    }
    await setPolicy({ allowedApproverRoles: ['admin'] });
    try {
      const res = await publishReview(tok['author']!, a.id, review);
      expect(res.statusCode).toBe(409);
      expect(j(res).details.approvals[0].reasons).toEqual(['not_eligible']);
    } finally {
      await resetPolicy();
    }
    expect((await publishReview(tok['author']!, a.id, review)).statusCode).toBe(201);
  });

  it('policy loosened: switching approval off does not let the publisher skip an open review', async () => {
    const a = await newAgent(tok['author']!);
    const review = await open(tok['author']!, a.id);
    // a clean administrator (not a contributor) loosens
    expect((await setPolicy({ requireApprovalForPublish: 'off' }, tok['admin2']!)).statusCode).toBe(
      200,
    );
    try {
      const res = await publish(tok['author']!, a.id);
      expect(res.statusCode, res.body).toBe(409);
      expect(j(res).error).toBe('approval_required');
      const named = await publishReview(tok['author']!, a.id, review);
      expect(j(named).error).toBe('approval_insufficient');
    } finally {
      await resetPolicy();
    }
  });

  it('chain taint after the approval: the approver was made by somebody who contributed', async () => {
    const { a, review } = await approved();
    // the approver's account now has a contributor in its stored creator chain
    const [before] = await n.ctx.db.select().from(users).where(eq(users.id, uid['rev1']!));
    await n.ctx.db
      .update(users)
      .set({ grantChain: [...(before!.grantChain ?? []), uid['author']!] })
      .where(eq(users.id, uid['rev1']!));
    try {
      const res = await publishReview(tok['author']!, a.id, review);
      expect(res.statusCode, res.body).toBe(409);
      expect(j(res).details.approvals[0].reasons).toEqual(['binding_granted_by_contributor']);
    } finally {
      await n.ctx.db
        .update(users)
        .set({ grantChain: before!.grantChain })
        .where(eq(users.id, uid['rev1']!));
    }
  });

  it('unknown grantor after the approval: refused, unless the installation allows it', async () => {
    const { a, review } = await approved();
    await n.ctx.db
      .update(tenantRoleBindings)
      .set({ grantorUnknown: true })
      .where(eq(tenantRoleBindings.userId, uid['rev1']!));
    const config = n.ctx.config.lifecycle as { unknownGrantor: 'refuse' | 'allow' };
    try {
      const res = await publishReview(tok['author']!, a.id, review);
      expect(res.statusCode, res.body).toBe(409);
      expect(j(res).details.approvals[0].reasons).toEqual(['binding_grantor_unknown']);
      config.unknownGrantor = 'allow';
      expect((await publishReview(tok['author']!, a.id, review)).statusCode).toBe(201);
    } finally {
      config.unknownGrantor = 'refuse';
      await n.ctx.db
        .update(tenantRoleBindings)
        .set({ grantorUnknown: false })
        .where(eq(tenantRoleBindings.userId, uid['rev1']!));
    }
  });
});

describe('the state is read under the lock, not before it', () => {
  /**
   * Runs `action` once, right after publish has read the connection catalog and before it takes its
   * locks: the window in which every pre-lock check of publish is already behind it.
   */
  function afterPreLockChecks(action: () => Promise<unknown>) {
    const catalog = n.services.catalog;
    const original = catalog.accessCatalog.bind(catalog);
    catalog.accessCatalog = async (scope) => {
      const result = await original(scope);
      catalog.accessCatalog = original;
      await action();
      return result;
    };
    return () => {
      catalog.accessCatalog = original;
    };
  }

  it('a draft saved after the checks: draft_changed, nothing published, the review stays open', async () => {
    const { a, review } = await approved();
    const restore = afterPreLockChecks(() => edit(tok['rev2']!, a, '1.0.1'));
    try {
      const res = await publishReview(tok['author']!, a.id, review);
      expect(res.statusCode, res.body).toBe(409);
      expect(j(res).error).toBe('draft_changed');
    } finally {
      restore();
    }
    expect(await versionsOf(a.id)).toHaveLength(0);
    expect((await getReview(tok['author']!, review.id)).status).toBe('open');
  });

  it('the same review published meanwhile: the second publish creates nothing', async () => {
    const { a, review } = await approved();
    const restore = afterPreLockChecks(() => publishReview(tok['rev1']!, a.id, review));
    try {
      const res = await publishReview(tok['author']!, a.id, review);
      expect(res.statusCode, res.body).toBe(409);
      expect(j(res).error).toBe('draft_changed');
    } finally {
      restore();
    }
    expect(await versionsOf(a.id)).toHaveLength(1);
  });

  it('a request for changes that arrives after the checks stops the publish', async () => {
    const { a, review } = await approved();
    const restore = afterPreLockChecks(() => decide(tok['rev2']!, review, 'request_changes'));
    try {
      const res = await publishReview(tok['author']!, a.id, review);
      expect(res.statusCode, res.body).toBe(409);
      expect(j(res)).toMatchObject({
        error: 'approval_insufficient',
        details: { changesRequested: true },
      });
    } finally {
      restore();
    }
    expect(await versionsOf(a.id)).toHaveLength(0);
  });

  it('a role revoked after the checks stops the publish', async () => {
    await mkUser('lateflip', ['agent-maintainer']);
    const a = await newAgent(tok['author']!);
    const review = await open(tok['author']!, a.id);
    await decide(tok['lateflip']!, review);
    const restore = afterPreLockChecks(() =>
      req(adminA, 'PATCH', `/v1/users/${uid['lateflip']}`, { globalRoles: ['viewer'] }),
    );
    try {
      const res = await publishReview(tok['author']!, a.id, review);
      expect(res.statusCode, res.body).toBe(409);
      expect(j(res).details.approvals[0].reasons).toEqual(['not_eligible']);
    } finally {
      restore();
    }
    expect(await versionsOf(a.id)).toHaveLength(0);
  });

  it('a policy tightened after the checks applies', async () => {
    const { a, review } = await approved();
    const restore = afterPreLockChecks(() => setPolicy({ minApprovals: 2 }));
    try {
      const res = await publishReview(tok['author']!, a.id, review);
      expect(res.statusCode, res.body).toBe(409);
      expect(j(res).details).toMatchObject({ required: 2, counted: 1 });
    } finally {
      restore();
      await resetPolicy();
    }
    expect(await versionsOf(a.id)).toHaveLength(0);
  });
});

describe('who publishes, and the policy keys that decide when approval is needed', () => {
  it('publishBy approver-only: only an approver of the review publishes', async () => {
    const { a, review } = await approved();
    await setPolicy({ publishBy: 'approver-only' });
    try {
      const res = await publishReview(tok['author']!, a.id, review);
      expect(res.statusCode, res.body).toBe(403);
      expect(j(res).error).toBe('publisher_not_approver');
      expect(await versionsOf(a.id)).toHaveLength(0);
      const ok = await publishReview(tok['rev1']!, a.id, review);
      expect(ok.statusCode, ok.body).toBe(201);
    } finally {
      await resetPolicy();
    }
  });

  it('production-only uses the union of the base and the draft use case', async () => {
    await setPolicy({
      requireApprovalForPublish: 'production-only',
      productionUseCases: ['prod/**'],
    });
    try {
      // not production: no approval needed
      const plain = await newAgent(tok['author']!);
      const ok = await publish(tok['author']!, plain.id);
      expect(ok.statusCode, ok.body).toBe(201);
      expect(j(ok).approval).toBeNull();
      // a draft in a production use case needs it
      const prod = await newAgent(tok['author']!, 'labels:\n  useCase: prod/support');
      const refused = await publish(tok['author']!, prod.id);
      expect(j(refused).error).toBe('approval_required');
      // a published production agent relabelled out of production still needs it (union with the base)
      const base = await newAgent(tok['author']!, 'labels:\n  useCase: prod/billing');
      await insertVersion(n, base.id);
      await n.ctx.db.update(agents).set({ useCase: 'prod/billing' }).where(eq(agents.id, base.id));
      expect(
        (await edit(tok['author']!, base, '1.0.1', 'labels:\n  useCase: sandbox/x')).statusCode,
      ).toBe(200);
      const relabelled = await publish(tok['author']!, base.id);
      expect(relabelled.statusCode, relabelled.body).toBe(409);
      expect(j(relabelled).error).toBe('approval_required');
    } finally {
      await resetPolicy();
    }
  });

  it('with approval off, publish needs nothing and closes an advisory review without an approval record', async () => {
    await setPolicy({ requireApprovalForPublish: 'off' });
    try {
      const a = await newAgent(tok['author']!);
      const review = await open(tok['author']!, a.id);
      const res = await publish(tok['author']!, a.id);
      expect(res.statusCode, res.body).toBe(201);
      expect(j(res).approval).toBeNull();
      const [v] = await versionsOf(a.id);
      expect(v).toMatchObject({ reviewId: null, approvedBy: null });
      const [row] = await n.ctx.db
        .select()
        .from(agentReviews)
        .where(eq(agentReviews.id, review.id));
      expect(row).toMatchObject({ status: 'published', publishedVersionId: v!.id });
    } finally {
      await resetPolicy();
    }
  });
});

describe('no break-glass', () => {
  it('has no route, parameter or body field that skips the approvals', async () => {
    const routes = n.app.printRoutes({ commonPrefix: false });
    expect(routes).not.toMatch(/break|glass|bypass|emergency|ratif|override|force|skip/i);
    const a = await newAgent(tok['author']!);
    for (const body of [
      { force: true },
      { breakGlass: true },
      { skipApproval: true },
      { bypass: true, reviewId: randomUUID() },
    ]) {
      const res = await publish(tok['author']!, a.id, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    // a query string changes nothing either
    const q = await n.req({
      method: 'POST',
      url: `/v1/agents/${a.id}/publish?force=true&bypass=1&breakGlass=true`,
      token: tok['author']!,
    });
    expect(q.statusCode).toBe(409);
    expect(j(q).error).toBe('approval_required');
    // not even a platform administrator or the organisation administrator
    const named = { reviewId: randomUUID(), expectedDigest: 'a'.repeat(64) };
    for (const t of [adminA, tok['admin2']!]) {
      expect((await publish(t, a.id, named)).statusCode).toBe(409);
    }
    const operator = await n.req({
      method: 'POST',
      url: `/v1/agents/${a.id}/publish`,
      token: n.admin,
      headers: { 'x-oax-tenant': orgA },
      payload: named,
    });
    expect(operator.statusCode, operator.body).toBe(409);
    expect(await versionsOf(a.id)).toHaveLength(0);
  });

  it('refuses the demo seed path for any agent that is not a seeded one', async () => {
    const a = await newAgent(tok['author']!);
    const principal = { userId: uid['admin2']!, tenantId: orgA } as never;
    await expect(n.services.agents.publishDemoSeed(principal, a.id)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(await versionsOf(a.id)).toHaveLength(0);
  });
});

describe('version deprecation and rollback', () => {
  /** Publishes an approved version `version` of the agent (draft edited to it first when needed). */
  async function publishApproved(a: TestAgent, version: string) {
    if (version !== '1.0.0') expect((await edit(tok['author']!, a, version)).statusCode).toBe(200);
    const review = await open(tok['author']!, a.id);
    expect((await decide(tok['rev1']!, review)).statusCode).toBe(201);
    const res = await publishReview(
      tok['author']!,
      a.id,
      await getReview(tok['author']!, review.id),
    );
    expect(res.statusCode, res.body).toBe(201);
    return j(res).version as Json;
  }
  const deprecate = (agentId: string, version: string, by = tok['author']!, body?: Json) =>
    req(by, 'POST', `/v1/agents/${agentId}/versions/${version}/deprecate`, body);
  const latest = async (agentId: string) =>
    (await n.ctx.db.select().from(agents).where(eq(agents.id, agentId)))[0]!;

  it('rolls back to the newest approved version: no new version, no approval, audited', async () => {
    const a = await newAgent(tok['author']!);
    const v1 = await publishApproved(a, '1.0.0');
    const v2 = await publishApproved(a, '1.1.0');
    expect((await latest(a.id)).latestVersion).toBe('1.1.0');
    const res = await deprecate(a.id, '1.1.0', tok['author']!, { reason: 'bad output' });
    expect(res.statusCode, res.body).toBe(200);
    expect(j(res)).toMatchObject({ version: '1.1.0', rollbackTo: { id: v1.id, version: '1.0.0' } });
    expect(await versionsOf(a.id)).toHaveLength(2);
    expect(await latest(a.id)).toMatchObject({ latestVersionId: v1.id, latestVersion: '1.0.0' });
    const [dep] = await n.ctx.db
      .select()
      .from(agentVersionDeprecations)
      .where(eq(agentVersionDeprecations.versionId, v2.id));
    expect(dep).toMatchObject({
      deprecatedBy: uid['author'],
      reason: 'bad output',
      rollbackToVersionId: v1.id,
    });
    const [entry] = await audit(a.id, 'agent.version.deprecated');
    expect(entry!.payload).toMatchObject({ version: '1.1.0', rollbackTo: '1.0.0' });
    expect((await n.services.audit.verify()).valid).toBe(true);
    const list = j(await req(tok['author']!, 'GET', `/v1/agents/${a.id}/versions`)).items as Json[];
    expect(list.find((v) => v.version === '1.1.0')!.deprecated).toMatchObject({
      rollbackTo: v1.id,
    });
    expect(list.find((v) => v.version === '1.0.0')!.deprecated).toBeNull();
  });

  it('refuses new runs pinned to a deprecated version and runs the rolled-back one otherwise', async () => {
    const a = await newAgent(tok['author']!);
    await publishApproved(a, '1.0.0');
    await publishApproved(a, '1.1.0');
    await deprecate(a.id, '1.1.0');
    const pinned = await req(tok['author']!, 'POST', `/v1/agents/${a.id}/runs`, {
      data: {},
      version: '1.1.0',
    });
    expect(pinned.statusCode, pinned.body).toBe(409);
    expect(j(pinned).error).toBe('version_deprecated');
    const unpinned = await req(tok['author']!, 'POST', `/v1/agents/${a.id}/runs`, { data: {} });
    expect(unpinned.statusCode, unpinned.body).toBe(202);
    const old = await req(tok['author']!, 'POST', `/v1/agents/${a.id}/runs`, {
      data: {},
      version: '1.0.0',
    });
    expect(old.statusCode).toBe(202);
  });

  it('deprecating an older version only marks it; deprecating twice is refused', async () => {
    const a = await newAgent(tok['author']!);
    const v1 = await publishApproved(a, '1.0.0');
    await publishApproved(a, '1.1.0');
    const res = await deprecate(a.id, '1.0.0');
    expect(res.statusCode, res.body).toBe(200);
    expect(j(res).rollbackTo).toBeNull();
    expect((await latest(a.id)).latestVersion).toBe('1.1.0');
    const again = await deprecate(a.id, '1.0.0');
    expect(again.statusCode).toBe(409);
    expect(j(again).error).toBe('already_deprecated');
    expect(v1.id).toBeDefined();
  });

  it('refuses a rollback when there is nothing to go back to', async () => {
    const a = await newAgent(tok['author']!);
    await publishApproved(a, '1.0.0');
    const res = await deprecate(a.id, '1.0.0');
    expect(res.statusCode, res.body).toBe(409);
    expect(j(res).error).toBe('no_rollback_target');
    expect((await latest(a.id)).latestVersion).toBe('1.0.0');
    expect(
      await n.ctx.db
        .select()
        .from(agentVersionDeprecations)
        .where(eq(agentVersionDeprecations.agentId, a.id)),
    ).toHaveLength(0);
  });

  it('goes back only to a version published under an approved review where approval is required', async () => {
    const a = await newAgent(tok['author']!);
    // 1.0.0 was published while approval was off (no review), 1.1.0 under approval
    await setPolicy({ requireApprovalForPublish: 'off' });
    try {
      expect((await publish(tok['author']!, a.id)).statusCode).toBe(201);
    } finally {
      await resetPolicy();
    }
    await publishApproved(a, '1.1.0');
    const refused = await deprecate(a.id, '1.1.0');
    expect(refused.statusCode, refused.body).toBe(409);
    expect(j(refused).error).toBe('rollback_target_unapproved');
    expect((await latest(a.id)).latestVersion).toBe('1.1.0');
    // with approval off today the unapproved version is a fine target
    await setPolicy({ requireApprovalForPublish: 'off' });
    try {
      const ok = await deprecate(a.id, '1.1.0');
      expect(ok.statusCode, ok.body).toBe(200);
      expect(j(ok).rollbackTo.version).toBe('1.0.0');
    } finally {
      await resetPolicy();
    }
  });

  it('skips an unapproved newer version and a deprecated one when choosing the target', async () => {
    const a = await newAgent(tok['author']!);
    await publishApproved(a, '1.0.0');
    await publishApproved(a, '1.1.0');
    // 1.2.0 without a review (as if published before S3), 1.3.0 approved
    await edit(tok['author']!, a, '1.2.0');
    await insertVersion(n, a.id, { setLatest: false });
    await publishApproved(a, '1.3.0');
    const res = await deprecate(a.id, '1.3.0');
    expect(res.statusCode, res.body).toBe(200);
    expect(j(res).rollbackTo.version).toBe('1.1.0');
  });

  it('needs agents:publish, and is hidden from those who cannot read the agent', async () => {
    const a = await newAgent(tok['author']!);
    await publishApproved(a, '1.0.0');
    await mkUser('viewer1', ['viewer']);
    expect((await deprecate(a.id, '1.0.0', tok['viewer1']!)).statusCode).toBe(403);
    expect((await deprecate(randomUUID(), '1.0.0')).statusCode).toBe(404);
    expect((await deprecate(a.id, '9.9.9')).statusCode).toBe(404);
    expect(
      (await deprecate(a.id, '1.0.0', tok['author']!, { reason: 'x'.repeat(501) })).statusCode,
    ).toBe(400);
  });

  it('does not hand out a deprecated version again: the same content is version_deprecated, a higher version publishes', async () => {
    const a = await newAgent(tok['author']!);
    await publishApproved(a, '1.0.0');
    await publishApproved(a, '1.1.0');
    await deprecate(a.id, '1.1.0');
    // the draft is still the content of 1.1.0
    const same = await publish(tok['author']!, a.id);
    expect(same.statusCode, same.body).toBe(409);
    expect(j(same).error).toBe('version_deprecated');
    // an older number cannot be published again either
    expect((await edit(tok['author']!, a, '1.0.5')).statusCode).toBe(200);
    const review = await open(tok['author']!, a.id);
    await decide(tok['rev1']!, review);
    const low = await publishReview(
      tok['author']!,
      a.id,
      await getReview(tok['author']!, review.id),
    );
    expect(low.statusCode).toBe(409);
    expect(j(low).error).toBe('version_not_increasing');
  });
});

describe('rollback details', () => {
  async function approvedVersion(a: TestAgent, version: string) {
    if (version !== '1.0.0') expect((await edit(tok['author']!, a, version)).statusCode).toBe(200);
    const review = await open(tok['author']!, a.id);
    await decide(tok['rev1']!, review);
    const res = await publishReview(
      tok['author']!,
      a.id,
      await getReview(tok['author']!, review.id),
    );
    expect(res.statusCode, res.body).toBe(201);
    return j(res).version as Json;
  }

  it('an agent whose cached latest version was deprecated elsewhere still runs the rolled-back one', async () => {
    const a = await newAgent(tok['author']!);
    const v1 = await approvedVersion(a, '1.0.0');
    const v2 = await approvedVersion(a, '1.1.0');
    const dep = await req(tok['author']!, 'POST', `/v1/agents/${a.id}/versions/1.1.0/deprecate`);
    expect(dep.statusCode, dep.body).toBe(200);
    // another replica still caches v2 as the latest version
    await n.ctx.cache.set(
      `agent-latest:${a.id}`,
      { versionId: v2.id, teamId: null, tenantId: orgA },
      60_000,
    );
    const run = await req(tok['author']!, 'POST', `/v1/agents/${a.id}/runs`, { data: {} });
    expect(run.statusCode, run.body).toBe(202);
    expect(j(run).agentVersionId).toBe(v1.id);
  });

  it('production-only: leaving a production version needs an approved target even if the target is not production', async () => {
    await setPolicy({
      requireApprovalForPublish: 'production-only',
      productionUseCases: ['prod/**'],
    });
    try {
      const a = await newAgent(tok['author']!, 'labels:\n  useCase: sandbox/x');
      // 1.0.0: sandbox, no review (approval was not required); 1.1.0: production, approved
      expect((await publish(tok['author']!, a.id)).statusCode).toBe(201);
      expect(
        (await edit(tok['author']!, a, '1.1.0', 'labels:\n  useCase: prod/x')).statusCode,
      ).toBe(200);
      const review = await open(tok['author']!, a.id);
      await decide(tok['rev1']!, review);
      const pub = await publishReview(
        tok['author']!,
        a.id,
        await getReview(tok['author']!, review.id),
      );
      expect(pub.statusCode, pub.body).toBe(201);
      const res = await req(tok['author']!, 'POST', `/v1/agents/${a.id}/versions/1.1.0/deprecate`);
      expect(res.statusCode, res.body).toBe(409);
      expect(j(res).error).toBe('rollback_target_unapproved');
    } finally {
      await resetPolicy();
    }
  });
});

describe('races (real PostgreSQL)', () => {
  const real = PG_URL ? it : it.skip;

  real(
    'a draft saved while the publish runs is never published: the version is the approved digest',
    async () => {
      for (let i = 0; i < 6; i++) {
        const { a, review } = await approved();
        const [pub, save] = await Promise.all([
          publishReview(tok['author']!, a.id, review),
          edit(tok['rev2']!, a, '1.0.1'),
        ]);
        expect(save.statusCode, save.body).toBe(200);
        const versions = await versionsOf(a.id);
        if (pub.statusCode === 201) {
          expect(versions).toHaveLength(1);
          expect(versions[0]!.digest).toBe(review.revision.digest);
        } else {
          expect(pub.statusCode, pub.body).toBe(409);
          expect(versions).toHaveLength(0);
        }
        // either way the version, if any, is of the approved revision and the save is a revision after it
        const revs = await n.ctx.db
          .select()
          .from(agentDraftRevisions)
          .where(eq(agentDraftRevisions.agentId, a.id))
          .orderBy(desc(agentDraftRevisions.seq));
        expect(revs[0]!.digest).not.toBe(review.revision.digest);
      }
    },
  );

  real(
    'a request for changes and a publish race: the publish never wins over a decision that came first',
    async () => {
      for (let i = 0; i < 6; i++) {
        const { a, review } = await approved();
        const [pub, dec] = await Promise.all([
          publishReview(tok['author']!, a.id, review),
          decide(tok['rev2']!, review, 'request_changes'),
        ]);
        if (pub.statusCode === 201) {
          expect(dec.statusCode, dec.body).toBe(409);
          expect(j(dec).error).toBe('review_closed');
        } else {
          expect(dec.statusCode, dec.body).toBe(201);
          expect(j(pub).error).toBe('approval_insufficient');
          expect(await versionsOf(a.id)).toHaveLength(0);
        }
      }
    },
  );

  real('two publishes of the same approved review create one version', async () => {
    const { a, review } = await approved();
    const results = await Promise.all([
      publishReview(tok['author']!, a.id, review),
      publishReview(tok['rev1']!, a.id, review),
      publishReview(tok['author']!, a.id, review),
    ]);
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(await versionsOf(a.id)).toHaveLength(1);
    const [row] = await n.ctx.db.select().from(agentReviews).where(eq(agentReviews.id, review.id));
    expect(row!.status).toBe('published');
  });

  real(
    'a role revoked while the publish runs: the version has a valid approver or there is none',
    async () => {
      for (let i = 0; i < 4; i++) {
        await mkUser(`flip${i}`, ['agent-maintainer']);
        const a = await newAgent(tok['author']!);
        const review = await open(tok['author']!, a.id);
        await decide(tok[`flip${i}`]!, review);
        const [pub, revoke] = await Promise.all([
          publishReview(tok['author']!, a.id, review),
          req(adminA, 'PATCH', `/v1/users/${uid[`flip${i}`]}`, { globalRoles: ['viewer'] }),
        ]);
        expect(revoke.statusCode, revoke.body).toBe(200);
        // whichever came first: a publish that won was decided while the role was still there
        const versions = await versionsOf(a.id);
        expect(versions.length).toBe(pub.statusCode === 201 ? 1 : 0);
        if (pub.statusCode !== 201) expect(j(pub).error).toBe('approval_insufficient');
        const [binding] = await n.ctx.db
          .select()
          .from(tenantRoleBindings)
          .where(
            and(
              eq(tenantRoleBindings.userId, uid[`flip${i}`]!),
              eq(tenantRoleBindings.role, 'agent-maintainer'),
            ),
          );
        expect(binding).toBeUndefined();
      }
    },
  );
});
