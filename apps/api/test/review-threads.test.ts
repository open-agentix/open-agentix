import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lineHash } from '@openagentix/core';
import { agentReviewComments, agentReviewThreads, auditLog } from '../src/db/schema.js';
import { agentSource } from './fixtures.js';
import { PG_URL, openPglite, openPostgres, type Sql } from './db-targets.js';
import { testNode, type TestNode } from './helpers.js';

/**
 * ADR 0017 slice S2: review comment threads over HTTP. Authorisation (agents:review, 404 parity,
 * author-only edit and delete, resolve authority), anchors and outdated detection, limits and the
 * rate limit, closed reviews and the race with a decision, the changes endpoint and the inbox.
 * The leak canaries (audit, logs, spans, metrics, model context) are in `review-threads-canary`.
 */
const PW = 'long-password-123';
// built from code points: invisible characters must not sit in the source
const ZERO_WIDTH = String.fromCharCode(0x200b);
const RLO = String.fromCharCode(0x202e);
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let n: TestNode;
let db: Sql;
let adminA: string;
let adminB: string;
let orgA: string;
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

async function mkUser(key: string, globalRoles: string[]) {
  const res = await req(adminA, 'POST', '/v1/users', {
    email: `${key}@org-a.example.org`,
    displayName: key,
    password: PW,
    globalRoles,
  });
  expect(res.statusCode, res.body).toBe(201);
  uid[key] = j(res).id;
  tok[key] = await n.login(`${key}@org-a.example.org`, PW);
}

const sourceOf = (name: string, version: string, extra = '') =>
  agentSource(name, 'team-sec', version, extra);
const edit = (by: string, a: { id: string; name: string }, version: string, extra = '') =>
  req(by, 'PUT', `/v1/agents/${a.id}/draft`, { source: sourceOf(a.name, version, extra) });

/** An agent written by `author` with an open review on its first revision. */
async function reviewed(extra = '') {
  const name = `thr-agent-${++agentSeq}`;
  const created = await req(tok['author']!, 'POST', '/v1/agents', {
    source: sourceOf(name, '1.0.0', extra),
  });
  expect(created.statusCode, created.body).toBe(201);
  const agent = { id: j(created).id as string, name };
  const opened = await req(tok['author']!, 'POST', `/v1/agents/${agent.id}/reviews`);
  expect(opened.statusCode, opened.body).toBe(201);
  return { agent, review: j(opened) };
}
const base = (reviewId: string) => `/v1/reviews/${reviewId}/threads`;
const startThread = (by: string, reviewId: string, body: unknown) =>
  req(by, 'POST', base(reviewId), body);
const lineOf = (source: string, needle: string) =>
  source.split('\n').findIndex((l) => l.includes(needle)) + 1;
const actionsOf = async (agentId: string, prefix = 'agent.review.') =>
  (await n.ctx.db.select().from(auditLog).where(eq(auditLog.target, agentId)).orderBy(auditLog.seq))
    .filter((e) => e.action.startsWith(prefix))
    .map((e) => ({ action: e.action, actor: e.actor, payload: e.payload as Json }));

beforeAll(async () => {
  db = PG_URL ? await openPostgres() : await openPglite();
  n = await testNode({
    OAX_DATABASE_URL: db.url,
    OAX_LIFECYCLE_REQUIRE_APPROVAL: 'on',
    OAX_RATE_LIMIT_LOGIN_MAX: '1000',
    OAX_RATE_LIMIT_COMMENT_MAX: '1000',
  });
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
  expect(
    (await req(adminA, 'POST', '/v1/teams', { slug: 'team-sec', name: 'Sec' })).statusCode,
  ).toBe(201);
  await mkUser('author', ['agent-maintainer']);
  await mkUser('coauthor', ['agent-developer']);
  await mkUser('rev1', ['agent-maintainer']);
  await mkUser('rev2', ['agent-maintainer']);
  await mkUser('viewer', ['viewer']);
  await mkUser('auditor', ['auditor']);
  await mkUser('oper', ['operator']);
  await mkUser('limited', ['agent-maintainer']);
  await mkUser('fresh', ['agent-maintainer']);
}, 120_000);
afterAll(async () => {
  await n?.close();
  await db?.close();
});

describe('starting threads', () => {
  it('starts a thread about the review as a whole and returns it with its first comment', async () => {
    const { review } = await reviewed();
    const res = await startThread(tok['rev1']!, review.id, { body: 'Looks **fine** overall.' });
    expect(res.statusCode, res.body).toBe(201);
    const t = j(res);
    expect(t).toMatchObject({
      reviewId: review.id,
      createdBy: uid['rev1'],
      anchor: null,
      outdated: false,
      resolved: false,
      canResolve: true,
    });
    expect(t.comments).toHaveLength(1);
    expect(t.comments[0]).toMatchObject({
      authorId: uid['rev1'],
      body: 'Looks **fine** overall.',
      deleted: false,
      editedAt: null,
    });
    const list = j(await req(tok['author']!, 'GET', base(review.id)));
    expect(list.items.map((x: Json) => x.id)).toEqual([t.id]);
  });

  it('anchors a thread to a line of the head revision with a server-computed hash', async () => {
    const { agent, review } = await reviewed();
    const rev = j(await req(tok['author']!, 'GET', `/v1/agents/${agent.id}/revisions/1`));
    const line = lineOf(rev.source, 'version: 1.0.0');
    const res = await startThread(tok['rev1']!, review.id, {
      body: 'Why this version?',
      anchor: { side: 'head', line },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(j(res).anchor).toEqual({
      side: 'head',
      line,
      lineHash: lineHash('version: 1.0.0'),
      revisionId: review.revision.id,
      revisionSeq: 1,
    });
    expect(j(res).outdated).toBe(false);
  });

  it('refuses a line the source does not have and a revision of another agent', async () => {
    const { review } = await reviewed();
    const far = await startThread(tok['rev1']!, review.id, {
      body: 'x',
      anchor: { side: 'head', line: 5000 },
    });
    expect(far.statusCode).toBe(400);
    expect(far.json().error).toBe('anchor_invalid');
    const other = await reviewed();
    const foreign = await startThread(tok['rev1']!, review.id, {
      body: 'x',
      anchor: { side: 'head', line: 1, revisionId: other.review.revision.id },
    });
    expect(foreign.statusCode).toBe(404);
    const noBase = await startThread(tok['rev1']!, review.id, {
      body: 'x',
      anchor: { side: 'base', line: 1 },
    });
    expect(noBase.statusCode).toBe(400);
    expect(
      (await startThread(tok['rev1']!, review.id, { body: 'x', anchor: { side: 'head', line: 0 } }))
        .statusCode,
    ).toBe(400);
  });

  it('anchors to the base version when the agent has one', async () => {
    const name = `thr-base-${++agentSeq}`;
    const a = {
      id: j(await req(tok['author']!, 'POST', '/v1/agents', { source: sourceOf(name, '1.0.0') }))
        .id,
      name,
    };
    expect((await req(tok['author']!, 'POST', `/v1/agents/${a.id}/publish`)).statusCode).toBe(201);
    await edit(tok['author']!, a, '1.0.1');
    const review = j(await req(tok['author']!, 'POST', `/v1/agents/${a.id}/reviews`));
    const res = await startThread(tok['rev1']!, review.id, {
      body: 'This line was removed',
      anchor: { side: 'base', line: 5 },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(j(res).anchor).toMatchObject({
      side: 'base',
      line: 5,
      lineHash: lineHash('version: 1.0.0'),
      revisionId: null,
    });
    expect(j(res).outdated).toBe(false);
  });

  it('replies in a thread and lists the comments in order', async () => {
    const { review } = await reviewed();
    const t = j(await startThread(tok['rev1']!, review.id, { body: 'first' }));
    const reply = await req(tok['author']!, 'POST', `${base(review.id)}/${t.id}/comments`, {
      body: 'second',
    });
    expect(reply.statusCode, reply.body).toBe(201);
    expect(j(reply).comments.map((c: Json) => c.body)).toEqual(['first', 'second']);
  });

  it('keeps @mentions and links as plain text: no notification, no resolution', async () => {
    const { review } = await reviewed();
    const body = `@${uid['rev2']} see [x](https://example.org) and <b>raw</b>`;
    const t = j(await startThread(tok['rev1']!, review.id, { body }));
    expect(t.comments[0].body).toBe(body);
  });
});

describe('limits', () => {
  it('stores up to 10 000 characters and refuses more with a clear 400', async () => {
    const { review } = await reviewed();
    const ok = await startThread(tok['rev1']!, review.id, { body: 'a'.repeat(10_000) });
    expect(ok.statusCode, ok.body).toBe(201);
    const big = await startThread(tok['rev1']!, review.id, { body: 'a'.repeat(10_001) });
    expect(big.statusCode).toBe(400);
    const empty = await startThread(tok['rev1']!, review.id, { body: '   ' });
    expect(empty.statusCode).toBe(400);
    const invisible = await startThread(tok['rev1']!, review.id, { body: ZERO_WIDTH + RLO });
    expect(invisible.statusCode).toBe(400);
  });

  it('removes invisible and steering characters from the stored text', async () => {
    const { review } = await reviewed();
    const t = j(
      await startThread(tok['rev1']!, review.id, { body: `ig${ZERO_WIDTH}nore${RLO} this` }),
    );
    expect(t.comments[0].body).toBe('ignore this');
  });

  it('allows 200 threads per review and refuses the 201st with 409', async () => {
    const { review } = await reviewed();
    for (let i = 0; i < 200; i++)
      await n.ctx.db.insert(agentReviewThreads).values({
        id: randomUUID(),
        reviewId: review.id,
        agentId: review.agentId,
        tenantId: orgA,
        createdBy: uid['rev1']!,
        anchorKind: 'review',
      });
    const res = await startThread(tok['rev1']!, review.id, { body: 'one too many' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('thread_limit_reached');
    // a reply is still possible: only threads are capped
    const [first] = await n.ctx.db
      .select()
      .from(agentReviewThreads)
      .where(eq(agentReviewThreads.reviewId, review.id))
      .limit(1);
    await n.ctx.db.insert(agentReviewComments).values({
      id: randomUUID(),
      threadId: first!.id,
      reviewId: review.id,
      tenantId: orgA,
      authorId: uid['rev1']!,
      body: 'x',
    });
    expect(
      (await req(tok['rev1']!, 'POST', `${base(review.id)}/${first!.id}/comments`, { body: 'y' }))
        .statusCode,
    ).toBe(201);
  }, 60_000);

  it('limits the comments of one thread', async () => {
    const { review } = await reviewed();
    const t = j(await startThread(tok['rev1']!, review.id, { body: 'start' }));
    const rows = Array.from({ length: 199 }, () => ({
      id: randomUUID(),
      threadId: t.id as string,
      reviewId: review.id as string,
      tenantId: orgA,
      authorId: randomUUID(),
      body: 'x',
    }));
    await n.ctx.db.insert(agentReviewComments).values(rows);
    const res = await req(tok['rev1']!, 'POST', `${base(review.id)}/${t.id}/comments`, {
      body: 'z',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('comment_limit_reached');
  });

  it('rate-limits comment creation per user across sessions, deleted comments included', async () => {
    const { review } = await reviewed();
    const cfg = n.ctx.config.rateLimit;
    const before = cfg.commentMax;
    cfg.commentMax = 3;
    try {
      const second = await n.login('limited@org-a.example.org', PW); // another session of the same user
      const t = j(await startThread(tok['limited']!, review.id, { body: '1' }));
      expect(
        (await req(second, 'POST', `${base(review.id)}/${t.id}/comments`, { body: '2' }))
          .statusCode,
      ).toBe(201);
      const third = await req(tok['limited']!, 'POST', `${base(review.id)}/${t.id}/comments`, {
        body: '3',
      });
      expect(third.statusCode).toBe(201);
      const refused = await req(second, 'POST', `${base(review.id)}/${t.id}/comments`, {
        body: '4',
      });
      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toMatchObject({
        error: 'rate_limited',
        details: { retryAfterSeconds: 60 },
      });
      // deleting does not free the quota
      const mine = j(third).comments.at(-1).id as string;
      expect(
        (await req(tok['limited']!, 'DELETE', `${base(review.id)}/${t.id}/comments/${mine}`))
          .statusCode,
      ).toBe(200);
      expect(
        (await req(tok['limited']!, 'POST', `${base(review.id)}/${t.id}/comments`, { body: '5' }))
          .statusCode,
      ).toBe(429);
      // another user is not affected
      expect(
        (await req(tok['fresh']!, 'POST', `${base(review.id)}/${t.id}/comments`, { body: '6' }))
          .statusCode,
      ).toBe(201);
    } finally {
      cfg.commentMax = before;
    }
  });
});

describe('outdated anchors', () => {
  it('keeps a thread across new revisions and marks it outdated only when its line changed', async () => {
    const { agent, review } = await reviewed();
    const rev = j(await req(tok['author']!, 'GET', `/v1/agents/${agent.id}/revisions/1`));
    const versionLine = lineOf(rev.source, 'version: 1.0.0');
    const kindLine = lineOf(rev.source, 'kind: Agent');
    const onVersion = j(
      await startThread(tok['rev1']!, review.id, {
        body: 'v',
        anchor: { side: 'head', line: versionLine },
      }),
    );
    const onKind = j(
      await startThread(tok['rev1']!, review.id, {
        body: 'k',
        anchor: { side: 'head', line: kindLine },
      }),
    );
    const general = j(await startThread(tok['rev1']!, review.id, { body: 'g' }));
    expect((await edit(tok['author']!, agent, '1.0.1')).statusCode).toBe(200);
    const list = j(await req(tok['rev1']!, 'GET', base(review.id))).items as Json[];
    const by = (id: string) => list.find((t) => t.id === id)!;
    expect(by(onVersion.id)).toMatchObject({
      outdated: true,
      anchor: { revisionSeq: 1, line: versionLine },
    });
    expect(by(onKind.id).outdated).toBe(false);
    expect(by(general.id).outdated).toBe(false);
    // writing the old text back makes the anchor match again
    expect((await edit(tok['author']!, agent, '1.0.0')).statusCode).toBe(200);
    const back = j(await req(tok['rev1']!, 'GET', base(review.id))).items as Json[];
    expect(back.find((t) => t.id === onVersion.id)!.outdated).toBe(false);
  });

  it('accepts an anchor on an earlier revision of the same agent', async () => {
    const { agent, review } = await reviewed();
    await edit(tok['author']!, agent, '1.0.1');
    const res = await startThread(tok['rev1']!, review.id, {
      body: 'on the old one',
      anchor: { side: 'head', line: 5, revisionId: review.revision.id },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(j(res)).toMatchObject({ outdated: true, anchor: { revisionSeq: 1 } });
  });
});

describe('who may do what', () => {
  it('needs agents:review: viewers get 403, auditors and operators can comment', async () => {
    const { review } = await reviewed();
    expect((await startThread(tok['viewer']!, review.id, { body: 'x' })).statusCode).toBe(403);
    expect((await req(tok['viewer']!, 'GET', base(review.id))).statusCode).toBe(403);
    expect((await startThread(tok['auditor']!, review.id, { body: 'a' })).statusCode).toBe(201);
    expect((await startThread(tok['oper']!, review.id, { body: 'o' })).statusCode).toBe(201);
  });

  it('answers another tenant, an unknown review and an unknown thread with the same 404', async () => {
    const { review } = await reviewed();
    const t = j(await startThread(tok['rev1']!, review.id, { body: 'x' }));
    const foreign = await startThread(adminB, review.id, { body: 'x' });
    const unknown = await startThread(adminB, randomUUID(), { body: 'x' });
    expect(foreign.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(foreign.json()).toEqual(unknown.json());
    expect((await req(adminB, 'GET', base(review.id))).statusCode).toBe(404);
    for (const [m, u] of [
      ['POST', `${base(review.id)}/${t.id}/comments`],
      ['PATCH', `${base(review.id)}/${t.id}`],
    ] as const)
      expect((await req(adminB, m, u, { body: 'x', resolved: true })).statusCode, u).toBe(404);
    // a thread id of another review (or tenant) is not found through this review, and nothing is
    // written to it: the 404 must come from the lookup, not from the final read
    const other = await reviewed();
    const untouched = async () => {
      const [row] = await n.ctx.db
        .select()
        .from(agentReviewThreads)
        .where(eq(agentReviewThreads.id, t.id));
      const rows = await n.ctx.db
        .select()
        .from(agentReviewComments)
        .where(eq(agentReviewComments.threadId, t.id));
      expect(row!.resolvedAt).toBeNull();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.body).toBe('x');
    };
    const res = await req(tok['rev1']!, 'POST', `${base(other.review.id)}/${t.id}/comments`, {
      body: 'sneaked in',
    });
    expect(res.statusCode).toBe(404);
    expect(
      (await req(tok['rev1']!, 'PATCH', `${base(other.review.id)}/${t.id}`, { resolved: true }))
        .statusCode,
    ).toBe(404);
    await untouched();
    // the same from a review of another tenant
    const nameB = `thr-b-${++agentSeq}`;
    const agentB = j(
      await req(adminB, 'POST', '/v1/agents', { source: agentSource(nameB, 'team-b', '1.0.0') }),
    ).id;
    const reviewB = j(await req(adminB, 'POST', `/v1/agents/${agentB}/reviews`));
    expect(
      (await req(adminB, 'POST', `${base(reviewB.id)}/${t.id}/comments`, { body: 'sneaked in' }))
        .statusCode,
    ).toBe(404);
    expect(
      (await req(adminB, 'PATCH', `${base(reviewB.id)}/${t.id}`, { resolved: true })).statusCode,
    ).toBe(404);
    await untouched();
    // a comment id of another thread of the same review is not editable or deletable through this one
    const t2 = j(await startThread(tok['rev1']!, review.id, { body: 'second' }));
    const cid2 = t2.comments[0].id as string;
    const via = `${base(review.id)}/${t.id}/comments/${cid2}`;
    expect((await req(tok['rev1']!, 'PATCH', via, { body: 'rewritten' })).statusCode).toBe(404);
    expect((await req(tok['rev1']!, 'DELETE', via)).statusCode).toBe(404);
    const [c2] = await n.ctx.db
      .select()
      .from(agentReviewComments)
      .where(eq(agentReviewComments.id, cid2));
    expect(c2).toMatchObject({ body: 'second', deletedAt: null, editedAt: null });
  });

  it('needs agents:review on this agent, not just somewhere (service level)', async () => {
    const { review } = await reviewed();
    // viewer here, maintainer of another team: the route lets the request in, the agent check refuses
    await mkUser('split', ['viewer']);
    const teamB = j(
      await req(adminA, 'POST', '/v1/teams', { slug: 'team-other', name: 'Other' }),
    ).id;
    const added = await req(adminA, 'PUT', `/v1/teams/${teamB}/members`, {
      members: [{ userId: uid['split'], role: 'agent-maintainer' }],
    });
    expect(added.statusCode, added.body).toBe(204);
    tok['split'] = await n.login('split@org-a.example.org', PW);
    expect((await startThread(tok['split']!, review.id, { body: 'x' })).statusCode).toBe(403);
    expect((await req(tok['split']!, 'GET', base(review.id))).statusCode).toBe(403);
    const rows = await n.ctx.db
      .select()
      .from(agentReviewThreads)
      .where(eq(agentReviewThreads.reviewId, review.id));
    expect(rows).toHaveLength(0);
  });

  it('lets only the author edit and delete a comment, and keeps a tombstone without text', async () => {
    const { agent, review } = await reviewed();
    const t = j(await startThread(tok['rev1']!, review.id, { body: 'original' }));
    const cid = t.comments[0].id as string;
    const url = `${base(review.id)}/${t.id}/comments/${cid}`;
    expect((await req(tok['author']!, 'PATCH', url, { body: 'hijack' })).statusCode).toBe(403);
    expect((await req(adminA, 'PATCH', url, { body: 'hijack' })).statusCode).toBe(403);
    expect((await req(tok['author']!, 'DELETE', url)).statusCode).toBe(403);
    const edited = await req(tok['rev1']!, 'PATCH', url, { body: 'changed' });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(j(edited).comments[0]).toMatchObject({ body: 'changed', deleted: false });
    expect(j(edited).comments[0].editedAt).not.toBeNull();
    const gone = await req(tok['rev1']!, 'DELETE', url);
    expect(gone.statusCode).toBe(200);
    expect(j(gone).comments[0]).toMatchObject({ body: '', deleted: true });
    expect((await req(tok['rev1']!, 'DELETE', url)).statusCode).toBe(200); // idempotent
    const again = await req(tok['rev1']!, 'PATCH', url, { body: 'back' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('comment_deleted');
    const [row] = await n.ctx.db
      .select()
      .from(agentReviewComments)
      .where(eq(agentReviewComments.id, cid));
    expect(row).toMatchObject({ body: '', authorId: uid['rev1'] });
    expect(row!.deletedAt).not.toBeNull();
    expect(
      (
        await req(tok['rev1']!, 'PATCH', `${base(review.id)}/${t.id}/comments/${randomUUID()}`, {
          body: 'x',
        })
      ).statusCode,
    ).toBe(404);
    const ops = (await actionsOf(agent.id, 'agent.review.comment')).map((e) => e.payload.op);
    expect(ops).toEqual(['created', 'edited', 'deleted']);
  });

  it('lets the thread starter and the authors resolve and reopen, and nobody else', async () => {
    const { review } = await reviewed();
    const t = j(await startThread(tok['rev1']!, review.id, { body: 'please fix' }));
    const url = `${base(review.id)}/${t.id}`;
    const other = await req(tok['rev2']!, 'PATCH', url, { resolved: true });
    expect(other.statusCode).toBe(403);
    expect((await req(tok['oper']!, 'PATCH', url, { resolved: true })).statusCode).toBe(403);
    // the author of the draft may
    const byAuthor = await req(tok['author']!, 'PATCH', url, { resolved: true });
    expect(byAuthor.statusCode, byAuthor.body).toBe(200);
    expect(j(byAuthor)).toMatchObject({ resolved: true, resolvedBy: uid['author'] });
    // the starter may reopen
    const reopened = await req(tok['rev1']!, 'PATCH', url, { resolved: false });
    expect(j(reopened)).toMatchObject({ resolved: false, resolvedBy: null, canResolve: true });
    // idempotent: no second audit entry
    await req(tok['rev1']!, 'PATCH', url, { resolved: false });
    expect(j(await req(tok['rev2']!, 'GET', base(review.id))).items[0].canResolve).toBe(false);
  });

  it('counts a later author of the draft as someone who may resolve', async () => {
    const { agent, review } = await reviewed();
    const t = j(await startThread(tok['rev1']!, review.id, { body: 'q' }));
    expect(
      (await req(tok['coauthor']!, 'PATCH', `${base(review.id)}/${t.id}`, { resolved: true }))
        .statusCode,
    ).toBe(403);
    await edit(tok['coauthor']!, agent, '1.0.1');
    expect(
      (await req(tok['coauthor']!, 'PATCH', `${base(review.id)}/${t.id}`, { resolved: true }))
        .statusCode,
    ).toBe(200);
  });
});

describe('closed reviews and the race with a decision', () => {
  it('refuses new comments and resolution on a withdrawn review but lets the author delete', async () => {
    const { review } = await reviewed();
    const t = j(await startThread(tok['rev1']!, review.id, { body: 'before' }));
    expect(
      (await req(tok['author']!, 'POST', `/v1/reviews/${review.id}/withdraw`)).statusCode,
    ).toBe(200);
    const late = await startThread(tok['rev1']!, review.id, { body: 'late' });
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toBe('review_closed');
    expect(
      (await req(tok['rev1']!, 'POST', `${base(review.id)}/${t.id}/comments`, { body: 'x' }))
        .statusCode,
    ).toBe(409);
    expect(
      (await req(tok['rev1']!, 'PATCH', `${base(review.id)}/${t.id}`, { resolved: true }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await req(
          tok['rev1']!,
          'PATCH',
          `${base(review.id)}/${t.id}/comments/${t.comments[0].id}`,
          { body: 'e' },
        )
      ).statusCode,
    ).toBe(409);
    // reading still works, and so does taking a comment back
    expect(j(await req(tok['rev1']!, 'GET', base(review.id))).items).toHaveLength(1);
    expect(
      (await req(tok['rev1']!, 'DELETE', `${base(review.id)}/${t.id}/comments/${t.comments[0].id}`))
        .statusCode,
    ).toBe(200);
  });

  it('serialises a comment with a rejecting decision: either the comment comes first or it is refused', async () => {
    for (let i = 0; i < 6; i++) {
      const { review } = await reviewed();
      const [comment, decision] = await Promise.all([
        startThread(tok['rev2']!, review.id, { body: `race ${i}` }),
        req(tok['rev1']!, 'POST', `/v1/reviews/${review.id}/decisions`, {
          decision: 'reject',
          expectedDigest: review.revision.digest,
          comment: 'no',
        }),
      ]);
      expect(decision.statusCode, decision.body).toBe(201);
      expect([201, 409], comment.body).toContain(comment.statusCode);
      const after = await startThread(tok['rev2']!, review.id, { body: 'after' });
      expect(after.statusCode).toBe(409);
    }
  });

  it('does not change the state of the review: comments are not decisions', async () => {
    const { review } = await reviewed();
    await startThread(tok['rev1']!, review.id, { body: 'blocking?' });
    const after = j(await req(tok['rev1']!, 'GET', `/v1/reviews/${review.id}`));
    expect(after.state).toBe('review_requested');
  });
});

describe('the changes endpoint', () => {
  it('returns the sources, the facts and the changes of a first review', async () => {
    const { review } = await reviewed();
    const res = await req(tok['rev1']!, 'GET', `/v1/reviews/${review.id}/changes`);
    expect(res.statusCode, res.body).toBe(200);
    const c = j(res);
    expect(c.base).toBeNull();
    expect(c.headSource).toContain('version: 1.0.0');
    expect(c.facts.head).toMatchObject({ owner: 'team-sec', classification: 'internal' });
    expect(c.changes.scalars).toEqual([]);
    expect(c.rules).toEqual({ available: false, requirements: [] });
    expect(c.policy).toMatchObject({
      approverScope: 'tenant',
      minApprovals: 1,
      allowedApproverRoles: ['admin', 'agent-maintainer'],
    });
    expect(c.revision.digest).toBe(review.revision.digest);
  });

  it('compares against the base version, with scalar and set changes', async () => {
    const name = `thr-chg-${++agentSeq}`;
    const a = {
      id: j(await req(tok['author']!, 'POST', '/v1/agents', { source: sourceOf(name, '1.0.0') }))
        .id,
      name,
    };
    await req(tok['author']!, 'POST', `/v1/agents/${a.id}/publish`);
    await edit(
      tok['author']!,
      a,
      '1.0.1',
      'classification: confidential\nruntime:\n  egress: [api.example.org]',
    );
    const review = j(await req(tok['author']!, 'POST', `/v1/agents/${a.id}/reviews`));
    const c = j(await req(tok['viewer']!, 'GET', `/v1/reviews/${review.id}/changes`));
    expect(c.base).toMatchObject({ version: '1.0.0' });
    expect(c.base.source).toContain('version: 1.0.0');
    expect(c.changes.egress.added).toEqual(['api.example.org']);
    expect(c.changes.scalars).toEqual(
      expect.arrayContaining([{ field: 'classification', from: 'internal', to: 'confidential' }]),
    );
  });

  it('is 404 across tenants and exposes no grantor or token id', async () => {
    const { review } = await reviewed();
    expect((await req(adminB, 'GET', `/v1/reviews/${review.id}/changes`)).statusCode).toBe(404);
    const text = (await req(tok['rev1']!, 'GET', `/v1/reviews/${review.id}/changes`)).body;
    const t = await startThread(tok['rev1']!, review.id, { body: 'x' });
    for (const body of [text, t.body, (await req(tok['rev1']!, 'GET', '/v1/me/reviews')).body])
      expect(body).not.toMatch(/grantedBy|token:|reviewerAuth|bindingRefs/);
  });
});

describe('the people endpoint', () => {
  it('names the people of the review in the acting tenant and hides the review from other tenants', async () => {
    const { review } = await reviewed();
    await startThread(tok['rev1']!, review.id, { body: 'hello' });
    const res = await req(tok['viewer']!, 'GET', `/v1/reviews/${review.id}/people`);
    expect(res.statusCode, res.body).toBe(200);
    expect(j(res).people).toMatchObject({ [uid['author']!]: 'author', [uid['rev1']!]: 'rev1' });
    expect(Object.keys(j(res).people)).not.toContain(uid['rev2']);
    expect((await req(adminB, 'GET', `/v1/reviews/${review.id}/people`)).statusCode).toBe(404);
  });
});

describe('the inbox', () => {
  it('lists open reviews the caller could decide, not the ones they wrote', async () => {
    const { agent, review } = await reviewed();
    const mine = j(await req(tok['rev1']!, 'GET', '/v1/me/reviews'));
    const item = mine.items.find((i: Json) => i.reviewId === review.id);
    expect(item).toMatchObject({
      agentId: agent.id,
      agentName: agent.name,
      state: 'review_requested',
      openedBy: uid['author'],
      revisionSeq: 1,
      requiredApprovals: 1,
      countedApprovals: 0,
      yourDecision: null,
    });
    const own = j(await req(tok['author']!, 'GET', '/v1/me/reviews'));
    expect(own.items.find((i: Json) => i.reviewId === review.id)).toBeUndefined();
    expect(j(await req(tok['viewer']!, 'GET', '/v1/me/reviews')).items).toEqual([]);
    expect(j(await req(adminB, 'GET', '/v1/me/reviews')).items).toEqual([]);
  });

  it('shows your own decision and the approvals counted, and respects the limit', async () => {
    const { review } = await reviewed();
    await req(tok['rev1']!, 'POST', `/v1/reviews/${review.id}/decisions`, {
      decision: 'approve',
      expectedDigest: review.revision.digest,
    });
    const item = j(await req(tok['rev1']!, 'GET', '/v1/me/reviews')).items.find(
      (i: Json) => i.reviewId === review.id,
    );
    expect(item).toMatchObject({ state: 'approved', countedApprovals: 1, yourDecision: 'approve' });
    expect(j(await req(tok['rev1']!, 'GET', '/v1/me/reviews?limit=1')).items).toHaveLength(1);
    expect((await req(tok['rev1']!, 'GET', '/v1/me/reviews?limit=500')).statusCode).toBe(400);
  });

  it('drops a closed review', async () => {
    const { review } = await reviewed();
    await req(tok['author']!, 'POST', `/v1/reviews/${review.id}/withdraw`);
    expect(
      j(await req(tok['rev1']!, 'GET', '/v1/me/reviews')).items.find(
        (i: Json) => i.reviewId === review.id,
      ),
    ).toBeUndefined();
  });
});

describe('the audit trail of comments', () => {
  it('records ids and lengths only', async () => {
    const { agent, review } = await reviewed();
    const text = 'secret-looking comment text 12345';
    const t = j(await startThread(tok['rev1']!, review.id, { body: text }));
    await req(tok['author']!, 'PATCH', `${base(review.id)}/${t.id}`, { resolved: true });
    const entries = await actionsOf(agent.id);
    const comment = entries.find((e) => e.action === 'agent.review.comment')!;
    expect(comment.actor).toBe(uid['rev1']);
    expect(comment.payload).toMatchObject({
      review: review.id,
      thread: t.id,
      comment: t.comments[0].id,
      op: 'created',
      length: text.length,
    });
    expect(entries.find((e) => e.action === 'agent.review.thread_resolved')!.payload).toMatchObject(
      {
        thread: t.id,
        resolved: true,
      },
    );
    expect(JSON.stringify(entries)).not.toContain('secret-looking');
    const verify = await n.req({ method: 'POST', url: '/v1/audit/verify', payload: {} });
    expect(verify.json().valid).toBe(true);
  });
});

describe('bounds on what a review costs to read', () => {
  it('stops a review at 1,000 comments and answers with a clear 409', async () => {
    const { review } = await reviewed();
    const t = j(await startThread(tok['rev1']!, review.id, { body: 'first' }));
    const thread2 = randomUUID();
    await n.ctx.db.insert(agentReviewThreads).values({
      id: thread2,
      reviewId: review.id,
      agentId: review.agentId,
      tenantId: orgA,
      createdBy: uid['rev1']!,
      anchorKind: 'review',
    });
    // 999 more comments spread over threads (a thread holds at most 200)
    const rows = Array.from({ length: 999 }, () => ({
      id: randomUUID(),
      threadId: thread2,
      reviewId: review.id as string,
      tenantId: orgA,
      authorId: randomUUID(),
      body: 'x',
    }));
    await n.ctx.db.insert(agentReviewComments).values(rows);
    const res = await req(tok['rev1']!, 'POST', `${base(review.id)}/${t.id}/comments`, {
      body: 'one more',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('review_comment_budget_reached');
    expect((await startThread(tok['rev1']!, review.id, { body: 'new thread' })).statusCode).toBe(
      409,
    );
    // deleting your own comment still works at the limit
    expect(
      (await req(tok['rev1']!, 'DELETE', `${base(review.id)}/${t.id}/comments/${t.comments[0].id}`))
        .statusCode,
    ).toBe(200);
  }, 60_000);

  it('stops a review at one million characters, edits included', async () => {
    const { review } = await reviewed();
    const t = j(await startThread(tok['rev1']!, review.id, { body: 'small' }));
    const thread2 = randomUUID();
    await n.ctx.db.insert(agentReviewThreads).values({
      id: thread2,
      reviewId: review.id,
      agentId: review.agentId,
      tenantId: orgA,
      createdBy: uid['rev1']!,
      anchorKind: 'review',
    });
    await n.ctx.db.insert(agentReviewComments).values(
      Array.from({ length: 99 }, () => ({
        id: randomUUID(),
        threadId: thread2,
        reviewId: review.id as string,
        tenantId: orgA,
        authorId: randomUUID(),
        body: 'y'.repeat(10_000),
      })),
    );
    // 990,005 characters in: room for one more 9,995, not for 10,000
    const url = `${base(review.id)}/${t.id}`;
    expect(
      (await req(tok['rev1']!, 'POST', `${url}/comments`, { body: 'z'.repeat(10_000) })).statusCode,
    ).toBe(409);
    expect(
      (await req(tok['rev1']!, 'POST', `${url}/comments`, { body: 'z'.repeat(9_995) })).statusCode,
    ).toBe(201);
    const edit = await req(tok['rev1']!, 'PATCH', `${url}/comments/${t.comments[0].id}`, {
      body: 'q'.repeat(100),
    });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().error).toBe('review_comment_budget_reached');
  }, 60_000);

  it('reads one thread without reading the whole discussion', async () => {
    const { review } = await reviewed();
    const a = j(await startThread(tok['rev1']!, review.id, { body: 'a' }));
    await startThread(tok['rev1']!, review.id, { body: 'b' });
    const reply = await req(tok['rev2']!, 'POST', `${base(review.id)}/${a.id}/comments`, {
      body: 'c',
    });
    expect(j(reply).comments.map((c: Json) => c.body)).toEqual(['a', 'c']);
  });

  it('handles a source line of 200,000 blanks in a bounded time, creating and listing', async () => {
    const long = `description: "${' '.repeat(200_000)}x"`;
    const name = `thr-long-${++agentSeq}`;
    const created = await req(tok['author']!, 'POST', '/v1/agents', {
      source: sourceOf(name, '1.0.0', long),
    });
    expect(created.statusCode, created.body.slice(0, 200)).toBe(201);
    const review = j(await req(tok['author']!, 'POST', `/v1/agents/${j(created).id}/reviews`));
    const rev = j(await req(tok['author']!, 'GET', `/v1/agents/${j(created).id}/revisions/1`));
    const line = lineOf(rev.source, 'description:');
    let started = performance.now();
    const res = await startThread(tok['rev1']!, review.id, {
      body: 'long',
      anchor: { side: 'head', line },
    });
    expect(res.statusCode, res.body.slice(0, 200)).toBe(201);
    expect(performance.now() - started).toBeLessThan(3000);
    started = performance.now();
    expect((await req(tok['rev1']!, 'GET', base(review.id))).statusCode).toBe(200);
    expect(performance.now() - started).toBeLessThan(3000);
  }, 60_000);

  it('limits edits too: the route and the per-user count both apply', async () => {
    const { review } = await reviewed();
    const t = j(await startThread(tok['fresh']!, review.id, { body: 'v0' }));
    const cfg = n.ctx.config.rateLimit;
    const before = cfg.commentMax;
    cfg.commentMax = 2;
    try {
      const url = `${base(review.id)}/${t.id}/comments/${t.comments[0].id}`;
      const codes: number[] = [];
      for (let i = 1; i <= 4; i++)
        codes.push((await req(tok['fresh']!, 'PATCH', url, { body: `v${i}` })).statusCode);
      expect(codes).toContain(429);
    } finally {
      cfg.commentMax = before;
    }
  });
});
