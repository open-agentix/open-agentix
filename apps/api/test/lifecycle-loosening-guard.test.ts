import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  agentDraftRevisions,
  agentReviews,
  agentVersions,
  agents,
  tenants,
  users,
} from '../src/db/schema.js';
import { LOOSENING_LIMITS } from '../src/services/lifecycle-policy.js';
import { agentSource } from './fixtures.js';
import { PG_URL, openPglite, openPostgres, type Sql } from './db-targets.js';
import { testNode, type TestNode } from './helpers.js';

/**
 * Finding 3 of #356: the guard against loosening the lifecycle policy by a contributor of an unfinished
 * review. Withdraw, loosen, reopen; the creator chain of the caller; a tenant move that widens the
 * policy; more reviews than one page; a caller whose authority cannot be traced. Runs on PGlite and,
 * with OAX_TEST_DATABASE_URL, on a real PostgreSQL.
 */
const PW = 'long-password-123';
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let n: TestNode;
let db: Sql;
let orgA: string;
let adminA: string; // organisation administrator, never a contributor
const uid: Record<string, string> = {};
const tok: Record<string, string> = {};
let seq = 0;

const req = (
  token: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  headers?: Record<string, string>,
) =>
  n.req({
    method,
    url,
    token,
    ...(payload === undefined ? {} : { payload: payload as object }),
    ...(headers ? { headers } : {}),
  });
const j = (res: { json: () => unknown }) => res.json() as Json;

async function mkUser(key: string, globalRoles: string[], by = adminA) {
  const res = await req(by, 'POST', '/v1/users', {
    email: `${key}@loose.example.org`,
    displayName: key,
    password: PW,
    globalRoles,
  });
  expect(res.statusCode, res.body).toBe(201);
  uid[key] = j(res).id;
  tok[key] = await n.login(`${key}@loose.example.org`, PW);
}
const newAgent = async (by: string, headers?: Record<string, string>) => {
  const name = `loose-agent-${++seq}`;
  const res = await req(
    by,
    'POST',
    '/v1/agents',
    { source: agentSource(name, 'nobody', '1.0.0') },
    headers,
  );
  expect(res.statusCode, res.body).toBe(201);
  return j(res).id as string;
};
const openReview = async (by: string, agentId: string, headers?: Record<string, string>) => {
  const res = await req(by, 'POST', `/v1/agents/${agentId}/reviews`, undefined, headers);
  expect(res.statusCode, res.body).toBe(201);
  return j(res);
};
const policyUrl = (id = orgA) => `/v1/tenants/${id}/settings/agent-lifecycle`;
const setPolicy = (patch: Json, by = adminA, id = orgA) => req(by, 'PATCH', policyUrl(id), patch);
const strict = () =>
  setPolicy({ requireApprovalForPublish: 'on', minApprovals: 2, approvalExpiryHours: 24 });
const LOOSEN = { minApprovals: 1 };
const expectRefused = (res: { statusCode: number; body: string; json: () => unknown }) => {
  expect(res.statusCode, res.body).toBe(403);
  expect(j(res).error).toBe('policy_loosening_by_contributor');
};
/**
 * Ends every hold of the organisation so that the next test starts clean: open reviews are
 * published, and a version is published for every agent whose review was withdrawn or rejected.
 */
async function settleAll() {
  await n.ctx.db
    .update(agentReviews)
    .set({ status: 'published', closedAt: new Date() })
    .where(eq(agentReviews.status, 'open'));
  const closed = await n.ctx.db
    .select({ agentId: agentReviews.agentId })
    .from(agentReviews)
    .where(inArray(agentReviews.status, ['withdrawn', 'rejected']));
  for (const agentId of new Set(closed.map((c) => c.agentId)))
    await n.ctx.db.insert(agentVersions).values({
      id: randomUUID(),
      agentId,
      version: `settled-${randomUUID()}`,
      digest: 'b'.repeat(64),
      source: 'x',
      definition: {},
    });
}

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
      slug: 'org-loose',
      name: 'org-loose',
      admin: { email: 'admin@loose.example.org', displayName: 'Admin', password: PW },
    },
  });
  expect(r.statusCode, r.body).toBe(201);
  orgA = j(r).id;
  adminA = await n.login('admin@loose.example.org', PW);
  await mkUser('author', ['agent-maintainer']);
  await mkUser('rev', ['agent-maintainer']);
  await mkUser('c', ['admin']); // contributor with administrator rights
}, 120_000);
afterAll(async () => {
  await n?.close();
  await db?.close();
});

describe('withdraw, loosen, reopen', () => {
  it('keeps the hold after the contributor withdrew their review, until the change is published', async () => {
    expect((await strict()).statusCode).toBe(200);
    const agent = await newAgent(tok['c']!);
    const review = await openReview(tok['c']!, agent);
    expectRefused(await setPolicy(LOOSEN, tok['c']!)); // open: refused (as before)
    const w = await req(tok['c']!, 'POST', `/v1/reviews/${review.id}/withdraw`);
    expect(w.statusCode, w.body).toBe(200);
    // the bypass: the review is withdrawn, so nothing is open - the loosening is still refused
    expectRefused(await setPolicy(LOOSEN, tok['c']!));
    expectRefused(await setPolicy({ approvalExpiryHours: 720 }, tok['c']!));
    // another administrator may loosen, and tightening is never held
    expect((await setPolicy({ minApprovals: 3 }, tok['c']!)).statusCode).toBe(200);
    expect((await setPolicy(LOOSEN)).statusCode).toBe(200);
    expect((await strict()).statusCode).toBe(200);
    // publishing the change ends the hold: nothing is under review any more
    const pub = await req(tok['c']!, 'POST', `/v1/agents/${agent}/publish`);
    expect(pub.statusCode, pub.body).toBe(201);
    expect((await setPolicy(LOOSEN, tok['c']!)).statusCode).toBe(200);
    expect((await strict()).statusCode).toBe(200);
    await settleAll();
  });

  it('holds after a reject as well', async () => {
    const agent = await newAgent(tok['c']!);
    const review = await openReview(tok['c']!, agent);
    const decide = await req(tok['rev']!, 'POST', `/v1/reviews/${review.id}/decisions`, {
      decision: 'reject',
      comment: 'no',
      expectedDigest: review.revision.digest,
      expectedExpansionDigest: review.digests.expansionDigest,
      expectedResolutionDigest: review.digests.resolutionDigest,
      expectedPolicyDigest: review.digests.policyDigest,
    });
    expect(decide.statusCode, decide.body).toBe(201);
    expect((await strict()).statusCode).toBe(200);
    expectRefused(await setPolicy(LOOSEN, tok['c']!));
    await settleAll();
    expect((await setPolicy(LOOSEN, tok['c']!)).statusCode).toBe(200);
  });
});

describe('the creator chain of the caller', () => {
  it('refuses an account that a contributor made, and one made through a second account', async () => {
    await settleAll();
    expect((await strict()).statusCode).toBe(200);
    // C makes an administrator D, D makes administrator E; neither touched a draft
    await mkUser('d', ['admin'], tok['c']!);
    await mkUser('e', ['admin'], tok['d']!);
    const agent = await newAgent(tok['c']!);
    await openReview(tok['c']!, agent);
    expectRefused(await setPolicy(LOOSEN, tok['d']!));
    expectRefused(await setPolicy(LOOSEN, tok['e']!));
    // a clean administrator loosens
    expect((await setPolicy(LOOSEN)).statusCode).toBe(200);
    await settleAll();
  });

  it('refuses an administrator whose own authority was granted by a contributor, although the account is clean', async () => {
    expect((await strict()).statusCode).toBe(200);
    await mkUser('f', []); // made by the clean administrator
    const grant = await req(tok['c']!, 'POST', `/v1/tenants/${orgA}/role-bindings`, {
      userId: uid['f'],
      role: 'admin',
      inherit: false,
    });
    expect(grant.statusCode, grant.body).toBe(201);
    tok['f'] = await n.login('f@loose.example.org', PW);
    await openReview(tok['c']!, await newAgent(tok['c']!));
    expectRefused(await setPolicy(LOOSEN, tok['f']!));
    await settleAll();
  });

  it('refuses a caller whose authority cannot be traced as soon as a review is unfinished, and only then', async () => {
    expect((await strict()).statusCode).toBe(200);
    await mkUser('g', ['admin']);
    await n.ctx.db.update(users).set({ creatorUnknown: true }).where(eq(users.id, uid['g']!));
    await settleAll();
    // nothing unfinished: nothing to protect
    expect((await setPolicy(LOOSEN, tok['g']!)).statusCode).toBe(200);
    expect((await strict()).statusCode).toBe(200);
    await openReview(tok['author']!, await newAgent(tok['author']!));
    expectRefused(await setPolicy(LOOSEN, tok['g']!));
    expect((await setPolicy(LOOSEN)).statusCode).toBe(200);
    await settleAll();
  });
});

describe('a review that cannot be examined', () => {
  it('counts as a contributor when its head revision cannot be read', async () => {
    await settleAll();
    expect((await strict()).statusCode).toBe(200);
    const agent = await newAgent(tok['author']!);
    await openReview(tok['author']!, agent);
    // the draft pointer is lost: nothing shows who touched this review
    await n.ctx.db.update(agents).set({ draftRevisionId: null }).where(eq(agents.id, agent));
    expectRefused(await setPolicy(LOOSEN));
    await settleAll();
    expect((await setPolicy(LOOSEN)).statusCode).toBe(200);
    expect((await strict()).statusCode).toBe(200);
  });
});

/** Review rows for `count` agents in the organisation, written directly; `openedBy` per agent. */
async function seedReviews(
  count: number,
  authors: (i: number) => string,
  ids?: (i: number) => string,
) {
  const base = ++seq * 100_000;
  const agentRows = [];
  const revRows = [];
  const reviewRows = [];
  for (let i = 0; i < count; i++) {
    const agent = randomUUID();
    const rev = randomUUID();
    const author = authors(i);
    agentRows.push({
      id: agent,
      tenantId: orgA,
      name: `bulk-${base + i}`,
      draftSource: 'x',
      draftRevisionId: rev,
      createdBy: author,
    });
    revRows.push({
      id: rev,
      agentId: agent,
      tenantId: orgA,
      seq: 1,
      digest: 'a'.repeat(64),
      source: 'x',
      authorId: author,
      authorKind: 'user',
    });
    reviewRows.push({
      id: ids ? ids(i) : randomUUID(),
      agentId: agent,
      tenantId: orgA,
      openedBy: author,
      openedRevisionId: rev,
      status: 'open',
      policySnapshot: {},
      policyDigest: 'd',
      requiredApprovals: 1,
    });
  }
  for (let at = 0; at < count; at += 300) {
    await n.ctx.db.insert(agents).values(agentRows.slice(at, at + 300));
    await n.ctx.db.insert(agentDraftRevisions).values(revRows.slice(at, at + 300));
  }
  for (let at = 0; at < count; at += 300)
    await n.ctx.db.insert(agentReviews).values(reviewRows.slice(at, at + 300));
}

describe('more unfinished reviews than one page', () => {
  it('finds the contributor on the last page of more than 1000 open reviews, and lets a clean administrator through', async () => {
    await settleAll();
    expect((await strict()).statusCode).toBe(200);
    // 1001 reviews by other people; the contributor's own review sorts last by id
    await seedReviews(
      1002,
      (i) => (i === 1001 ? uid['c']! : uid['author']!),
      (i) =>
        i === 1001 ? 'ffffffff-ffff-4fff-8fff-ffffffffffff' : randomUUID().replace(/^f/, 'a'),
    );
    expectRefused(await setPolicy(LOOSEN, tok['c']!));
    expect((await setPolicy(LOOSEN, tok['rev']!)).statusCode).toBe(403); // rev cannot write settings at all
    expect((await setPolicy(LOOSEN)).statusCode).toBe(200);
    expect((await strict()).statusCode).toBe(200);
    await settleAll();
  }, 120_000);

  it('pages through the reviews with a small page and refuses what it cannot check', async () => {
    const saved = { ...LOOSENING_LIMITS };
    try {
      LOOSENING_LIMITS.pageSize = 2;
      await seedReviews(
        5,
        (i) => (i === 4 ? uid['c']! : uid['author']!),
        (i) =>
          i === 4
            ? 'ffffffff-ffff-4fff-8fff-fffffffffffe'
            : `aaaaaaaa-0000-4000-8000-00000000000${i}`,
      );
      expectRefused(await setPolicy(LOOSEN, tok['c']!)); // the contributor is on the third page
      // more unfinished reviews than the guard checks: refused as unverifiable, whoever asks
      LOOSENING_LIMITS.max = 3;
      const res = await setPolicy(LOOSEN);
      expectRefused(res);
      expect(j(res).message).toContain('cannot all be checked');
      LOOSENING_LIMITS.max = saved.max;
      expect((await setPolicy(LOOSEN)).statusCode).toBe(200);
    } finally {
      Object.assign(LOOSENING_LIMITS, saved);
    }
    expect((await strict()).statusCode).toBe(200);
    await settleAll();
  });
});

describe('a tenant move that widens the policy', () => {
  it('is a loosening: the contributor of an unfinished review below the node cannot move it', async () => {
    await settleAll();
    const mk = async (slug: string, parentId: string) => {
      const res = await n.req({
        method: 'POST',
        url: '/v1/tenants',
        payload: { slug, name: slug, parentId },
      });
      expect(res.statusCode, res.body).toBe(201);
      return j(res).id as string;
    };
    const p1 = await mk('loose-p1', orgA);
    const p2 = await mk('loose-p2', orgA);
    const node = await mk('loose-node', p1);
    // M administers the whole organisation with inheritance
    await mkUser('m', []);
    const bind = await n.req({
      method: 'POST',
      url: `/v1/tenants/${orgA}/role-bindings`,
      payload: { userId: uid['m'], role: 'admin', inherit: true },
    });
    expect(bind.statusCode, bind.body).toBe(201);
    tok['m'] = await n.login('m@loose.example.org', PW);
    expect((await setPolicy({ minApprovals: 3 }, tok['m']!, p1)).statusCode).toBe(200);
    // M works inside the node and opens a review there
    const acting = { 'x-oax-tenant': node };
    const agent = await newAgent(tok['m']!, acting);
    await openReview(tok['m']!, agent, acting);
    const move = (by: string | null, dryRun = false) =>
      n.req({
        method: 'POST',
        url: `/v1/tenants/${node}/move`,
        payload: { parentId: p2, dryRun },
        ...(by === null ? {} : { token: by }),
      });
    // leaving p1 drops minApprovals 3 inside the node: refused, also as a dry run
    expectRefused(await move(tok['m']!, true));
    expectRefused(await move(tok['m']!));
    expect((await n.ctx.db.select().from(tenants).where(eq(tenants.id, node)))[0]!.parentId).toBe(
      p1,
    );
    // a platform operator who contributed nothing may move it
    const ok = await move(null);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(j(ok).policiesWidened).toEqual(['minApprovals']);
    // a move that loosens nothing is not held
    const back = await n.req({
      method: 'POST',
      url: `/v1/tenants/${node}/move`,
      payload: { parentId: p1, dryRun: true },
      token: tok['m']!,
    });
    expect(back.statusCode, back.body).toBe(200);
    expect(j(back).policiesWidened).toEqual([]);
  });
});
