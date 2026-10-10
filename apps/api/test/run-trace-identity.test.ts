import { randomUUID } from 'node:crypto';
import { createAuditEntry, verifyAuditChain, type AuditEntry } from '@openagentix/core';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, runs } from '../src/db/schema.js';
import { rowToEntry } from '../src/services/audit.js';
import { configureTelemetryRuntime, resetTelemetryRuntime } from '../src/telemetry.js';
import { agentSource } from './fixtures.js';
import { testNode, type TestNode } from './helpers.js';
import { attributesComply, countingStats, startTracing } from './trace-harness.js';

/**
 * Slice S2 of ADR 0015: the run's trace identity, the audit links and the inbound context rules.
 * Each test fails on the code before the slice (no ids, no `payload.otel`, no counter).
 */
const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const PW = 'long-password-123';
const FOREIGN = {
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  spanId: '00f067aa0ba902b7',
};
const FOREIGN_HEADER = `00-${FOREIGN.traceId}-${FOREIGN.spanId}-01`;

let n: TestNode;
let agentId: string;
const trigger = (headers: Record<string, string> = {}, token?: string) =>
  n.req({
    method: 'POST',
    url: `/v1/agents/${agentId}/runs`,
    payload: { data: { n: 1 } },
    headers,
    ...(token ? { token } : {}),
  });
const runRow = async (id: string) =>
  (await n.ctx.db.select().from(runs).where(eq(runs.id, id)))[0]!;
const auditOf = async (runId: string): Promise<AuditEntry[]> =>
  (
    await n.ctx.db.select().from(auditLog).where(eq(auditLog.runId, runId)).orderBy(auditLog.seq)
  ).map(rowToEntry);
const verify = async () =>
  (await n.req({ method: 'POST', url: '/v1/audit/verify', payload: {} })).json();

beforeAll(async () => {
  n = await testNode();
  await n.req({ method: 'POST', url: '/v1/teams', payload: { slug: 'team-ops', name: 'Ops' } });
  agentId = (
    await n.req({
      method: 'POST',
      url: '/v1/agents',
      payload: { source: agentSource('trace-agent', 'team-ops') },
    })
  ).json().id;
  await n.req({ method: 'POST', url: `/v1/agents/${agentId}/publish` });
});
afterAll(async () => n.close());
beforeEach(() => resetTelemetryRuntime());
afterEach(() => resetTelemetryRuntime());

describe('trace identity at run creation', () => {
  it('stores a random trace id and root span id on the run row, different per run', async () => {
    const a = (await trigger()).json().id as string;
    const b = (await trigger()).json().id as string;
    const [ra, rb] = [await runRow(a), await runRow(b)];
    for (const r of [ra, rb]) {
      expect(r.traceId).toMatch(HEX32);
      expect(r.traceRootSpanId).toMatch(HEX16);
      expect(r.traceId).not.toBe('0'.repeat(32));
    }
    expect(ra.traceId).not.toBe(rb.traceId);
    expect(ra.traceRootSpanId).not.toBe(rb.traceRootSpanId);
    // Never derived from the run id (or from each other).
    const strip = (s: string) => s.replace(/-/g, '');
    expect(ra.traceId).not.toBe(strip(ra.id));
    expect(strip(ra.id)).not.toContain(ra.traceRootSpanId!);
    expect(ra.traceId!.startsWith(ra.traceRootSpanId!)).toBe(false);
  });

  it('is written once: the database refuses a change', async () => {
    const id = (await trigger()).json().id as string;
    const before = await runRow(id);
    await expect(
      n.ctx.db
        .update(runs)
        .set({ traceId: 'a'.repeat(32) })
        .where(eq(runs.id, id)),
    ).rejects.toThrow();
    await expect(
      n.ctx.db.update(runs).set({ traceRootSpanId: null, traceId: null }).where(eq(runs.id, id)),
    ).rejects.toThrow();
    expect(await runRow(id)).toMatchObject({
      traceId: before.traceId,
      traceRootSpanId: before.traceRootSpanId,
    });
  });

  it('the shape checks refuse half-set, malformed and all-zero ids', async () => {
    const id = (await trigger()).json().id as string;
    const [row] = await n.ctx.db.select().from(runs).where(eq(runs.id, id));
    const base = { ...row!, id: randomUUID() };
    for (const bad of [
      { traceId: 'a'.repeat(32), traceRootSpanId: null },
      { traceId: null, traceRootSpanId: 'a'.repeat(16) },
      { traceId: '0'.repeat(32), traceRootSpanId: 'a'.repeat(16) },
      { traceId: 'a'.repeat(32), traceRootSpanId: '0'.repeat(16) },
      { traceId: 'A'.repeat(32), traceRootSpanId: 'a'.repeat(16) },
      { traceId: 'a'.repeat(31), traceRootSpanId: 'a'.repeat(16) },
    ])
      await expect(
        n.ctx.db.insert(runs).values({ ...base, id: randomUUID(), ...bad }),
      ).rejects.toThrow();
  });
});

describe('no inbound trust', () => {
  it('a traceparent on the API never becomes the run trace (and is counted)', async () => {
    const stats = countingStats();
    configureTelemetryRuntime({ stats });
    const res = await trigger({
      traceparent: FOREIGN_HEADER,
      tracestate: 'vendor=attacker',
      baggage: 'k=v',
    });
    expect(res.statusCode).toBe(202);
    const row = await runRow(res.json().id);
    expect(row.traceId).not.toBe(FOREIGN.traceId);
    expect(row.traceRootSpanId).not.toBe(FOREIGN.spanId);
    expect(stats.inbound).toEqual({ ignored: 1 });
    for (const e of await auditOf(row.id))
      expect(JSON.stringify(e.payload)).not.toContain(FOREIGN.traceId);
  });

  it('counts malformed headers as invalid and never fails the request', async () => {
    const stats = countingStats();
    configureTelemetryRuntime({ stats });
    for (const h of ['garbage', `00-${FOREIGN.traceId}-${FOREIGN.spanId}`, 'x'.repeat(5000)])
      expect((await trigger({ traceparent: h })).statusCode).toBe(202);
    expect(stats.inbound).toEqual({ invalid: 3 });
  });

  it('a traceparent in the event data or the webhook headers is ignored the same way', async () => {
    const res = await n.req({
      method: 'POST',
      url: `/v1/agents/${agentId}/runs`,
      payload: { data: { traceparent: FOREIGN_HEADER, traceId: FOREIGN.traceId } },
      headers: { traceparent: FOREIGN_HEADER },
    });
    const row = await runRow(res.json().id);
    expect(row.traceId).not.toBe(FOREIGN.traceId);
  });

  describe('with an SDK registered', () => {
    let t: ReturnType<typeof startTracing>;
    beforeEach(() => {
      t = startTracing();
    });
    afterEach(async () => t.stop());

    const serverSpan = () =>
      t.exporter.getFinishedSpans().find((s) => s.name === 'POST /v1/agents/:id/runs');

    it('ignore (default): the request span is a fresh root without links', async () => {
      const stats = countingStats();
      configureTelemetryRuntime({ stats });
      await trigger({ traceparent: FOREIGN_HEADER });
      const span = serverSpan()!;
      expect(span).toBeDefined();
      expect(span.spanContext().traceId).not.toBe(FOREIGN.traceId);
      expect(span.parentSpanContext).toBeUndefined();
      expect(span.links).toEqual([]);
      expect(stats.inbound).toEqual({ ignored: 1 });
    });

    it('link: the header becomes a link of the request span, never the parent or the run trace', async () => {
      const linking = await testNode({ OAX_OTEL_INBOUND_CONTEXT: 'link' });
      try {
        await linking.req({
          method: 'POST',
          url: '/v1/teams',
          payload: { slug: 'team-ops', name: 'O' },
        });
        const id = (
          await linking.req({
            method: 'POST',
            url: '/v1/agents',
            payload: { source: agentSource('link-agent', 'team-ops') },
          })
        ).json().id;
        await linking.req({ method: 'POST', url: `/v1/agents/${id}/publish` });
        t.exporter.reset();
        const stats = countingStats();
        configureTelemetryRuntime({ stats });
        const res = await linking.req({
          method: 'POST',
          url: `/v1/agents/${id}/runs`,
          payload: { data: {} },
          headers: { traceparent: FOREIGN_HEADER, tracestate: 'vendor=attacker' },
        });
        const span = serverSpan()!;
        expect(span.parentSpanContext).toBeUndefined();
        expect(span.spanContext().traceId).not.toBe(FOREIGN.traceId);
        expect(span.links).toHaveLength(1);
        expect(span.links[0]!.context).toMatchObject(FOREIGN);
        expect(span.links[0]!.context.traceState).toBeUndefined();
        expect(stats.inbound).toEqual({ linked: 1 });
        const [row] = await linking.ctx.db.select().from(runs).where(eq(runs.id, res.json().id));
        expect(row!.traceId).not.toBe(FOREIGN.traceId);
      } finally {
        await linking.close();
      }
    });
  });
});

describe('audit links', () => {
  it('every audit entry of a run carries payload.otel with the run trace id; verify passes', async () => {
    const id = (await trigger()).json().id as string;
    const row = await runRow(id);
    const entries = await auditOf(id);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect((e.payload as { otel: unknown }).otel).toEqual({
        traceId: row.traceId,
        spanId: row.traceRootSpanId,
      });
    }
    expect(entries[0]!.action).toBe('run.queued');
    expect((await verify()).valid).toBe(true);
  });

  it('more entries of the same run (access denied, cancel) carry the link too', async () => {
    const id = (await trigger()).json().id as string;
    await n.req({ method: 'POST', url: `/v1/runs/${id}/cancel` });
    const row = await runRow(id);
    const actions = (await auditOf(id)).map((e) => e.action);
    expect(actions.length).toBeGreaterThan(1);
    for (const e of await auditOf(id))
      expect((e.payload as { otel: { traceId: string } }).otel.traceId).toBe(row.traceId);
    expect((await verify()).valid).toBe(true);
  });

  it('a caller cannot forge the link: a supplied otel key is replaced or removed', async () => {
    const id = (await trigger()).json().id as string;
    const row = await runRow(id);
    const forged = { traceId: FOREIGN.traceId, spanId: FOREIGN.spanId };
    const withRun = await n.services.audit.append({
      actor: 'test',
      action: 'test.forged',
      runId: id,
      payload: { otel: forged, keep: 1 },
    });
    expect(withRun.payload).toEqual({
      keep: 1,
      otel: { traceId: row.traceId, spanId: row.traceRootSpanId },
    });
    const noRun = await n.services.audit.append({
      actor: 'test',
      action: 'test.forged',
      payload: { otel: forged, keep: 2 },
    });
    expect(noRun.payload).toEqual({ keep: 2 });
    expect((await verify()).valid).toBe(true);
  });

  it('an old run (no trace identity) keeps its entries unchanged and the chain verifies', async () => {
    const id = (await trigger()).json().id as string;
    // Make it look like a run created before the migration: ids are immutable, so insert a copy.
    const [row] = await n.ctx.db.select().from(runs).where(eq(runs.id, id));
    const oldId = randomUUID();
    await n.ctx.db
      .insert(runs)
      .values({ ...row!, id: oldId, traceId: null, traceRootSpanId: null });
    const e = await n.services.audit.append({
      actor: 'test',
      action: 'test.old_run',
      runId: oldId,
      payload: { a: 1 },
    });
    expect(e.payload).toEqual({ a: 1 });
    const nothing = await n.services.audit.append({
      actor: 'test',
      action: 'test.old_run',
      runId: oldId,
    });
    expect(nothing.payload).toBeNull();
    expect((await verify()).valid).toBe(true);
  });

  it('golden: an entry without payload.otel hashes exactly as before the slice', () => {
    const e = createAuditEntry(
      { seq: 41, hash: 'a'.repeat(64) },
      {
        actor: 'user:1',
        action: 'run.queued',
        target: 'agent-1',
        runId: '11111111-1111-4111-8111-111111111111',
        payload: { versionId: 'v1', eventId: 'e1', reason: null },
        ts: new Date('2026-10-10T10:00:00.000Z'),
      },
    );
    // Values computed independently of the code (sha256 over the canonical JSON), pinned: the slice
    // changes neither the digest nor the entry hash of an entry that has no payload.otel.
    expect(e.seq).toBe(42);
    expect(e.payloadDigest).toBe(
      '754ba3664869ef9a71159b37ca8bac82971ea142d25c254f81af9b755a5a5513',
    );
    expect(e.hash).toBe('175c889f994299387690a5abd02b1b58b7750307bf9d7863d1857a61ec161a28');
    // The hash depends only on the digest: old entries verify with the unchanged algorithm.
    expect(verifyAuditChain([e], { anchor: { seq: 41, hash: 'a'.repeat(64) } }).valid).toBe(true);
  });

  it('tampering with the otel field of an entry is detected by the chain', async () => {
    const id = (await trigger()).json().id as string;
    const [entry] = await auditOf(id);
    const [stored] = await n.ctx.db.select().from(auditLog).where(eq(auditLog.seq, entry!.seq));
    // The table is append-only (trigger): simulate someone with raw storage access.
    const rewrite = async (payload: unknown) => {
      await n.ctx.db.execute(sql`set session_replication_role = replica`);
      try {
        await n.ctx.db
          .update(auditLog)
          .set({ payload: payload as object })
          .where(eq(auditLog.seq, entry!.seq));
      } finally {
        await n.ctx.db.execute(sql`set session_replication_role = origin`);
      }
    };
    await rewrite({ ...(stored!.payload as object), otel: FOREIGN });
    try {
      const r = await verify();
      expect(r.valid).toBe(false);
      expect(r.issues.map((i: { code: string }) => i.code)).toContain('payload_mismatch');
    } finally {
      await rewrite(stored!.payload);
    }
    expect((await verify()).valid).toBe(true);
  });
});

describe('oax.run.admit span', () => {
  let t: ReturnType<typeof startTracing>;
  beforeEach(() => {
    t = startTracing();
  });
  afterEach(async () => t.stop());

  it('is the root span with exactly the stored ids and links the request span', async () => {
    const res = await trigger();
    const row = await runRow(res.json().id);
    const spans = t.exporter.getFinishedSpans();
    const admit = spans.filter((s) => s.name === 'oax.run.admit');
    expect(admit).toHaveLength(1);
    const span = admit[0]!;
    expect(span.spanContext()).toMatchObject({
      traceId: row.traceId,
      spanId: row.traceRootSpanId,
    });
    expect(span.parentSpanContext).toBeUndefined();
    const request = spans.find((s) => s.name === 'POST /v1/agents/:id/runs')!;
    expect(span.links).toHaveLength(1);
    expect(span.links[0]!.context).toMatchObject({
      traceId: request.spanContext().traceId,
      spanId: request.spanContext().spanId,
    });
    expect(request.spanContext().traceId).not.toBe(row.traceId);
    const queued = (await auditOf(row.id)).find((e) => e.action === 'run.queued')!;
    expect(span.attributes).toEqual({
      'oax.run.id': row.id,
      'oax.tenant.id': row.tenantId,
      'oax.trigger.kind': 'manual',
      'oax.admission.result': 'queued',
      'oax.audit.seq': queued.seq,
    });
    expect(span.kind).toBe(0); // INTERNAL
  });

  it('golden: spans of one trigger, names, kinds, parents and attribute keys', async () => {
    await trigger();
    const shape = t.exporter
      .getFinishedSpans()
      .map((s) => ({
        name: s.name,
        kind: s.kind,
        parent: s.parentSpanContext ? 'parent' : 'root',
        links: s.links.length,
        keys: Object.keys(s.attributes).sort(),
      }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    expect(shape).toEqual([
      {
        name: 'POST /v1/agents/:id/runs',
        kind: 1,
        parent: 'root',
        links: 0,
        keys: ['http.request.method', 'http.response.status_code', 'http.route', 'oax.access'],
      },
      {
        name: 'oax.run.admit',
        kind: 0,
        parent: 'root',
        links: 1,
        keys: [
          'oax.admission.result',
          'oax.audit.seq',
          'oax.run.id',
          'oax.tenant.id',
          'oax.trigger.kind',
        ],
      },
    ]);
    expect(attributesComply(t.exporter.getFinishedSpans())).toEqual([]);
  });

  it('spans carry only allowlisted attributes (nothing is dropped at the export boundary)', async () => {
    const stats = countingStats();
    configureTelemetryRuntime({ stats });
    await trigger();
    await n.req({ method: 'GET', url: '/v1/runs' });
    expect(attributesComply(t.exporter.getFinishedSpans())).toEqual([]);
    expect(stats.dropped).toEqual({});
  });

  it('the request span names the route pattern only, never ids or the query', async () => {
    const id = (await trigger()).json().id as string;
    t.exporter.reset();
    await n.req({ method: 'GET', url: `/v1/runs/${id}?secret=1` });
    await n.req({ method: 'GET', url: '/healthz', token: null });
    await n.req({ method: 'GET', url: '/no/such/route' });
    const names = t.exporter.getFinishedSpans().map((s) => s.name);
    expect(names).toEqual(['GET /v1/runs/:id']);
    expect(JSON.stringify(t.exporter.getFinishedSpans().map((s) => s.attributes))).not.toContain(
      id,
    );
  });
});

describe('GET /v1/runs/{id}: traceId and tenant isolation', () => {
  it('returns the trace id to a principal that may read the run, and a link when configured', async () => {
    const withTemplate = await testNode({
      OAX_OTEL_TRACE_URL_TEMPLATE: 'https://tempo.example.org/trace/{traceId}',
    });
    try {
      await withTemplate.req({
        method: 'POST',
        url: '/v1/teams',
        payload: { slug: 'team-ops', name: 'O' },
      });
      const aid = (
        await withTemplate.req({
          method: 'POST',
          url: '/v1/agents',
          payload: { source: agentSource('tpl-agent', 'team-ops') },
        })
      ).json().id;
      await withTemplate.req({ method: 'POST', url: `/v1/agents/${aid}/publish` });
      const id = (
        await withTemplate.req({
          method: 'POST',
          url: `/v1/agents/${aid}/runs`,
          payload: { data: {} },
        })
      ).json().id;
      const [row] = await withTemplate.ctx.db.select().from(runs).where(eq(runs.id, id));
      const body = (await withTemplate.req({ method: 'GET', url: `/v1/runs/${id}` })).json();
      expect(body.traceId).toBe(row!.traceId);
      expect(body.traceUrl).toBe(`https://tempo.example.org/trace/${row!.traceId}`);
    } finally {
      await withTemplate.close();
    }
  });

  it('has no link without a template, and null ids for old runs', async () => {
    const id = (await trigger()).json().id as string;
    const body = (await n.req({ method: 'GET', url: `/v1/runs/${id}` })).json();
    expect(body.traceId).toMatch(HEX32);
    expect(body.traceUrl).toBeNull();
    const [row] = await n.ctx.db.select().from(runs).where(eq(runs.id, id));
    const oldId = randomUUID();
    await n.ctx.db
      .insert(runs)
      .values({ ...row!, id: oldId, traceId: null, traceRootSpanId: null });
    const old = (await n.req({ method: 'GET', url: `/v1/runs/${oldId}` })).json();
    expect(old.traceId).toBeNull();
    expect(old.traceUrl).toBeNull();
  });

  it('does not expose trace ids in lists, other responses or to another tenant', async () => {
    const mk = async (slug: string) => {
      const r = await n.req({
        method: 'POST',
        url: '/v1/tenants',
        payload: {
          slug,
          name: slug,
          admin: { email: `admin@${slug}.example.org`, displayName: slug, password: PW },
        },
      });
      expect(r.statusCode).toBe(201);
    };
    await mk('trace-tenant-b');
    const bob = await n.login('admin@trace-tenant-b.example.org', PW);
    const id = (await trigger()).json().id as string;
    const row = await runRow(id);
    // Another tenant's admin: 404, nothing about the run, in particular not the trace id.
    const other = await n.req({ method: 'GET', url: `/v1/runs/${id}`, token: bob });
    expect(other.statusCode).toBe(404);
    expect(other.body).not.toContain(row.traceId!);
    const list = await n.req({ method: 'GET', url: '/v1/runs', token: bob });
    expect(list.body).not.toContain(row.traceId!);
    // Audit entries of the run are tenant-scoped too.
    const audit = await n.req({ method: 'GET', url: `/v1/audit?runId=${id}`, token: bob });
    expect(audit.body).not.toContain(row.traceId!);
    // The owner's own list and trigger responses do not carry the id (detail view only).
    expect((await n.req({ method: 'GET', url: '/v1/runs' })).body).not.toContain(row.traceId!);
    expect((await trigger()).body).not.toContain('traceId');
    // Unauthenticated: nothing.
    expect((await n.req({ method: 'GET', url: `/v1/runs/${id}`, token: null })).statusCode).toBe(
      401,
    );
  });
});
