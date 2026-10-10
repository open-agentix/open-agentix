import { schema } from '@openagentix/api';
import { demoServerFactories, inMemoryServers } from '@openagentix/mcp';
import type { Runner, RunResult } from '@openagentix/runners';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetTelemetryRuntime } from '../../api/src/telemetry.js';
import { agentSource } from '../../api/test/fixtures.js';
import { testNode, type TestNode } from '../../api/test/helpers.js';
import { attributesComply, startTracing } from '../../api/test/trace-harness.js';
import { RunQueue, Worker } from '../src/index.js';

/** Slice S2 of ADR 0015 for the worker: one trace per run, one `invoke_workflow` span per attempt. */
let n: TestNode;
let agentId: string;
let t: ReturnType<typeof startTracing>;

beforeAll(async () => {
  n = await testNode({
    OAX_WORKER_CONCURRENCY: '2',
    OAX_WORKER_POLL_MS: '50',
    OAX_WORKER_MAX_ATTEMPTS: '3',
    OAX_WORKER_LEASE_SECONDS: '10',
  });
  await n.req({ method: 'POST', url: '/v1/teams', payload: { slug: 'team-ops', name: 'Ops' } });
  agentId = (
    await n.req({
      method: 'POST',
      url: '/v1/agents',
      payload: { source: agentSource('traced-agent', 'team-ops') },
    })
  ).json().id;
  await n.req({ method: 'POST', url: `/v1/agents/${agentId}/publish` });
});
afterAll(async () => n.close());
beforeEach(() => {
  t = startTracing();
});
afterEach(async () => {
  await t.stop();
  resetTelemetryRuntime();
});

const enqueue = async () =>
  (
    await n.req({ method: 'POST', url: `/v1/agents/${agentId}/runs`, payload: { data: { n: 1 } } })
  ).json().id as string;
const row = async (id: string) =>
  (await n.ctx.db.select().from(schema.runs).where(eq(schema.runs.id, id)))[0]!;
const attemptSpans = () =>
  t.exporter.getFinishedSpans().filter((s) => s.name.startsWith('invoke_workflow'));
const worker = (id: string, runner?: Runner) =>
  new Worker(n.ctx, {
    workerId: id,
    inMemoryMcp: inMemoryServers(demoServerFactories()),
    ...(runner ? { runner } : {}),
  });

describe('invoke_workflow per attempt', () => {
  it('replaces oax.run: a child of the stored root span, in the run trace, with the audit link', async () => {
    const id = await enqueue();
    const stored = await row(id);
    const w = worker('w-golden');
    expect(await w.tick()).toContain(id);
    await w.drain();

    const spans = t.exporter.getFinishedSpans();
    expect(spans.some((s) => s.name === 'oax.run')).toBe(false);
    const [attempt] = attemptSpans();
    expect(attempt!.name).toBe('invoke_workflow traced-agent');
    expect(attempt!.spanContext().traceId).toBe(stored.traceId);
    expect(attempt!.parentSpanContext?.spanId).toBe(stored.traceRootSpanId);
    expect(attempt!.spanContext().spanId).not.toBe(stored.traceRootSpanId);

    const done = (
      await n.ctx.db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.runId, id))
        .orderBy(schema.auditLog.seq)
    ).find((e) => e.action === 'run.completed')!;
    // The attempt span documents run.completed, in both directions.
    expect((done.payload as { otel: unknown }).otel).toEqual({
      traceId: stored.traceId,
      spanId: attempt!.spanContext().spanId,
    });
    expect(attempt!.attributes['oax.audit.seq']).toBe(done.seq);

    expect(Object.keys(attempt!.attributes).sort()).toEqual([
      'gen_ai.operation.name',
      'gen_ai.usage.input_tokens',
      'gen_ai.usage.output_tokens',
      'gen_ai.workflow.name',
      'oax.agent.version',
      'oax.audit.seq',
      'oax.cost.micro_usd',
      'oax.run.attempt',
      'oax.run.id',
      'oax.run.status',
      'oax.tenant.id',
      'oax.tenant.root_id',
    ]);
    expect(attempt!.attributes).toMatchObject({
      'gen_ai.operation.name': 'invoke_workflow',
      'gen_ai.workflow.name': 'traced-agent',
      'oax.run.attempt': 1,
      'oax.run.id': id,
      'oax.run.status': 'succeeded',
    });
    expect(attributesComply(spans)).toEqual([]);
    // admission root and attempt: the whole run is one trace.
    const admit = spans.find((s) => s.name === 'oax.run.admit');
    expect(admit?.spanContext().spanId).toBe(stored.traceRootSpanId);
    expect(
      new Set(
        spans.filter((s) => s.parentSpanContext || s === admit).map((s) => s.spanContext().traceId),
      ).size,
    ).toBeGreaterThanOrEqual(1);
  });

  it('a worker crash and a second attempt stay in the same trace', async () => {
    const id = await enqueue();
    const stored = await row(id);

    // Attempt 1 hangs (the process "dies"): its span never ends, so nothing of it is exported.
    let crash!: () => void;
    const hung = new Promise<RunResult>((_, reject) => (crash = () => reject(new Error('gone'))));
    const w1 = worker('w-crash', { kind: 'in-process', execute: () => hung });
    expect(await w1.tick()).toContain(id);
    expect((await row(id)).attempts).toBe(1);

    // The lease expires; another worker's reaper requeues the run, which keeps its trace identity.
    await n.ctx.db
      .update(schema.runs)
      .set({ leaseUntil: new Date(Date.now() - 1000), availableAt: new Date(Date.now() - 1000) })
      .where(eq(schema.runs.id, id));
    expect(await new RunQueue(n.ctx, 'w-reaper').reapExpired()).toBeGreaterThanOrEqual(1);
    await n.ctx.db
      .update(schema.runs)
      .set({ availableAt: new Date(Date.now() - 1000) })
      .where(eq(schema.runs.id, id));
    const requeued = await row(id);
    expect(requeued.status).toBe('queued');
    expect(requeued.traceId).toBe(stored.traceId);
    expect(requeued.traceRootSpanId).toBe(stored.traceRootSpanId);

    const w2 = worker('w-retry');
    expect(await w2.tick()).toContain(id);
    await w2.drain();
    expect((await row(id)).attempts).toBe(2);

    const [second] = attemptSpans();
    expect(second!.attributes['oax.run.attempt']).toBe(2);
    expect(second!.spanContext().traceId).toBe(stored.traceId);
    expect(second!.parentSpanContext?.spanId).toBe(stored.traceRootSpanId);

    // The lost attempt ends late (a zombie): its span joins the same trace as a sibling.
    crash();
    await w1.drain();
    const attempts = attemptSpans().sort(
      (a, b) => Number(a.attributes['oax.run.attempt']) - Number(b.attributes['oax.run.attempt']),
    );
    expect(attempts.map((s) => s.attributes['oax.run.attempt'])).toEqual([1, 2]);
    for (const s of attempts) {
      expect(s.spanContext().traceId).toBe(stored.traceId);
      expect(s.parentSpanContext?.spanId).toBe(stored.traceRootSpanId);
    }
    expect(attempts[0]!.status.code).toBe(2); // ERROR; the message is a code, never the text
    expect(JSON.stringify(attempts[0]!.events)).not.toContain('gone');
    expect(attempts[0]!.spanContext().spanId).not.toBe(attempts[1]!.spanContext().spanId);
  });

  it('every audit entry of both attempts links to the one trace', async () => {
    const id = await enqueue();
    const stored = await row(id);
    const w = worker('w-audit');
    await w.tick();
    await w.drain();
    const entries = await n.ctx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.runId, id));
    expect(entries.length).toBeGreaterThan(1);
    for (const e of entries)
      expect((e.payload as { otel: { traceId: string } }).otel.traceId).toBe(stored.traceId);
    const verify = (await n.req({ method: 'POST', url: '/v1/audit/verify', payload: {} })).json();
    expect(verify.valid).toBe(true);
  });

  it('a run created before the trace identity existed starts its own trace and has no audit link', async () => {
    const id = await enqueue();
    // Simulate a pre-migration run: copy the row without ids.
    const [r] = await n.ctx.db.select().from(schema.runs).where(eq(schema.runs.id, id));
    await n.ctx.db.update(schema.runs).set({ status: 'cancelled' }).where(eq(schema.runs.id, id));
    const oldId = '5d1b0e0e-2f4e-4c55-a63e-3a2c1d9f0b11';
    await n.ctx.db
      .insert(schema.runs)
      .values({ ...r!, id: oldId, traceId: null, traceRootSpanId: null });
    const w = worker('w-old');
    expect(await w.tick()).toContain(oldId);
    await w.drain();
    const [attempt] = attemptSpans().filter((s) => s.attributes['oax.run.id'] === oldId);
    expect(attempt).toBeDefined();
    expect(attempt!.parentSpanContext).toBeUndefined();
    const entries = await n.ctx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.runId, oldId));
    for (const e of entries) expect(JSON.stringify(e.payload ?? null)).not.toContain('otel');
  });
});
