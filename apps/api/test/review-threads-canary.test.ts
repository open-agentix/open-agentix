import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { buildApp } from '../src/http/app.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog } from '../src/db/schema.js';
import { resetTelemetryRuntime } from '../src/telemetry.js';
import { agentSource } from './fixtures.js';
import { testNode, type TestNode } from './helpers.js';
import { captureLogger, type LogCapture } from './model-proxy-helpers.js';
import { startTracing } from './trace-harness.js';

/**
 * Comment text is tenant content (ADR 0017 sections 9 and 11): it must never reach the audit chain,
 * logs, spans, metrics, error bodies of other requests or any model context. A canary comment goes
 * through every operation, then every sink is searched for it.
 */
const PW = 'long-password-123';
const CANARY = 'CANARY-7c1e5b9aQ3dZ8f2m6Kp0WxLs4Nv';
const LONG_CANARY = `${CANARY}-${'x'.repeat(10_001)}`;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let n: TestNode;
let logs: LogCapture;
let tracing: ReturnType<typeof startTracing>;
let author: string;
let reviewer: string;
const responses: string[] = [];

const call = async (
  token: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
) => {
  const res = await n.req({
    method,
    url,
    token,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return res;
};

beforeAll(async () => {
  logs = captureLogger();
  resetTelemetryRuntime();
  tracing = startTracing();
  n = await testNode(
    { OAX_LIFECYCLE_REQUIRE_APPROVAL: 'on', OAX_RATE_LIMIT_COMMENT_MAX: '1000' },
    { logger: logs.logger },
  );
  const org = await n.req({
    method: 'POST',
    url: '/v1/tenants',
    payload: {
      slug: 'org-c',
      name: 'org-c',
      admin: { email: 'admin@org-c.example.org', displayName: 'Admin', password: PW },
    },
  });
  expect(org.statusCode, org.body).toBe(201);
  const admin = await n.login('admin@org-c.example.org', PW);
  await call(admin, 'POST', '/v1/teams', { slug: 'team-c', name: 'C' });
  for (const k of ['author', 'reviewer']) {
    const r = await call(admin, 'POST', '/v1/users', {
      email: `${k}@org-c.example.org`,
      displayName: k,
      password: PW,
      globalRoles: ['agent-maintainer'],
    });
    expect(r.statusCode, r.body).toBe(201);
  }
  author = await n.login('author@org-c.example.org', PW);
  reviewer = await n.login('reviewer@org-c.example.org', PW);
});
afterAll(async () => {
  await tracing.stop();
  resetTelemetryRuntime();
  await n.close();
});

describe('a canary comment through every operation', () => {
  let reviewId: string;
  let agentId: string;

  it('runs the whole life of a comment', async () => {
    const created = await call(author, 'POST', '/v1/agents', {
      source: agentSource('canary-agent', 'team-c', '1.0.0'),
    });
    agentId = (created.json() as Json).id;
    const opened = await call(author, 'POST', `/v1/agents/${agentId}/reviews`);
    const review = opened.json() as Json;
    reviewId = review.id;
    const thread = (
      await call(reviewer, 'POST', `/v1/reviews/${reviewId}/threads`, {
        body: `${CANARY} first`,
        anchor: { side: 'head', line: 2 },
      })
    ).json() as Json;
    const t = `/v1/reviews/${reviewId}/threads/${thread.id}`;
    responses.push(
      (await call(author, 'POST', `${t}/comments`, { body: `${CANARY} reply` })).body,
      (
        await call(reviewer, 'PATCH', `${t}/comments/${thread.comments[0].id}`, {
          body: `${CANARY} edited`,
        })
      ).body,
      (await call(author, 'PATCH', t, { resolved: true })).body,
      (await call(reviewer, 'GET', `/v1/reviews/${reviewId}/threads`)).body,
      (await call(reviewer, 'DELETE', `${t}/comments/${thread.comments[0].id}`)).body,
      // refusals that must not echo the text
      (await call(reviewer, 'POST', `/v1/reviews/${reviewId}/threads`, { body: LONG_CANARY })).body,
      (
        await call(reviewer, 'POST', `/v1/reviews/${reviewId}/threads`, {
          body: CANARY,
          anchor: { side: 'head', line: 9999 },
        })
      ).body,
      (await call(author, 'PATCH', `${t}/comments/${thread.comments[0].id}`, { body: CANARY }))
        .body,
    );
    // a decision with a canary comment (S1 behaviour, kept honest here)
    const decision = await call(reviewer, 'POST', `/v1/reviews/${reviewId}/decisions`, {
      decision: 'request_changes',
      expectedDigest: review.revision.digest,
      expectedExpansionDigest: review.digests.expansionDigest,
      expectedResolutionDigest: review.digests.resolutionDigest,
      expectedPolicyDigest: review.digests.policyDigest,
      comment: `${CANARY} decision`,
    });
    expect(decision.statusCode, decision.body).toBe(201);
    // events that other readers see: the review, the audit API, the metrics scrape
    responses.push(
      (await call(reviewer, 'GET', `/v1/reviews/${reviewId}/changes`)).body,
      (await call(reviewer, 'GET', '/v1/me/reviews')).body,
      (await n.req({ method: 'GET', url: '/v1/audit?limit=200' })).body,
      (await n.req({ method: 'GET', url: '/metrics', token: null })).body,
    );
  });

  it('keeps the text out of the audit chain', async () => {
    const rows = await n.ctx.db.select().from(auditLog);
    expect(rows.length).toBeGreaterThan(5);
    expect(JSON.stringify(rows)).not.toContain(CANARY);
    const mine = await n.ctx.db.select().from(auditLog).where(eq(auditLog.target, agentId));
    expect(mine.some((e) => e.action === 'agent.review.comment')).toBe(true);
  });

  it('keeps the text out of the logs', () => {
    expect(logs.text().length).toBeGreaterThan(0);
    expect(logs.text()).not.toContain(CANARY);
  });

  it('keeps the text out of spans, their attributes, events and names', () => {
    const spans = tracing.exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(0);
    const dump = JSON.stringify(
      spans.map((s) => ({
        name: s.name,
        attributes: s.attributes,
        events: s.events,
        links: s.links,
      })),
    );
    expect(dump).not.toContain(CANARY);
    // the request spans are named after the route pattern, not the path
    expect(spans.some((s) => s.name === 'POST /v1/reviews/:id/threads')).toBe(true);
  });

  it('keeps the text out of every response that is not the thread itself', () => {
    const joined = responses.join('\n');
    // only the thread reads and writes may carry it; the audit export, the metrics, the inbox,
    // the changes summary and every refusal must not
    const leaking = responses.filter((r) => r.includes(CANARY));
    expect(leaking.length).toBeGreaterThan(0); // the thread endpoints do return it
    for (const r of responses.slice(-4)) expect(r).not.toContain(CANARY);
    expect(joined).not.toContain('x'.repeat(200));
  });
});

describe('a failing database statement', () => {
  it('logs no comment text and answers with a plain 500', async () => {
    const sink: string[] = [];
    // an app whose request log (where a 500 is logged) is captured, on the same node
    const logged = await buildApp({
      ctx: { ...n.ctx, config: { ...n.ctx.config, logLevel: 'trace' } },
      services: n.services,
      logSink: { write: (line: string) => void sink.push(line) } as never,
    });
    const created = await call(author, 'POST', '/v1/agents', {
      source: agentSource('canary-db-agent', 'team-c', '1.0.0'),
    });
    const review = (
      await call(author, 'POST', `/v1/agents/${(created.json() as Json).id}/reviews`)
    ).json() as Json;
    // every insert of a comment now fails inside the database, after drizzle bound its parameters
    await n.ctx.db.execute(
      sql`create function oax_test_boom() returns trigger as $$ begin raise exception 'boom'; end; $$ language plpgsql`,
    );
    await n.ctx.db.execute(
      sql`create trigger oax_test_boom before insert on agent_review_comments for each row execute function oax_test_boom()`,
    );
    try {
      const res = await logged.inject({
        method: 'POST',
        url: `/v1/reviews/${review.id}/threads`,
        headers: { authorization: `Bearer ${reviewer}` },
        payload: { body: `${CANARY} db` },
      });
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain(CANARY);
    } finally {
      await n.ctx.db.execute(sql`drop trigger oax_test_boom on agent_review_comments`);
      await n.ctx.db.execute(sql`drop function oax_test_boom()`);
      await logged.close();
    }
    const text = sink.join('\n');
    expect(text, 'the failure is logged').toContain('database statement failed');
    expect(text).not.toContain(CANARY);
  });
});

describe('model context', () => {
  const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      if (f === 'node_modules' || f === 'dist' || f === 'test') return [];
      return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
    });

  it('has no code path that reads a comment into a model request: only the thread service touches the tables', () => {
    const allowed = new Set([
      'apps/api/src/db/schema.ts',
      'apps/api/src/services/review-threads.ts',
    ]);
    const offenders: string[] = [];
    for (const top of ['apps', 'packages'])
      for (const pkg of readdirSync(join(ROOT, top))) {
        const src = join(ROOT, top, pkg, 'src');
        try {
          statSync(src);
        } catch {
          continue;
        }
        for (const f of files(src)) {
          const rel = relative(ROOT, f);
          if (allowed.has(rel)) continue;
          if (
            /agentReviewComments|agentReviewThreads|agent_review_comments/.test(
              readFileSync(f, 'utf8'),
            )
          )
            offenders.push(rel);
        }
      }
    expect(offenders).toEqual([]);
  });

  it('keeps the model proxy, the runners and the worker free of any review reference', () => {
    const offenders: string[] = [];
    for (const dir of ['apps/worker/src', 'packages/runners/src', 'packages/providers/src']) {
      for (const f of files(join(ROOT, dir)))
        if (/review.?thread|ReviewThread|reviewThreads/.test(readFileSync(f, 'utf8')))
          offenders.push(relative(ROOT, f));
    }
    for (const f of [
      'apps/api/src/services/model-proxy.ts',
      'apps/api/src/services/model-proxy-json.ts',
    ])
      if (/review.?thread|ReviewThread|reviewThreads/.test(readFileSync(join(ROOT, f), 'utf8')))
        offenders.push(f);
    expect(offenders).toEqual([]);
  });
});
