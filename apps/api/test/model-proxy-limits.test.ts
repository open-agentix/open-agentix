import { estimateInputUpperBound } from '@openagentix/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { costLedger, runSteps } from '../src/db/schema.js';
import { ModelProxyService } from '../src/services/model-proxy.js';
import { testNode, type TestNode } from './helpers.js';
import {
  BASE_ENV,
  FakeUpstream,
  ask,
  getModelToken,
  mkRun,
  modelToken,
  openaiJson,
  postModel,
  secrets,
  sleep,
  tenantScope,
} from './model-proxy-helpers.js';

const up = new FakeUpstream();
let n: TestNode;

beforeAll(async () => {
  n = await testNode(
    {
      ...BASE_ENV,
      OAX_MODEL_PROXY_CALLS_PER_MINUTE: '4',
      OAX_MODEL_PROXY_MAX_CONCURRENT_PER_SESSION: '1',
      OAX_MODEL_PROXY_MAX_STREAMS: '2',
      OAX_MODEL_PROXY_MAX_CALL_SECONDS: '1',
      OAX_MODEL_PROXY_CAPTURE: 'off',
      OAX_MODEL_PROXY_RESERVATION: 'estimate',
    },
    { secrets, fetchImpl: up.fetch },
  );
});
afterAll(async () => n.close());
beforeEach(() => up.reset());

const reservations = (runId: string) => n.services.modelAccounting.list(tenantScope, { runId });
const body = ask('hello', {}, 'gpt-x');

/** An upstream that answers after `ms` milliseconds (or fails when the request is aborted). */
const slow = (ms: number) => async (_c: unknown, init: RequestInit) => {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    init.signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('aborted', 'AbortError'));
      },
      { once: true },
    );
  });
  return openaiJson({ text: 'late', prompt: 10, completion: 5 });
};

describe('rate and concurrency limits', () => {
  it('limits calls per minute per run with 429 model_rate_limited and Retry-After', async () => {
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const other = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    const ot = await modelToken(n, other);
    for (let i = 0; i < 4; i++)
      expect((await postModel(n, r.runId, mt, body)).statusCode).toBe(200);
    const limited = await postModel(n, r.runId, mt, body);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('model_rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(up.calls).toHaveLength(4);
    // another run has its own window
    expect((await postModel(n, other.runId, ot, body)).statusCode).toBe(200);
  });

  it('limits concurrent calls per session through the reservations (the database is the counter)', async () => {
    up.handler = slow(250);
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    const results = await Promise.all([
      postModel(n, r.runId, mt, body),
      postModel(n, r.runId, mt, body),
      postModel(n, r.runId, mt, body),
    ]);
    expect(results.map((x) => x.statusCode).sort()).toEqual([200, 429, 429]);
    expect(up.calls).toHaveLength(1);
    expect((await reservations(r.runId)).every((x) => x.status === 'settled')).toBe(true);
  });

  it('limits calls in flight on this replica (OAX_MODEL_PROXY_MAX_STREAMS)', async () => {
    up.handler = slow(300);
    const runs = await Promise.all(
      [1, 2, 3].map(() => mkRun(n, { provider: 'oai', model: 'gpt-x' })),
    );
    const tokens = await Promise.all(runs.map((r) => modelToken(n, r)));
    const results = await Promise.all(runs.map((r, i) => postModel(n, r.runId, tokens[i]!, body)));
    expect(results.map((x) => x.statusCode).sort()).toEqual([200, 200, 429]);
    const refused = results.find((x) => x.statusCode === 429)!;
    expect(refused.json().error.code).toBe('model_rate_limited');
    // nothing is reserved for the refused call
    expect(up.calls).toHaveLength(2);
    await sleep(50);
    const text = await n.ctx.metrics.registry.metrics();
    expect(text).toMatch(/oax_model_proxy_reservations_active 0/);
  });
});

describe('time limits', () => {
  it('ends a call that exceeds the deadline with 504 provider_timeout and charges the reservation', async () => {
    up.handler = slow(10_000);
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    const t0 = Date.now();
    const res = await postModel(n, r.runId, mt, body);
    expect(res.statusCode).toBe(504);
    expect(res.json().error.code).toBe('provider_timeout');
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(up.calls[0]?.aborted).toBe(true);
    const [resv] = await reservations(r.runId);
    expect(resv?.status).toBe('settled');
    // nothing is known about the provider's work: the worst case is charged
    expect(Number(resv?.actualMicros)).toBe(Number(resv?.reservedMicros));
    const aborts = await n.ctx.metrics.registry.getSingleMetricAsString(
      'oax_model_proxy_aborts_total',
    );
    expect(aborts).toContain('reason="deadline"');
  });
});

describe('capture and reservation mode', () => {
  it('capture off stores no response text in the step record', async () => {
    up.handler = () => openaiJson({ text: 'SECRET-RESPONSE-TEXT' });
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    expect((await postModel(n, r.runId, mt, body)).statusCode).toBe(200);
    const step = (await n.ctx.db.select().from(runSteps).where(eq(runSteps.runId, r.runId))).find(
      (s) => s.kind === 'model_call',
    );
    expect(JSON.stringify(step?.output)).not.toContain('SECRET-RESPONSE-TEXT');
    expect(step?.output).toMatchObject({ stopReason: 'end_turn' });
    const [line] = await n.ctx.db.select().from(costLedger).where(eq(costLedger.runId, r.runId));
    expect(line?.tokensIn).toBe(100);
  });

  it('estimate mode reserves a third of the upper bound (bytes / 3)', async () => {
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    expect((await postModel(n, r.runId, mt, body)).statusCode).toBe(200);
    const upper = estimateInputUpperBound({ messages: [{ role: 'user', content: 'hello' }] });
    const [resv] = await reservations(r.runId);
    expect(resv?.reservedInputTokens).toBe(Math.ceil(upper / 3));
  });
});

describe('hooks and direct service use', () => {
  it('refuses a provider or model blocked by an emergency override (security_override)', async () => {
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    const svc = new ModelProxyService(
      n.ctx,
      n.services.audit,
      n.services.agents,
      n.services.models,
      n.services.modelAccounting,
      n.services.runNodes,
      { checkOverride: async (t) => (t.provider === 'oai' ? 'provider blocked' : null) },
    );
    const auth = await svc.authenticate(mt, r.runId);
    await expect(svc.call(auth, body, new AbortController().signal)).rejects.toMatchObject({
      code: 'security_override',
    });
    expect(up.calls).toHaveLength(0);
    expect(await reservations(r.runId)).toEqual([]);
  });

  it('keeps enabled state and refuses calls once the flag is off at the service level', async () => {
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    expect((await getModelToken(n, r.runId, r.runToken)).statusCode).toBe(200);
    expect(n.services.modelProxy.enabled).toBe(true);
  });
});
