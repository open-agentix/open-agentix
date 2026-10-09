import { createHash, createHmac } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, costLedger, runs } from '../src/db/schema.js';
import { testNode, RUN_TOKEN_SECRET, type TestNode } from './helpers.js';
import {
  BASE_ENV,
  DONE,
  FakeUpstream,
  ask,
  captureLogger,
  json,
  mkRun,
  modelToken,
  openaiChunk,
  openaiJson,
  openaiUsage,
  parseSse,
  postModel,
  secrets,
  sleep,
  sseResponse,
  tenantScope,
  type LogCapture,
} from './model-proxy-helpers.js';

const up = new FakeUpstream();
let n: TestNode;
let log: LogCapture;

beforeAll(async () => {
  log = captureLogger();
  n = await testNode(
    {
      ...BASE_ENV,
      OAX_MODEL_PROXY_MAX_RESPONSE_BYTES: '2048',
      OAX_MODEL_PROXY_IDLE_SECONDS: '1',
      OAX_MODEL_PROXY_TTFB_SECONDS: '1',
      OAX_MODEL_PROXY_MAX_CALL_SECONDS: '600',
      OAX_MODEL_PROXY_PRIVATE_ALLOW: '10.9.9.9',
    },
    { secrets, fetchImpl: up.fetch, logger: log.logger },
  );
});
afterAll(async () => n.close());
beforeEach(() => up.reset());

const reservations = (runId: string) => n.services.modelAccounting.list(tenantScope, { runId });
const audit = async (runId: string, action: string) =>
  (await n.ctx.db.select().from(auditLog))
    .filter((r) => r.runId === runId && r.action === action)
    .map((r) => ({ ...r, payload: r.payload as Record<string, unknown> }));
const code = (res: { json: () => unknown }) =>
  (res.json() as { error: { code: string } }).error.code;
const gpt = (text = 'hi', extra: Record<string, unknown> = {}) => ask(text, extra, 'gpt-x');
const hang = (_c: unknown, init: RequestInit) =>
  new Promise<Response>((_res, rej) =>
    init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))),
  );

describe('H1: no retries, deadline-bound timeouts, conservative billing', () => {
  it('builds every provider without retries and with the call deadline as HTTP timeout', async () => {
    const scope = { tenantId: tenantScope.tenantId, teamId: null, agentId: 'x' };
    const platform = await n.services.models.resolve(scope, 'oai', { timeoutMs: 7000 });
    expect(platform?.config).toMatchObject({ maxRetries: 0, timeoutMs: 7000 });
    expect(platform?.tenantControlled).toBe(false);
    // not only the shared registry instance: a fresh one per call
    expect((await n.services.models.resolve(scope, 'oai'))?.provider).not.toBe(platform?.provider);
  });

  it('never retries a failing upstream: one request, one reservation, charged', async () => {
    up.handler = () => json({ error: 'overloaded' }, 503);
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    const res = await postModel(n, r.runId, mt, gpt());
    expect(res.statusCode).toBe(502);
    expect(up.calls).toHaveLength(1);
    const all = await reservations(r.runId);
    expect(all).toHaveLength(1);
    expect(Number(all[0]?.actualMicros)).toBe(Number(all[0]?.reservedMicros));
  });

  it('a timed out call is one upstream request, aborted, and charged the reservation', async () => {
    // a short deadline from the agent's own step budget (1 s is the floor)
    up.handler = hang;
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    const res = await postModel(n, r.runId, mt, gpt());
    expect(res.statusCode).toBe(504);
    expect(code(res)).toBe('provider_timeout');
    expect(up.calls).toHaveLength(1);
    expect(up.calls[0]?.aborted).toBe(true);
    const [resv] = await reservations(r.runId);
    expect(Number(resv?.actualMicros)).toBe(Number(resv?.reservedMicros));
  }, 20_000);
});

describe('H2: limits apply to plain JSON answers too', () => {
  it('cuts an upstream response that exceeds OAX_MODEL_PROXY_MAX_RESPONSE_BYTES', async () => {
    let produced = 0;
    up.handler = (_c, init) =>
      sseResponse(
        up,
        async function* (signal) {
          yield openaiChunk({ role: 'assistant', content: '' });
          for (; !signal.aborted && produced < 5000;) {
            produced++;
            yield openaiChunk({ content: '.' });
          }
        },
        init,
      );
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    const res = await postModel(n, r.runId, mt, gpt('hi', { maxTokens: 100_000 }));
    expect(res.statusCode).toBe(502);
    expect(code(res)).toBe('provider_error');
    expect(produced).toBeLessThan(200);
    expect((await reservations(r.runId))[0]?.status).toBe('settled');
  });

  it('hard-stops a provider that ignores max_tokens on the JSON path (403 control_budget_cost)', async () => {
    let produced = 0;
    up.handler = (_c, init) =>
      sseResponse(
        up,
        async function* (signal) {
          yield openaiChunk({ role: 'assistant', content: '' });
          while (!signal.aborted && produced < 100) {
            produced++;
            yield openaiChunk({ content: 'x'.repeat(30) });
            await sleep(2, signal);
          }
        },
        init,
      );
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    // bound 16 tokens: cut after 16 * 1.1 * 8 = 140 bytes, below the 2048 byte response limit
    const res = await postModel(n, r.runId, mt, gpt('hi', { maxTokens: 16 }));
    expect(res.statusCode).toBe(403);
    expect(code(res)).toBe('control_budget_cost');
    expect(produced).toBeLessThan(20);
    expect((await audit(r.runId, 'model.aborted'))[0]?.payload.reason).toBe('output_overrun');
  });

  it('ends a stalled upstream with provider_timeout (idle and time to first byte)', async () => {
    up.handler = (_c, init) =>
      sseResponse(
        up,
        async function* (signal) {
          yield openaiChunk({ role: 'assistant', content: '' });
          await sleep(5000, signal);
        },
        init,
      );
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    const t0 = Date.now();
    const res = await postModel(n, r.runId, mt, gpt());
    expect(res.statusCode).toBe(504);
    expect(code(res)).toBe('provider_timeout');
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(up.calls[0]?.aborted).toBe(true);
    const stalled = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const t2 = await modelToken(n, stalled);
    up.handler = hang;
    const noByte = await postModel(n, stalled.runId, t2, gpt());
    expect(noByte.statusCode).toBe(504);
  }, 20_000);
});

describe('M1: the deadline of a late step', () => {
  const deadlineOf = async (runId: string) => {
    const [r] = await reservations(runId);
    return r!.expiresAt.getTime() - r!.createdAt.getTime() - 60_000;
  };
  const startedAgo = (runId: string, seconds: number) =>
    n.ctx.db
      .update(runs)
      .set({ startedAt: new Date(Date.now() - seconds * 1000) })
      .where(eq(runs.id, runId));

  it('measures the step timeout from the step start, not from the run start', async () => {
    const r = await mkRun(n, {
      provider: 'oai',
      model: 'gpt-x',
      agentBudget: '      timeoutSeconds: 60',
    });
    await startedAgo(r.runId, 7000);
    const mt = await modelToken(n, r);
    expect((await postModel(n, r.runId, mt, gpt())).statusCode).toBe(200);
    expect(await deadlineOf(r.runId)).toBeGreaterThan(55_000);
    expect(await deadlineOf(r.runId)).toBeLessThanOrEqual(60_000);
  });

  it('bounds the call by whichever of run and step has less time left', async () => {
    const r = await mkRun(n, {
      provider: 'oai',
      model: 'gpt-x',
      budget: '  timeoutSeconds: 1000',
      agentBudget: '      timeoutSeconds: 600',
    });
    await startedAgo(r.runId, 900);
    const mt = await modelToken(n, r);
    expect((await postModel(n, r.runId, mt, gpt())).statusCode).toBe(200);
    // the run has 100 s left, the step 600 s
    const d = await deadlineOf(r.runId);
    expect(d).toBeGreaterThan(95_000);
    expect(d).toBeLessThanOrEqual(100_000);
  });

  it('keeps the one second floor for a run that is out of time', async () => {
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x', budget: '  timeoutSeconds: 100' });
    await startedAgo(r.runId, 5000);
    const mt = await modelToken(n, r);
    await postModel(n, r.runId, mt, gpt());
    expect(await deadlineOf(r.runId)).toBe(1000);
  });
});

describe('M2: reported usage is capped by the reservation', () => {
  const claudeStream = (usage: Record<string, number>, outputTokens: number) => () =>
    new Response(
      [
        `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { model: 'claude-x', usage } })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: outputTokens } })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
      ].join(''),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );

  it('caps absurd input and cache counts and audits the raw numbers in model.overrun only', async () => {
    up.handler = claudeStream(
      {
        input_tokens: Number.MAX_SAFE_INTEGER,
        cache_read_input_tokens: 2_000_000_000,
        cache_creation_input_tokens: 2_000_000_000,
        output_tokens: 1,
      },
      20,
    );
    const r = await mkRun(n, { provider: 'claude', model: 'claude-x' });
    const mt = await modelToken(n, r);
    const res = await postModel(n, r.runId, mt, ask('x', { maxTokens: 400 }, 'claude-x'));
    expect(res.statusCode).toBe(200);
    const [resv] = await reservations(r.runId);
    const [line] = await n.ctx.db.select().from(costLedger).where(eq(costLedger.runId, r.runId));
    expect(line!.tokensIn).toBeLessThanOrEqual(resv!.reservedInputTokens);
    expect(line!.cacheReadTokens + line!.cacheWriteTokens).toBeLessThanOrEqual(
      resv!.reservedInputTokens,
    );
    expect(Number(line!.costMicros)).toBeLessThanOrEqual(Number(resv!.reservedMicros));
    const [overrun] = await audit(r.runId, 'model.overrun');
    expect(overrun?.payload).toMatchObject({
      reason: 'reported_usage_capped',
      reported: { input: Number.MAX_SAFE_INTEGER, cacheRead: 2_000_000_000 },
    });
    expect(JSON.stringify(await audit(r.runId, 'step.model_call'))).not.toContain(
      String(Number.MAX_SAFE_INTEGER),
    );
    expect(JSON.stringify(res.json())).not.toContain(String(Number.MAX_SAFE_INTEGER));
  });

  it('ends a call whose provider reports absurd output and charges at most the reservation', async () => {
    up.handler = (_c, init) =>
      sseResponse(
        up,
        async function* () {
          yield openaiChunk({ role: 'assistant', content: '' });
          yield openaiChunk({ content: 'ok' }, 'stop');
          yield openaiUsage(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
          yield DONE;
        },
        init,
      );
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    const res = await postModel(n, r.runId, mt, gpt('hi', { maxTokens: 500 }));
    expect(res.statusCode).toBe(403);
    expect(code(res)).toBe('control_budget_cost');
    const [resv] = await reservations(r.runId);
    const [line] = await n.ctx.db.select().from(costLedger).where(eq(costLedger.runId, r.runId));
    expect(line!.tokensIn).toBeLessThanOrEqual(resv!.reservedInputTokens);
    expect(line!.tokensOut).toBeLessThanOrEqual(Math.ceil(500 * 1.1) + 256);
    expect(Number(line!.costMicros)).toBeLessThanOrEqual(Number(resv!.reservedMicros));
  });

  it('keeps honest usage untouched', async () => {
    up.handler = claudeStream({ input_tokens: 25, output_tokens: 1 }, 20);
    const r = await mkRun(n, { provider: 'claude', model: 'claude-x' });
    const mt = await modelToken(n, r);
    const res = await postModel(n, r.runId, mt, ask('x', { maxTokens: 400 }, 'claude-x'));
    expect(res.json().usage).toMatchObject({
      inputTokens: 25,
      outputTokens: 20,
      source: 'provider',
    });
    expect(await audit(r.runId, 'model.overrun')).toEqual([]);
  });
});

describe('M3: tenant-controlled endpoints', () => {
  const PW = 'long-password-123';
  let bob: string;
  const asB = (o: Parameters<TestNode['req']>[0]) => n.req({ ...o, token: bob });

  beforeAll(async () => {
    await n.req({
      method: 'POST',
      url: '/v1/tenants',
      payload: {
        slug: 'tenant-b',
        name: 'B',
        admin: { email: 'admin@tenant-b.example.org', displayName: 'B', password: PW },
      },
    });
    bob = await n.login('admin@tenant-b.example.org', PW);
    await asB({ method: 'POST', url: '/v1/teams', payload: { slug: 'team-security', name: 'S' } });
  });

  const connect = async (name: string, baseUrl: string) => {
    const res = await asB({
      method: 'POST',
      url: '/v1/connections',
      payload: {
        name,
        kind: 'model',
        config: {
          kind: 'openai-compatible',
          baseUrl,
          apiKeySecret: 'tenant-b.openai',
          clearance: 'internal',
        },
      },
    });
    expect(res.statusCode).toBe(201);
  };

  for (const [name, url] of [
    ['loop', 'http://127.0.0.1:8080/v1'],
    ['meta', 'http://169.254.169.254/latest/api'],
    ['priv', 'http://10.0.0.5/v1'],
    ['priv2', 'http://192.168.1.10/v1'],
    ['v6', 'http://[::1]:8080/v1'],
    ['mapped', 'http://[::ffff:127.0.0.1]/v1'],
  ] as const) {
    it(`refuses a tenant connection to ${url} (egress_denied) without any request`, async () => {
      await connect(name, url);
      const r = await mkRun(n, { provider: name, model: 'm' }, asB);
      const tok = await n.req({
        method: 'POST',
        url: `/v1/worker/runs/${r.runId}/model-token`,
        token: r.runToken,
        payload: { agentId: 'a' },
      });
      const mt = tok.json().token as string;
      const res = await postModel(n, r.runId, mt, ask('hi', {}, 'm'));
      expect(res.statusCode).toBe(403);
      expect(code(res)).toBe('egress_denied');
      expect(up.calls).toHaveLength(0);
      expect(await reservations(r.runId)).toEqual([]);
    });
  }

  it('lets the operator allowlist a private destination', async () => {
    await connect('allowed', 'http://10.9.9.9/v1');
    up.handler = () => openaiJson({ text: 'internal' });
    const r = await mkRun(n, { provider: 'allowed', model: 'm' }, asB);
    const tok = await n.req({
      method: 'POST',
      url: `/v1/worker/runs/${r.runId}/model-token`,
      token: r.runToken,
      payload: { agentId: 'a' },
    });
    const res = await postModel(n, r.runId, tok.json().token as string, ask('hi', {}, 'm'));
    expect(res.statusCode).toBe(200);
    expect(up.calls[0]?.url).toBe('http://10.9.9.9/v1/chat/completions');
  });

  it('never follows redirects and never returns upstream text to the node', async () => {
    up.handler = () =>
      json(
        { error: { message: 'internal host db.corp.example refused: SECRET-UPSTREAM-DETAIL' } },
        500,
      );
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    const res = await postModel(n, r.runId, mt, gpt());
    expect(up.calls[0]?.redirect).toBe('error');
    expect(res.statusCode).toBe(502);
    expect(res.json().error.message).toBe('the provider answered with HTTP 500');
    expect(
      res.body + log.text() + JSON.stringify(await audit(r.runId, 'step.model_call')),
    ).not.toContain('SECRET-UPSTREAM-DETAIL');
    // an error event inside a stream is reduced to its kind as well
    up.handler = (_c, init) =>
      sseResponse(
        up,
        async function* () {
          yield `event: error\ndata: ${JSON.stringify({ type: 'error', error: { message: 'LEAK-FROM-STREAM' } })}\n\n`;
        },
        init,
      );
    const claude = await mkRun(n, { provider: 'claude', model: 'claude-x' });
    const ct = await modelToken(n, claude);
    const sres = await n.req({
      method: 'POST',
      url: `/v1/worker/runs/${claude.runId}/model`,
      token: ct,
      payload: ask('x', {}, 'claude-x') as never,
      headers: { accept: 'text/event-stream' },
    });
    const events = parseSse(sres.body);
    expect(events.at(-1)).toMatchObject({ event: 'error', data: { code: 'provider_error' } });
    expect(sres.body).not.toContain('LEAK-FROM-STREAM');
  });
});

describe('low findings', () => {
  it('L3: the request digest is an HMAC under a per-tenant key, not a plain SHA-256', async () => {
    const chat = { model: 'm', messages: [{ role: 'user', content: 'guess me' }] };
    const svc = n.services.modelProxy as unknown as {
      digest: (tenant: string, c: unknown) => string;
    };
    const a = svc.digest('tenant-a', chat);
    const key = createHmac('sha256', RUN_TOKEN_SECRET)
      .update('openagentix/model-digest/v1:tenant-a')
      .digest();
    expect(a).toBe(createHmac('sha256', key).update(JSON.stringify(chat)).digest('hex'));
    expect(a).not.toBe(createHash('sha256').update(JSON.stringify(chat)).digest('hex'));
    expect(svc.digest('tenant-b', chat)).not.toBe(a);
  });

  it('L4: a removed connection stops working on the next call despite the 30 s cache', async () => {
    const created = await n.req({
      method: 'POST',
      url: '/v1/connections',
      payload: {
        name: 'short-lived',
        kind: 'model',
        config: {
          kind: 'openai-compatible',
          baseUrl: 'https://llm.short.example/v1',
          clearance: 'internal',
        },
      },
    });
    expect(created.statusCode).toBe(201);
    up.handler = () => openaiJson({ text: 'fine' });
    const r = await mkRun(n, { provider: 'short-lived', model: 'm' });
    const mt = await modelToken(n, r);
    expect((await postModel(n, r.runId, mt, ask('hi', {}, 'm'))).statusCode).toBe(200);
    // warm the shared cache, then delete
    const scope = { tenantId: tenantScope.tenantId, teamId: null, agentId: 'x' };
    await n.services.catalog.connectionsForRun('model', scope);
    expect(
      (await n.req({ method: 'DELETE', url: `/v1/connections/${created.json().id}` })).statusCode,
    ).toBe(204);
    const after = await postModel(n, r.runId, mt, ask('hi', {}, 'm'));
    expect(after.statusCode).toBe(403);
    expect(code(after)).toBe('model_not_allowed');
  });

  it('L6: a failing begin() settles the reservation and reports an error instead of hanging', async () => {
    up.handler = (_c, init) =>
      sseResponse(
        up,
        async function* () {
          yield openaiChunk({ role: 'assistant', content: '' });
          yield openaiChunk({ content: 'hi' }, 'stop');
          yield openaiUsage(30, 5);
          yield DONE;
        },
        init,
      );
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    const auth = await n.services.modelProxy.authenticate(mt, r.runId);
    await expect(
      n.services.modelProxy.stream(auth, gpt(), {
        signal: new AbortController().signal,
        begin: () => {
          throw new Error('socket exploded');
        },
      }),
    ).rejects.toMatchObject({ code: 'model_proxy_unavailable' });
    const [resv] = await reservations(r.runId);
    expect(resv?.status).toBe('settled');
    await sleep(20);
    expect(up.open).toBe(0);
  });

  it('L8: metric labels use the provider family, never a tenant-chosen connection name', async () => {
    await n.req({
      method: 'POST',
      url: '/v1/connections',
      payload: {
        name: 'tenant-picked-name',
        kind: 'model',
        config: {
          kind: 'openai-compatible',
          baseUrl: 'https://llm.picked.example/v1',
          clearance: 'internal',
        },
      },
    });
    up.handler = () => openaiJson({ text: 'x' });
    const r = await mkRun(n, { provider: 'tenant-picked-name', model: 'm' });
    const mt = await modelToken(n, r);
    expect((await postModel(n, r.runId, mt, ask('hi', {}, 'm'))).statusCode).toBe(200);
    const proxy = (await n.ctx.metrics.registry.metrics())
      .split('\n')
      .filter((l) => l.startsWith('oax_model_proxy_'))
      .join('\n');
    expect(proxy).not.toContain('tenant-picked-name');
    expect(proxy).toContain('provider="openai-compatible"');
  });

  it('L8: budget refusals do not name teams, use cases or numbers', async () => {
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    await n.ctx.db.execute(
      sql`update tenants set monthly_budget_micros = 1 where id = ${tenantScope.tenantId}`,
    );
    try {
      const res = await postModel(n, r.runId, mt, gpt());
      expect(res.statusCode).toBe(403);
      expect(code(res)).toBe('control_budget_tenant');
      expect(res.json().error.message).toBe('a monthly budget cannot cover the call');
    } finally {
      await n.ctx.db.execute(
        sql`update tenants set monthly_budget_micros = null where id = ${tenantScope.tenantId}`,
      );
    }
  });
});
