import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, costLedger, runSteps } from '../src/db/schema.js';
import { testNode, type TestNode } from './helpers.js';
import {
  BASE_ENV,
  DONE,
  FakeUpstream,
  PLATFORM_ANTHROPIC_KEY,
  PLATFORM_OPENAI_KEY,
  ask,
  captureLogger,
  json,
  mkRun,
  modelToken,
  openaiChunk,
  openaiUsage,
  parseSse,
  secrets,
  sleep,
  sse,
  sseResponse,
  tenantScope,
  type LogCapture,
} from './model-proxy-helpers.js';

const up = new FakeUpstream();
let log: LogCapture;
let n: TestNode;

beforeAll(async () => {
  log = captureLogger();
  n = await testNode(BASE_ENV, { secrets, fetchImpl: up.fetch, logger: log.logger });
});
afterAll(async () => n.close());
beforeEach(() => up.reset());

const reservations = (runId: string) => n.services.modelAccounting.list(tenantScope, { runId });
const ledger = (runId: string) =>
  n.ctx.db.select().from(costLedger).where(eq(costLedger.runId, runId));
const steps = (runId: string) => n.ctx.db.select().from(runSteps).where(eq(runSteps.runId, runId));
const audit = async (runId: string, action: string) =>
  (await n.ctx.db.select().from(auditLog))
    .filter((r) => r.runId === runId && r.action === action)
    .map((r) => ({ ...r, payload: r.payload as Record<string, unknown> }));

const stream = (runId: string, token: string, payload: unknown) =>
  n.req({
    method: 'POST',
    url: `/v1/worker/runs/${runId}/model`,
    token,
    payload: payload as never,
    headers: { accept: 'text/event-stream' },
  });

const openaiText = (init: RequestInit) =>
  sseResponse(
    up,
    async function* () {
      yield openaiChunk({ role: 'assistant', content: '' });
      yield openaiChunk({ content: 'Hel' });
      yield openaiChunk({ content: 'lo ' });
      yield openaiChunk({ content: 'wörld' }, 'stop');
      yield openaiUsage(30, 12);
      yield DONE;
    },
    init,
  );

describe('native endpoint as Server-Sent Events', () => {
  it('streams deltas and a final done event; usage and cost come from the provider', async () => {
    up.handler = (_c, init) => openaiText(init);
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    const res = await stream(r.runId, mt, ask('hi', { maxTokens: 500 }, 'gpt-x'));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['cache-control']).toContain('no-store');
    const events = parseSse(res.body);
    expect(events.map((e) => e.event)).toEqual(['start', 'delta', 'delta', 'delta', 'done']);
    expect(events.filter((e) => e.event === 'delta').map((e) => e.data.text)).toEqual([
      'Hel',
      'lo ',
      'wörld',
    ]);
    const done = events.at(-1)!.data as {
      callId: string;
      response: { text: string; stopReason: string };
      usage: { inputTokens: number; outputTokens: number; source: string };
      costMicros: number;
    };
    expect(events[0]!.data.callId).toBe(done.callId);
    expect(res.headers['x-oax-call-id']).toBe(done.callId);
    expect(done.response).toMatchObject({ text: 'Hello wörld', stopReason: 'end_turn' });
    // 30 in x 10 + 12 out x 20 (USD per MTok) = 540 micro-USD
    expect(done).toMatchObject({
      usage: { inputTokens: 30, outputTokens: 12, source: 'provider' },
      costMicros: 540,
    });
    // upstream: streaming request built from the validated fields with the platform key
    const call = up.calls[0]!;
    expect(call.body).toMatchObject({
      model: 'gpt-x',
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 500,
    });
    expect(call.headers.authorization).toBe(`Bearer ${PLATFORM_OPENAI_KEY}`);
    expect(res.body).not.toContain(PLATFORM_OPENAI_KEY);
    expect((await reservations(r.runId))[0]).toMatchObject({ status: 'settled' });
    expect((await ledger(r.runId))[0]).toMatchObject({
      via: 'proxy',
      usageSource: 'provider',
      tokensIn: 30,
      tokensOut: 12,
    });
    expect((await steps(r.runId)).find((s) => s.kind === 'model_call')?.output).toMatchObject({
      text: 'Hello wörld',
    });
  });

  it('streams an Anthropic tool-use turn and relays the tool call in the done event', async () => {
    up.handler = (_c, init) =>
      sseResponse(
        up,
        async function* () {
          yield sse(
            {
              type: 'message_start',
              message: {
                id: 'm',
                model: 'claude-x',
                usage: { input_tokens: 25, output_tokens: 1 },
              },
            },
            'message_start',
          );
          yield sse(
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            'content_block_start',
          );
          yield sse(
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'Looking up.' },
            },
            'content_block_delta',
          );
          yield sse({ type: 'content_block_stop', index: 0 }, 'content_block_stop');
          yield sse(
            {
              type: 'content_block_start',
              index: 1,
              content_block: { type: 'tool_use', id: 'tu1', name: 'jira_get' },
            },
            'content_block_start',
          );
          yield sse(
            {
              type: 'content_block_delta',
              index: 1,
              delta: { type: 'input_json_delta', partial_json: '{"id":"SEC' },
            },
            'content_block_delta',
          );
          yield sse(
            {
              type: 'content_block_delta',
              index: 1,
              delta: { type: 'input_json_delta', partial_json: '-1"}' },
            },
            'content_block_delta',
          );
          yield sse({ type: 'content_block_stop', index: 1 }, 'content_block_stop');
          // an event type the proxy does not know is dropped, never relayed
          yield sse({ type: 'x_evil', payload: 'INJECTED' }, 'x_evil');
          yield sse(
            {
              type: 'message_delta',
              delta: { stop_reason: 'tool_use' },
              usage: { output_tokens: 20 },
            },
            'message_delta',
          );
          yield sse({ type: 'message_stop' }, 'message_stop');
        },
        init,
      );
    const r = await mkRun(n, { provider: 'claude', model: 'claude-x' });
    const mt = await modelToken(n, r);
    const res = await stream(
      r.runId,
      mt,
      ask('x', { tools: [{ name: 'jira_get', inputSchema: { type: 'object' } }] }, 'claude-x'),
    );
    const events = parseSse(res.body);
    expect(events.map((e) => e.event)).toEqual(['start', 'delta', 'done']);
    expect(res.body).not.toContain('INJECTED');
    const done = events.at(-1)!.data as { response: Record<string, unknown>; costMicros: number };
    expect(done.response).toMatchObject({
      text: 'Looking up.',
      stopReason: 'tool_use',
      toolCalls: [{ id: 'tu1', name: 'jira_get', args: { id: 'SEC-1' } }],
    });
    // 25 in x 3 + 20 out x 15 = 375 micro-USD
    expect(done.costMicros).toBe(375);
    expect(up.calls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(up.calls[0]?.headers['x-api-key']).toBe(PLATFORM_ANTHROPIC_KEY);
    expect(up.calls[0]?.body).toMatchObject({ stream: true, model: 'claude-x' });
    expect(res.body).not.toContain(PLATFORM_ANTHROPIC_KEY);
  });

  it('replays a provider without a streaming transport (simulated) as one delta and done', async () => {
    const r = await mkRun(n, {
      simulation: '        - { text: "scripted", usage: { inputTokens: 3, outputTokens: 2 } }',
    });
    const mt = await modelToken(n, r);
    const res = await stream(r.runId, mt, ask('x'));
    const events = parseSse(res.body);
    expect(events.map((e) => e.event)).toEqual(['start', 'delta', 'done']);
    expect(events[1]!.data.text).toBe('scripted');
    expect(events[2]!.data).toMatchObject({ usage: { inputTokens: 3, outputTokens: 2 } });
  });

  it('answers an upstream error before the first byte as a normal JSON error', async () => {
    up.handler = () => json({ error: { message: `bad key ${PLATFORM_OPENAI_KEY}` } }, 401);
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    const res = await stream(r.runId, mt, ask('x', {}, 'gpt-x'));
    expect(res.statusCode).toBe(502);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json().error.code).toBe('provider_error');
    const all = res.body + log.text() + JSON.stringify(await n.ctx.db.select().from(auditLog));
    expect(all).not.toContain(PLATFORM_OPENAI_KEY);
    expect((await reservations(r.runId))[0]).toMatchObject({ status: 'settled', actualMicros: 0 });
  });

  it('refuses before streaming starts: admission errors are plain JSON, nothing is reserved', async () => {
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    const res = await stream(r.runId, mt, ask('x', {}, 'gpt-other'));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('model_not_allowed');
    expect(await reservations(r.runId)).toEqual([]);
    expect(up.calls).toHaveLength(0);
  });
});

describe('hard stop mid-stream', () => {
  /** An endless provider: a delta every few milliseconds until the connection is cut. */
  const endless =
    (produced: { n: number }, chunk = 'word ') =>
    (_c: unknown, init: RequestInit) =>
      sseResponse(
        up,
        async function* (signal) {
          yield openaiChunk({ role: 'assistant', content: '' });
          for (;;) {
            if (signal.aborted) return;
            produced.n++;
            yield openaiChunk({ content: chunk });
            await sleep(5, signal);
          }
        },
        init,
      );

  it('ends the stream within one poll of a revoked session, aborts upstream and settles an estimate', async () => {
    const produced = { n: 0 };
    up.handler = endless(produced);
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    const pending = stream(r.runId, mt, ask('hi', { maxTokens: 100_000 }, 'gpt-x'));
    const until = async (cond: () => boolean) => {
      for (let i = 0; i < 400 && !cond(); i++) await sleep(10);
      expect(cond()).toBe(true);
    };
    await until(() => produced.n >= 3);
    const revokedAt = Date.now();
    await n.services.runNodes.revoke(r.sessionId, 'step_end');
    const res = await pending;
    expect(Date.now() - revokedAt).toBeLessThan(2000);
    const events = parseSse(res.body);
    const last = events.at(-1)!;
    expect(last.event).toBe('error');
    expect(last.data.code).toBe('run_node_session_revoked');
    expect(events.some((e) => e.event === 'done')).toBe(false);
    expect(up.calls[0]?.aborted).toBe(true);
    // settled with an estimate from what was streamed, status error, and audited
    const [resv] = await reservations(r.runId);
    expect(resv?.status).toBe('settled');
    const [line] = await ledger(r.runId);
    expect(line).toMatchObject({ usageSource: 'estimated', via: 'proxy' });
    expect(line!.tokensOut).toBeGreaterThan(0);
    expect((await steps(r.runId)).find((s) => s.kind === 'model_call')?.status).toBe('error');
    const aborted = await audit(r.runId, 'model.aborted');
    expect(aborted[0]?.payload).toMatchObject({ reason: 'revoked', callId: resv!.id });
    // and the token is dead for the next call
    const again = await stream(r.runId, mt, ask('hi', {}, 'gpt-x'));
    expect(again.statusCode).toBe(403);
    await until(() => up.open === 0);
  });

  it('stops a run that is cancelled while streaming', async () => {
    const produced = { n: 0 };
    up.handler = endless(produced);
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    const pending = stream(r.runId, mt, ask('hi', { maxTokens: 100_000 }, 'gpt-x'));
    for (let i = 0; i < 400 && produced.n < 2; i++) await sleep(10);
    await n.ctx.db.execute(
      `update runs set cancel_requested = true where id = '${r.runId}'` as never,
    );
    const res = await pending;
    expect(parseSse(res.body).at(-1)?.data.code).toBe('run_node_session_revoked');
    expect((await audit(r.runId, 'model.aborted'))[0]?.payload.reason).toBe('cancelled');
  });

  it('cuts a provider that ignores max_tokens at the bound plus 10 % and charges what it streamed', async () => {
    const produced = { n: 0 };
    up.handler = endless(produced, 'x'.repeat(100));
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    const res = await stream(r.runId, mt, ask('hi', { maxTokens: 64 }, 'gpt-x'));
    const last = parseSse(res.body).at(-1)!;
    expect(last.event).toBe('error');
    expect(last.data.code).toBe('control_budget_cost');
    // bound 64 tokens: cut after 64 * 1.1 * 8 = 563 bytes, i.e. a handful of 100 byte deltas
    expect(produced.n).toBeLessThan(15);
    expect(up.calls[0]?.aborted).toBe(true);
    const [line] = await ledger(r.runId);
    expect(line).toMatchObject({ usageSource: 'estimated' });
    expect(line!.tokensOut).toBeGreaterThanOrEqual(64);
    expect((await audit(r.runId, 'model.aborted'))[0]?.payload.reason).toBe('output_overrun');
    // the provider billed more than reserved: recorded, never hidden
    expect((await audit(r.runId, 'model.overrun')).length).toBe(1);
  });

  it('aborts the upstream request and settles an estimate when the client disconnects', async () => {
    const produced = { n: 0 };
    up.handler = endless(produced);
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    await n.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (n.app.server.address() as { port: number }).port;
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/v1/worker/runs/${r.runId}/model`, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        authorization: `Bearer ${mt}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify(ask('hi', { maxTokens: 100_000 }, 'gpt-x')),
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('event: start');
    ac.abort();
    for (let i = 0; i < 300 && !up.calls[0]?.aborted; i++) await sleep(10);
    expect(up.calls[0]?.aborted).toBe(true);
    for (let i = 0; i < 300; i++) {
      if ((await reservations(r.runId))[0]?.status === 'settled') break;
      await sleep(10);
    }
    expect((await reservations(r.runId))[0]?.status).toBe('settled');
    expect((await audit(r.runId, 'model.aborted'))[0]?.payload.reason).toBe('client_abort');
    expect(up.open).toBe(0);
  });
});

describe('stream failures after the first byte', () => {
  const anthropicHead = (usage: Record<string, unknown> = { input_tokens: 25, output_tokens: 1 }) =>
    sse(
      { type: 'message_start', message: { id: 'm', model: 'claude-x', usage } },
      'message_start',
    ) +
    sse(
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      'content_block_start',
    ) +
    sse(
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
      'content_block_delta',
    );

  it('sends an error event when the provider reports an error mid-stream and settles what was streamed', async () => {
    up.handler = (_c, init) =>
      sseResponse(
        up,
        async function* () {
          yield anthropicHead();
          yield sse(
            {
              type: 'error',
              error: { type: 'overloaded_error', message: `busy ${PLATFORM_ANTHROPIC_KEY}` },
            },
            'error',
          );
        },
        init,
      );
    const r = await mkRun(n, { provider: 'claude', model: 'claude-x' });
    const mt = await modelToken(n, r);
    const res = await stream(r.runId, mt, ask('x', {}, 'claude-x'));
    expect(res.statusCode).toBe(200);
    const events = parseSse(res.body);
    expect(events.map((e) => e.event)).toEqual(['start', 'delta', 'error']);
    expect(events.at(-1)!.data.code).toBe('provider_error');
    expect(res.body).not.toContain(PLATFORM_ANTHROPIC_KEY);
    expect((await reservations(r.runId))[0]).toMatchObject({ status: 'settled' });
    const [line] = await ledger(r.runId);
    expect(line).toMatchObject({ usageSource: 'estimated' });
    expect((await steps(r.runId)).find((s) => s.kind === 'model_call')?.status).toBe('error');
  });

  it('prices cache reads and writes reported by the provider and counts them separately', async () => {
    up.handler = (_c, init) =>
      sseResponse(
        up,
        async function* () {
          yield anthropicHead({
            input_tokens: 25,
            cache_read_input_tokens: 10,
            cache_creation_input_tokens: 5,
            output_tokens: 1,
          });
          yield sse({ type: 'content_block_stop', index: 0 }, 'content_block_stop');
          yield sse(
            {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 20 },
            },
            'message_delta',
          );
          yield sse({ type: 'message_stop' }, 'message_stop');
        },
        init,
      );
    const r = await mkRun(n, { provider: 'claude', model: 'claude-x' });
    const mt = await modelToken(n, r);
    const done = parseSse((await stream(r.runId, mt, ask('x', {}, 'claude-x'))).body).at(-1)!
      .data as { usage: Record<string, number>; costMicros: number };
    expect(done.usage).toMatchObject({ inputTokens: 25, cacheReadTokens: 10, cacheWriteTokens: 5 });
    // 25 x 3 + 10 x 3 (no cache price: as input) + 5 x 3.75 (1.25 x input) + 20 x 15 = 423.75
    expect(done.costMicros).toBe(424);
    const [line] = await ledger(r.runId);
    expect(line).toMatchObject({ cacheReadTokens: 10, cacheWriteTokens: 5, tokensIn: 40 });
    const text = await n.ctx.metrics.registry.metrics();
    expect(text).toContain('direction="cache_read"');
    expect(text).toContain('direction="cache_write"');
  });

  it('refuses to relay a final tool call that is not valid (error event, never the data)', async () => {
    up.handler = (_c, init) =>
      sseResponse(
        up,
        async function* () {
          yield openaiChunk({
            tool_calls: [
              { index: 0, id: 'c1', function: { name: 'x', arguments: '{"constructor":{"a":1}}' } },
            ],
          });
          yield openaiChunk({}, 'tool_calls');
          yield openaiUsage(10, 5);
          yield DONE;
        },
        init,
      );
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    const res = await stream(r.runId, mt, ask('x', {}, 'gpt-x'));
    const events = parseSse(res.body);
    expect(events.at(-1)).toMatchObject({ event: 'error', data: { code: 'provider_error' } });
    expect(res.body).not.toContain('constructor');
    // the call was real and is charged
    expect((await ledger(r.runId))[0]).toMatchObject({ tokensIn: 10, tokensOut: 5 });
  });

  it('reports an unsettleable stream as an error event; the reservation stays for the reaper', async () => {
    up.handler = (_c, init) => openaiText(init);
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    const original = n.services.modelAccounting.settle.bind(n.services.modelAccounting);
    n.services.modelAccounting.settle = () => Promise.reject(new Error('db down'));
    try {
      const res = await stream(r.runId, mt, ask('x', {}, 'gpt-x'));
      const events = parseSse(res.body);
      expect(events.at(-1)).toMatchObject({
        event: 'error',
        data: { code: 'model_proxy_unavailable' },
      });
      expect(events.some((e) => e.event === 'done')).toBe(false);
    } finally {
      n.services.modelAccounting.settle = original;
    }
    expect((await reservations(r.runId))[0]?.status).toBe('active');
  });

  it('answers an upstream that fails before the first event with 5xx as a released call', async () => {
    up.handler = () => json({ error: 'overloaded' }, 500);
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    const res = await stream(r.runId, mt, ask('x', {}, 'gpt-x'));
    expect(res.statusCode).toBe(502);
    expect((await reservations(r.runId))[0]).toMatchObject({ status: 'settled', actualMicros: 0 });
    // a gateway timeout may have done work: charged conservatively
    up.handler = () => json({ error: 'gateway' }, 504);
    const r2 = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const t2 = await modelToken(n, r2);
    expect((await stream(r2.runId, t2, ask('x', {}, 'gpt-x'))).statusCode).toBe(502);
    const [resv] = await reservations(r2.runId);
    expect(resv?.status).toBe('settled');
    expect(Number(resv?.actualMicros)).toBeGreaterThan(0);
  });

  it('applies backpressure: a slow reader does not make the proxy buffer an endless stream', async () => {
    const produced = { n: 0 };
    up.handler = (_c, init) =>
      sseResponse(
        up,
        async function* (signal) {
          yield openaiChunk({ role: 'assistant', content: '' });
          for (let i = 0; i < 5000 && !signal.aborted; i++) {
            produced.n++;
            yield openaiChunk({ content: 'y'.repeat(2000) });
          }
          yield openaiChunk({}, 'stop');
          yield openaiUsage(10, 5000);
          yield DONE;
        },
        init,
      );
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    await n.app.listen({ port: 0, host: '127.0.0.1' }).catch(() => undefined);
    const port = (n.app.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/v1/worker/runs/${r.runId}/model`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${mt}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify(ask('hi', { maxTokens: 100_000 }, 'gpt-x')),
    });
    const reader = res.body!.getReader();
    await reader.read();
    await sleep(300);
    // the reader has not consumed: the producer is held back by the socket buffers, not unbounded
    expect(produced.n).toBeLessThan(5000);
    await reader.cancel();
    for (let i = 0; i < 300 && up.open > 0; i++) await sleep(10);
    expect(up.open).toBe(0);
  });
});
