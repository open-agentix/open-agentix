import { issueModelToken } from '@openagentix/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, costLedger } from '../src/db/schema.js';
import { RUN_TOKEN_SECRET, testNode, type TestNode } from './helpers.js';
import {
  BASE_ENV,
  DONE,
  FakeUpstream,
  HARNESS_ENV,
  PLATFORM_ANTHROPIC_KEY,
  PLATFORM_OPENAI_KEY,
  json,
  captureLogger,
  harnessModelToken,
  mkRun,
  openaiChunk,
  openaiUsage,
  publicLookup,
  secrets,
  sleep,
  sse,
  sseResponse,
  tenantScope,
  type LogCapture,
  type MadeRun,
} from './model-proxy-helpers.js';

const up = new FakeUpstream();
let log: LogCapture;
let n: TestNode;

beforeAll(async () => {
  log = captureLogger();
  n = await testNode(
    {
      ...BASE_ENV,
      ...HARNESS_ENV,
      OAX_MODEL_PROXY_ANTHROPIC_BETAS: 'allowed-beta-1,allowed-beta-2',
    },
    { secrets, fetchImpl: up.fetch, hostLookup: publicLookup, logger: log.logger },
  );
});
afterAll(async () => n.close());
beforeEach(() => up.reset());

const A = '/v1/model-proxy/anthropic/v1/messages';
const O = '/v1/model-proxy/openai/v1/chat/completions';

const reservations = (runId: string) => n.services.modelAccounting.list(tenantScope, { runId });
const ledger = (runId: string) =>
  n.ctx.db.select().from(costLedger).where(eq(costLedger.runId, runId));
const audit = async (runId: string, action: string) =>
  (await n.ctx.db.select().from(auditLog))
    .filter((r) => r.runId === runId && r.action === action)
    .map((r) => ({ ...r, payload: r.payload as Record<string, unknown> }));

/** A run with a model token for the given provider/model. */
async function setup(provider: string, model: string, extra: Parameters<typeof mkRun>[1] = {}) {
  // The pass-through surfaces belong to harness steps: they only accept a harness model token.
  const harness = provider === 'oai' ? 'opencode' : 'claude-code';
  const r = await mkRun(n, { provider, model, harness, ...extra });
  return { r, mt: await harnessModelToken(n, r, harness) };
}

const post = (
  url: string,
  token: string | null,
  payload: unknown,
  headers: Record<string, string> = {},
) =>
  n.req({
    method: 'POST',
    url,
    token,
    payload: payload as never,
    headers,
  });

const anthropicBody = (extra: Record<string, unknown> = {}, model = 'claude-x') => ({
  model,
  max_tokens: 200,
  messages: [{ role: 'user', content: 'hello' }],
  ...extra,
});
const openaiBody = (extra: Record<string, unknown> = {}, model = 'gpt-x') => ({
  model,
  messages: [{ role: 'user', content: 'hello' }],
  ...extra,
});

interface Frame {
  event: string;
  data: Record<string, unknown>;
}
/** Parses an SSE body; OpenAI streams use `[DONE]` which is returned as `{ done: true }`. */
function frames(body: string): Frame[] {
  return body
    .split('\n\n')
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) => {
      const event = /^event: (.*)$/m.exec(b)?.[1] ?? 'message';
      const data = /^data: (.*)$/m.exec(b)?.[1] ?? '{}';
      return { event, data: data === '[DONE]' ? { done: true } : JSON.parse(data) };
    });
}

const anthropicText = (init: RequestInit, extra: Record<string, unknown> = {}) =>
  sseResponse(
    up,
    async function* () {
      yield sse(
        {
          type: 'message_start',
          message: {
            id: 'm1',
            model: 'claude-x',
            role: 'assistant',
            secret_field: 'LEAK-1',
            usage: { input_tokens: 25, output_tokens: 1, service_tier: 'LEAK-2' },
          },
          ...extra,
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
          delta: { type: 'text_delta', text: 'Hello ' },
          vendor: 'LEAK-3',
        },
        'content_block_delta',
      );
      yield sse(
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } },
        'content_block_delta',
      );
      yield sse({ type: 'content_block_stop', index: 0 }, 'content_block_stop');
      yield sse({ type: 'x_evil', payload: 'LEAK-4' }, 'x_evil');
      yield sse(
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } },
        'message_delta',
      );
      yield sse({ type: 'message_stop' }, 'message_stop');
    },
    init,
  );

describe('Anthropic pass-through: streaming', () => {
  it('relays rebuilt events, bills the measured usage and never leaks keys or extras', async () => {
    up.handler = (_c, init) => anthropicText(init);
    const { r, mt } = await setup('claude', 'claude-x');
    const res = await post(A, mt, anthropicBody({ stream: true, metadata: { user_id: 'u-1' } }), {
      'anthropic-beta': 'allowed-beta-1, evil-beta',
      'anthropic-version': '2023-06-01',
      'x-forwarded-for': '6.6.6.6',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['x-oax-call-id']).toBeTruthy();
    const ev = frames(res.body);
    expect(ev.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    // only allowlisted fields survive
    for (const leak of ['LEAK-1', 'LEAK-2', 'LEAK-3', 'LEAK-4', PLATFORM_ANTHROPIC_KEY])
      expect(res.body).not.toContain(leak);
    expect(ev[2]!.data).toEqual({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello ' },
    });
    // upstream: the platform key, a body built from validated fields, filtered betas
    const call = up.calls[0]!;
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.headers['x-api-key']).toBe(PLATFORM_ANTHROPIC_KEY);
    expect(call.headers['anthropic-beta']).toBe('allowed-beta-1');
    expect(Object.keys(call.headers).sort()).toEqual(
      ['accept', 'anthropic-beta', 'anthropic-version', 'content-type', 'x-api-key'].sort(),
    );
    expect(JSON.stringify(call)).not.toContain(mt);
    expect(call.body).toMatchObject({ model: 'claude-x', stream: true });
    expect(call.body).not.toHaveProperty('metadata');
    expect(call.body.max_tokens).toBeLessThanOrEqual(200);
    // accounting: provider usage, 25 in x 3 + 12 out x 15 = 255
    const [line] = await ledger(r.runId);
    expect(line).toMatchObject({ via: 'proxy', usageSource: 'provider', tokensIn: 25 });
    expect(line!.costMicros).toBe(255);
    expect((await reservations(r.runId))[0]).toMatchObject({ status: 'settled' });
  });

  it('accepts the model token as x-api-key and refuses ambiguous or wrong credentials', async () => {
    up.handler = (_c, init) => anthropicText(init);
    const { r, mt } = await setup('claude', 'claude-x');
    const ok = await post(A, null, anthropicBody({ stream: true }), { 'x-api-key': mt });
    expect(ok.statusCode).toBe(200);
    // the same value in both headers is fine, two different ones are ambiguous
    const both = await post(A, mt, anthropicBody({ stream: true }), { 'x-api-key': mt });
    expect(both.statusCode).toBe(200);
    const amb = await post(A, mt, anthropicBody({ stream: true }), { 'x-api-key': 'oaxmt.a.b' });
    expect(amb.statusCode).toBe(401);
    expect(amb.json()).toMatchObject({ type: 'error', error: { type: 'authentication_error' } });
    expect((await post(A, null, anthropicBody())).statusCode).toBe(401);
    // a step-scoped run token never opens the pass-through surface
    expect((await post(A, r.runToken, anthropicBody())).statusCode).toBe(401);
    expect((await post(A, 'oaxmt.garbage.garbage', anthropicBody())).statusCode).toBe(401);
    // none of the refusals reserved anything beyond the two accepted calls
    expect(await reservations(r.runId)).toHaveLength(2);
  });

  it('answers errors with the Anthropic envelope', async () => {
    const { r, mt } = await setup('claude', 'claude-x');
    const res = await post(A, mt, anthropicBody({}, 'claude-other'));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      type: 'error',
      error: { type: 'permission_error', code: 'model_not_allowed' },
    });
    expect(res.json().error.message).toContain('model_not_allowed');
    expect(up.calls).toHaveLength(0);
    expect(await reservations(r.runId)).toEqual([]);
  });

  it('sends an Anthropic error event and stops the upstream when the session is revoked mid-stream', async () => {
    const produced = { n: 0 };
    up.handler = (_c, init) =>
      sseResponse(
        up,
        async function* (signal) {
          yield sse(
            {
              type: 'message_start',
              message: { id: 'm', model: 'claude-x', usage: { input_tokens: 5, output_tokens: 1 } },
            },
            'message_start',
          );
          yield sse(
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            'content_block_start',
          );
          for (;;) {
            if (signal.aborted) return;
            produced.n++;
            yield sse(
              {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'word ' },
              },
              'content_block_delta',
            );
            await sleep(5, signal);
          }
        },
        init,
      );
    const { r, mt } = await setup('claude', 'claude-x');
    const pending = post(A, mt, anthropicBody({ stream: true, max_tokens: 100_000 }));
    for (let i = 0; i < 400 && produced.n < 3; i++) await sleep(10);
    const revokedAt = Date.now();
    await n.services.runNodes.revoke(r.sessionId, 'step_end');
    const res = await pending;
    expect(Date.now() - revokedAt).toBeLessThan(2000);
    const ev = frames(res.body);
    const last = ev.at(-1)!;
    expect(last.event).toBe('error');
    expect(last.data).toMatchObject({
      type: 'error',
      error: { type: 'permission_error', code: 'run_node_session_revoked' },
    });
    expect(ev.some((e) => e.event === 'message_stop')).toBe(false);
    expect(up.calls[0]?.aborted).toBe(true);
    const [line] = await ledger(r.runId);
    expect(line).toMatchObject({ usageSource: 'estimated', via: 'proxy' });
    expect(line!.tokensOut).toBeGreaterThan(0);
    expect((await audit(r.runId, 'model.aborted'))[0]?.payload.reason).toBe('revoked');
    expect((await post(A, mt, anthropicBody({ stream: true }))).statusCode).toBe(403);
    for (let i = 0; i < 300 && up.open > 0; i++) await sleep(10);
    expect(up.open).toBe(0);
  });

  it('cuts a provider that ignores max_tokens and charges what it streamed', async () => {
    up.handler = (_c, init) =>
      sseResponse(
        up,
        async function* (signal) {
          yield sse(
            {
              type: 'message_start',
              message: { id: 'm', model: 'claude-x', usage: { input_tokens: 5, output_tokens: 1 } },
            },
            'message_start',
          );
          yield sse(
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            'content_block_start',
          );
          for (;;) {
            if (signal.aborted) return;
            yield sse(
              {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'x'.repeat(100) },
              },
              'content_block_delta',
            );
            await sleep(5, signal);
          }
        },
        init,
      );
    const { r, mt } = await setup('claude', 'claude-x');
    const res = await post(A, mt, anthropicBody({ stream: true, max_tokens: 64 }));
    const last = frames(res.body).at(-1)!;
    expect(last.event).toBe('error');
    expect(last.data).toMatchObject({ error: { code: 'control_budget_cost' } });
    expect(up.calls[0]?.aborted).toBe(true);
    const [line] = await ledger(r.runId);
    expect(line).toMatchObject({ usageSource: 'estimated' });
    expect(line!.tokensOut).toBeGreaterThanOrEqual(64);
    expect((await audit(r.runId, 'model.aborted'))[0]?.payload.reason).toBe('output_overrun');
  });

  it('aborts the upstream request when the client disconnects', async () => {
    up.handler = (_c, init) =>
      sseResponse(
        up,
        async function* (signal) {
          yield sse(
            {
              type: 'message_start',
              message: { id: 'm', model: 'claude-x', usage: { input_tokens: 5, output_tokens: 1 } },
            },
            'message_start',
          );
          for (;;) {
            if (signal.aborted) return;
            yield sse(
              {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'word ' },
              },
              'content_block_delta',
            );
            await sleep(5, signal);
          }
        },
        init,
      );
    const { r, mt } = await setup('claude', 'claude-x');
    await n.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (n.app.server.address() as { port: number }).port;
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}${A}`, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'x-api-key': mt, 'content-type': 'application/json' },
      body: JSON.stringify(anthropicBody({ stream: true, max_tokens: 100_000 })),
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('message_start');
    ac.abort();
    for (let i = 0; i < 300 && !up.calls[0]?.aborted; i++) await sleep(10);
    expect(up.calls[0]?.aborted).toBe(true);
    for (let i = 0; i < 300; i++) {
      if ((await reservations(r.runId))[0]?.status === 'settled') break;
      await sleep(10);
    }
    expect((await reservations(r.runId))[0]?.status).toBe('settled');
    expect((await audit(r.runId, 'model.aborted'))[0]?.payload.reason).toBe('client_abort');
  });
});

describe('Anthropic pass-through: JSON', () => {
  it('answers a message object with tool_use and the measured cost headers', async () => {
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
              delta: { type: 'input_json_delta', partial_json: '{"id":"SEC-1"}' },
            },
            'content_block_delta',
          );
          yield sse({ type: 'content_block_stop', index: 1 }, 'content_block_stop');
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
    const { r, mt } = await setup('claude', 'claude-x');
    const res = await post(
      A,
      mt,
      anthropicBody({
        system: [{ type: 'text', text: 'You are terse.', cache_control: { type: 'ephemeral' } }],
        tools: [{ name: 'jira_get', description: 'd', input_schema: { type: 'object' } }],
        tool_choice: { type: 'auto' },
        stop_sequences: ['END'],
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-oax-call-id']).toBeTruthy();
    expect(res.headers['x-oax-cost-micros']).toBe('375');
    expect(res.json()).toMatchObject({
      type: 'message',
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Looking up.' },
        { type: 'tool_use', id: 'tu1', name: 'jira_get', input: { id: 'SEC-1' } },
      ],
      usage: { input_tokens: 25, output_tokens: 20 },
    });
    expect(up.calls[0]?.body).toMatchObject({
      stream: true,
      system: [{ type: 'text', text: 'You are terse.' }],
      tool_choice: { type: 'auto' },
      stop_sequences: ['END'],
    });
    expect((await ledger(r.runId))[0]).toMatchObject({ costMicros: 375, via: 'proxy' });
  });

  it('does not leak the platform key through an upstream error body', async () => {
    up.handler = () =>
      json({ error: { type: 'api_error', message: `bad key ${PLATFORM_ANTHROPIC_KEY}` } }, 500);
    const { mt } = await setup('claude', 'claude-x');
    const res = await post(A, mt, anthropicBody());
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain(PLATFORM_ANTHROPIC_KEY);
    expect(res.json()).toMatchObject({ type: 'error', error: { code: 'provider_error' } });
    expect(log.text()).not.toContain(PLATFORM_ANTHROPIC_KEY);
  });

  it('lists exactly the model of the step', async () => {
    const { mt } = await setup('claude', 'claude-x');
    const res = await n.req({
      method: 'GET',
      url: '/v1/model-proxy/anthropic/v1/models',
      token: null,
      headers: { 'x-api-key': mt },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      data: [{ type: 'model', id: 'claude-x' }],
      has_more: false,
    });
    const bad = await n.req({
      method: 'GET',
      url: '/v1/model-proxy/anthropic/v1/models',
      token: null,
    });
    expect(bad.statusCode).toBe(401);
  });
});

describe('Anthropic pass-through: refusals (nothing reserved, nothing forwarded)', () => {
  const cases: [string, Record<string, unknown>, string][] = [
    [
      'a server tool',
      { tools: [{ type: 'web_search_20250305', name: 'web_search' }] },
      'model_parameter_refused',
    ],
    [
      'mcp_servers',
      { mcp_servers: [{ type: 'url', url: 'https://evil.example.org' }] },
      'model_parameter_refused',
    ],
    ['container', { container: 'c1' }, 'model_parameter_refused'],
    ['service_tier', { service_tier: 'auto' }, 'model_parameter_refused'],
    [
      'a url image source',
      {
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', source: { type: 'url', url: 'http://169.254.169.254/' } }],
          },
        ],
      },
      'model_parameter_refused',
    ],
    [
      'a document block',
      {
        messages: [
          {
            role: 'user',
            content: [{ type: 'document', source: { type: 'file', file_id: 'f1' } }],
          },
        ],
      },
      'model_parameter_refused',
    ],
    [
      'thinking without stream',
      { thinking: { type: 'enabled', budget_tokens: 2048 } },
      'model_parameter_refused',
    ],
    ['a missing max_tokens', { max_tokens: undefined }, 'model_request_invalid'],
    ['an empty message list', { messages: [] }, 'model_request_invalid'],
    [
      'too many stop sequences',
      { stop_sequences: ['a', 'b', 'c', 'd', 'e'] },
      'model_request_invalid',
    ],
  ];
  for (const [name, extra, code] of cases) {
    it(`refuses ${name}`, async () => {
      const { r, mt } = await setup('claude', 'claude-x');
      const res = await post(A, mt, anthropicBody(extra));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe(code);
      expect(up.calls).toHaveLength(0);
      expect(await reservations(r.runId)).toEqual([]);
    });
  }

  it('refuses a duplicate key and a prototype key', async () => {
    const { mt } = await setup('claude', 'claude-x');
    const dup = await n.app.inject({
      method: 'POST',
      url: A,
      headers: { 'x-api-key': mt, 'content-type': 'application/json' },
      payload: '{"model":"claude-x","model":"other","max_tokens":5,"messages":[]}',
    });
    expect(dup.statusCode).toBe(400);
    const proto = await n.app.inject({
      method: 'POST',
      url: A,
      headers: { 'x-api-key': mt, 'content-type': 'application/json' },
      payload: '{"model":"claude-x","max_tokens":5,"messages":[],"__proto__":{"x":1}}',
    });
    expect(proto.statusCode).toBe(400);
    expect(proto.json().error.code).toBe('model_parameter_refused');
    expect(up.calls).toHaveLength(0);
  });

  it('refuses a request over the body limit', async () => {
    const { mt } = await setup('claude', 'claude-x');
    const res = await post(A, mt, anthropicBody({ system: 'x'.repeat(70_000) }));
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: { type: 'request_too_large' } });
  });

  it('answers 400 model_surface_mismatch when the step speaks the other protocol', async () => {
    const { r, mt } = await setup('oai', 'gpt-x');
    const res = await post(A, mt, anthropicBody({}, 'gpt-x'));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('model_surface_mismatch');
    expect(up.calls).toHaveLength(0);
    expect(await reservations(r.runId)).toEqual([]);
    const { r: r2, mt: mt2 } = await setup('claude', 'claude-x');
    const res2 = await post(O, mt2, openaiBody({}, 'claude-x'));
    expect(res2.statusCode).toBe(400);
    expect(res2.json()).toMatchObject({
      error: { code: 'model_surface_mismatch', type: 'invalid_request_error' },
    });
    expect(await reservations(r2.runId)).toEqual([]);
  });

  it('applies the cost budget before any upstream call', async () => {
    const { r, mt } = await setup('claude', 'claude-x', { budget: '  maxCostUsd: 0.000001' });
    const res = await post(A, mt, anthropicBody({ stream: true, max_tokens: 4000 }));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toMatch(/^control_budget_/);
    expect(up.calls).toHaveLength(0);
    expect(await reservations(r.runId)).toEqual([]);
  });
});

describe('OpenAI pass-through', () => {
  const openaiText = (init: RequestInit) =>
    sseResponse(
      up,
      async function* () {
        yield openaiChunk({ role: 'assistant', content: '' });
        yield openaiChunk({ content: 'Hel' });
        yield sse({
          id: 'c1',
          object: 'chat.completion.chunk',
          model: 'gpt-x',
          system_fingerprint: 'LEAK-1',
          vendor: 'LEAK-2',
          choices: [{ index: 0, delta: { content: 'lo', hidden: 'LEAK-3' }, finish_reason: null }],
        });
        yield openaiChunk({}, 'stop');
        yield openaiUsage(30, 12);
        yield DONE;
      },
      init,
    );

  it('relays rebuilt chunks and [DONE]; the usage chunk only when the client asked', async () => {
    up.handler = (_c, init) => openaiText(init);
    const { r, mt } = await setup('oai', 'gpt-x');
    const res = await post(O, mt, openaiBody({ stream: true, user: 'u-1', max_tokens: 300 }), {
      'x-forwarded-for': '6.6.6.6',
    });
    expect(res.statusCode).toBe(200);
    const ev = frames(res.body);
    expect(ev.at(-1)).toEqual({ event: 'message', data: { done: true } });
    const chunks = ev.slice(0, -1).map((e) => e.data);
    expect(
      chunks.map((c) => (c.choices as { delta: { content?: string } }[])[0]!.delta.content),
    ).toEqual(['', 'Hel', 'lo', undefined]);
    expect(chunks.some((c) => 'usage' in c)).toBe(false);
    for (const leak of ['LEAK-1', 'LEAK-2', 'LEAK-3', PLATFORM_OPENAI_KEY])
      expect(res.body).not.toContain(leak);
    const call = up.calls[0]!;
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(call.headers.authorization).toBe(`Bearer ${PLATFORM_OPENAI_KEY}`);
    expect(JSON.stringify(call)).not.toContain(mt);
    expect(call.body).toMatchObject({
      model: 'gpt-x',
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 300,
    });
    expect(call.body).not.toHaveProperty('user');
    // 30 in x 10 + 12 out x 20 = 540
    expect((await ledger(r.runId))[0]).toMatchObject({ costMicros: 540, via: 'proxy' });

    const withUsage = await post(
      O,
      mt,
      openaiBody({ stream: true, stream_options: { include_usage: true } }),
    );
    const last = frames(withUsage.body).at(-2)!.data;
    expect(last).toMatchObject({
      usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 },
    });
  });

  it('answers a chat completion object with tool calls', async () => {
    up.handler = () =>
      json({
        model: 'gpt-x',
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{"q":"x"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 40, completion_tokens: 50 },
      });
    const { mt } = await setup('oai', 'gpt-x');
    const res = await post(
      O,
      mt,
      openaiBody({
        messages: [
          { role: 'developer', content: 'be brief' },
          { role: 'user', content: 'go' },
        ],
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
        tool_choice: 'auto',
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-oax-cost-micros']).toBe('1400');
    expect(res.json()).toMatchObject({
      object: 'chat.completion',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
          },
        },
      ],
      usage: { prompt_tokens: 40, completion_tokens: 50, total_tokens: 90 },
    });
    // the developer role is downgraded to system for every endpoint
    expect((up.calls[0]!.body.messages as { role: string }[])[0]!.role).toBe('system');
  });

  it('ends an OpenAI stream with an error chunk (no [DONE]) when the session is revoked', async () => {
    const produced = { n: 0 };
    up.handler = (_c, init) =>
      sseResponse(
        up,
        async function* (signal) {
          yield openaiChunk({ role: 'assistant', content: '' });
          for (;;) {
            if (signal.aborted) return;
            produced.n++;
            yield openaiChunk({ content: 'word ' });
            await sleep(5, signal);
          }
        },
        init,
      );
    const { r, mt } = await setup('oai', 'gpt-x');
    const pending = post(O, mt, openaiBody({ stream: true, max_tokens: 100_000 }));
    for (let i = 0; i < 400 && produced.n < 3; i++) await sleep(10);
    await n.services.runNodes.revoke(r.sessionId, 'step_end');
    const res = await pending;
    const ev = frames(res.body);
    expect(ev.at(-1)!.data).toMatchObject({
      error: { code: 'run_node_session_revoked', type: 'invalid_request_error' },
    });
    expect(ev.some((e) => e.data.done === true)).toBe(false);
    expect(up.calls[0]?.aborted).toBe(true);
    expect((await ledger(r.runId))[0]).toMatchObject({ usageSource: 'estimated' });
    expect((await audit(r.runId, 'model.aborted'))[0]?.payload.reason).toBe('revoked');
  });

  const refusals: [string, Record<string, unknown>][] = [
    ['n > 1', { n: 2 }],
    ['logprobs', { logprobs: true }],
    ['audio', { modalities: ['text', 'audio'], audio: { voice: 'x' } }],
    ['a web search tool', { tools: [{ type: 'web_search' }] }],
    [
      'an http image url',
      {
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'http://10.0.0.5/x.png' } }],
          },
        ],
      },
    ],
    [
      'a file part',
      { messages: [{ role: 'user', content: [{ type: 'file', file: { file_id: 'f' } }] }] },
    ],
    ['store', { store: true }],
    ['logit_bias', { logit_bias: { '1': 5 } }],
  ];
  for (const [name, extra] of refusals) {
    it(`refuses ${name}`, async () => {
      const { r, mt } = await setup('oai', 'gpt-x');
      const res = await post(O, mt, openaiBody(extra));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('model_parameter_refused');
      expect(up.calls).toHaveLength(0);
      expect(await reservations(r.runId)).toEqual([]);
    });
  }

  it('takes the model token as Bearer only on the OpenAI surface too, lists the model', async () => {
    const { mt, r } = await setup('oai', 'gpt-x');
    expect((await post(O, r.runToken, openaiBody())).statusCode).toBe(401);
    expect((await post(O, null, openaiBody())).statusCode).toBe(401);
    const list = await n.req({ method: 'GET', url: '/v1/model-proxy/openai/v1/models', token: mt });
    expect(list.json()).toMatchObject({ object: 'list', data: [{ id: 'gpt-x', object: 'model' }] });
    // a model other than the step's is refused with the OpenAI envelope
    const other = await post(O, mt, openaiBody({}, 'gpt-y'));
    expect(other.statusCode).toBe(403);
    expect(other.json()).toMatchObject({ error: { code: 'model_not_allowed' } });
  });
});

describe('simulated provider on both surfaces', () => {
  const sim =
    '      - text: "Simulated hello"\n        usage: { inputTokens: 10, outputTokens: 5 }';
  // A harness step cannot carry a simulation, so the harness token is minted for a native step
  // here: the pass-through code under test does not look at the step's runtime.
  const make = async (): Promise<{ r: MadeRun; mt: string }> => {
    const r = await mkRun(n, { provider: 'simulated', model: 'sim-1', simulation: sim });
    const { token, claims } = issueModelToken(
      RUN_TOKEN_SECRET,
      {
        runId: r.runId,
        sid: r.sessionId,
        nodeId: r.nodeId,
        agentId: 'a',
        surface: 'harness',
        harness: 'claude-code',
        ttlSeconds: 60,
        notAfterMs: r.expiresAt.getTime(),
      },
      Date.now(),
    );
    expect(await n.services.runNodes.recordModelToken(r.sessionId, claims.jti)).toBe(true);
    return { r, mt: token };
  };

  it('synthesises Anthropic events and a JSON message', async () => {
    const { r, mt } = await make();
    const s = await post(A, mt, anthropicBody({ stream: true }, 'sim-1'));
    expect(s.statusCode).toBe(200);
    const ev = frames(s.body);
    expect(ev[0]!.event).toBe('message_start');
    expect(ev.at(-1)!.event).toBe('message_stop');
    expect(s.body).toContain('Simulated hello');
    const j = await post(A, mt, anthropicBody({}, 'sim-1'));
    expect(j.json()).toMatchObject({ content: [{ type: 'text', text: 'Simulated hello' }] });
    expect(await ledger(r.runId)).toHaveLength(2);
    expect(up.calls).toHaveLength(0);
  });

  it('synthesises OpenAI chunks and a JSON completion', async () => {
    const { mt } = await make();
    const s = await post(
      O,
      mt,
      openaiBody({ stream: true, stream_options: { include_usage: true } }, 'sim-1'),
    );
    const ev = frames(s.body);
    expect(ev.at(-1)!.data).toEqual({ done: true });
    expect(s.body).toContain('Simulated hello');
    expect(ev.at(-2)!.data).toMatchObject({ usage: { prompt_tokens: 10, completion_tokens: 5 } });
    const j = await post(O, mt, openaiBody({}, 'sim-1'));
    expect(j.json()).toMatchObject({ choices: [{ message: { content: 'Simulated hello' } }] });
  });
});

describe('tenant-controlled endpoints (SSRF)', () => {
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

  it('refuses a loopback BYOK endpoint on the pass-through surface without any request', async () => {
    const created = await asB({
      method: 'POST',
      url: '/v1/connections',
      payload: {
        name: 'loop',
        kind: 'model',
        config: {
          kind: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:8080/v1',
          apiKeySecret: 'tenant-b.openai',
          clearance: 'internal',
        },
      },
    });
    expect(created.statusCode).toBe(201);
    const r = await mkRun(n, { provider: 'loop', model: 'm', harness: 'opencode' }, asB);
    const mt = await harnessModelToken(n, r, 'opencode');
    const res = await post(O, mt, openaiBody({}, 'm'));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('egress_denied');
    expect(up.calls).toHaveLength(0);
    expect(await reservations(r.runId)).toEqual([]);
  });
});

describe('feature flag', () => {
  it('answers 503 model_proxy_unavailable on every pass-through route while the proxy is off', async () => {
    const off = await testNode({ OAX_MODEL_PROXY_ENABLED: 'false' });
    try {
      // a correctly signed token reaches the flag check; nothing else of the request is looked at
      const { token } = issueModelToken(
        RUN_TOKEN_SECRET,
        {
          runId: 'r',
          sid: 's',
          nodeId: 'n',
          agentId: 'a',
          surface: 'harness',
          harness: 'claude-code',
          ttlSeconds: 60,
          notAfterMs: Date.now() + 60_000,
        },
        Date.now(),
      );
      for (const [method, url] of [
        ['POST', A],
        ['POST', O],
        ['GET', '/v1/model-proxy/anthropic/v1/models'],
        ['GET', '/v1/model-proxy/openai/v1/models'],
      ] as const) {
        const res = await off.app.inject({
          method,
          url,
          headers: { 'x-api-key': token },
          ...(method === 'POST' ? { payload: {} } : {}),
        });
        expect(res.statusCode, url).toBe(503);
        expect(res.json().error.code ?? res.json().error.message).toBeTruthy();
      }
    } finally {
      await off.close();
    }
  });
});

describe('review fixes: cache writes, identity, auth order', () => {
  const cachingStream = (init: RequestInit, model = 'upstream-secret-model') =>
    sseResponse(
      up,
      async function* () {
        yield sse(
          {
            type: 'message_start',
            message: {
              id: 'msg_upstream_internal',
              model,
              usage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 20 },
            },
          },
          'message_start',
        );
        yield sse(
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          'content_block_start',
        );
        yield sse(
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
          'content_block_delta',
        );
        yield sse({ type: 'content_block_stop', index: 0 }, 'content_block_stop');
        yield sse(
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 5 },
          },
          'message_delta',
        );
        yield sse({ type: 'message_stop' }, 'message_stop');
      },
      init,
    );

  const cached = {
    system: [{ type: 'text', text: 'You are terse.', cache_control: { type: 'ephemeral' } }],
  };

  it('reserves cache_control calls at the cache-write rate: reserved >= settled, no overrun', async () => {
    up.handler = (_c, init) => cachingStream(init);
    const plain = await setup('claude', 'claude-x');
    expect((await post(A, plain.mt, anthropicBody({ stream: true }))).statusCode).toBe(200);
    const withCache = await setup('claude', 'claude-x');
    const res = await post(A, withCache.mt, anthropicBody({ stream: true, ...cached }));
    expect(res.statusCode).toBe(200);
    const [plainResv] = await reservations(plain.r.runId);
    const [resv] = await reservations(withCache.r.runId);
    const [line] = await ledger(withCache.r.runId);
    expect(Number(resv!.reservedMicros)).toBeGreaterThan(Number(plainResv!.reservedMicros));
    expect(Number(resv!.reservedMicros)).toBeGreaterThanOrEqual(line!.costMicros);
    expect(await audit(withCache.r.runId, 'model.overrun')).toEqual([]);
  });

  it('refuses a one-hour cache TTL before anything is reserved or sent', async () => {
    const { r, mt } = await setup('claude', 'claude-x');
    const res = await post(
      A,
      mt,
      anthropicBody({
        system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('model_parameter_refused');
    expect(up.calls).toHaveLength(0);
    expect(await reservations(r.runId)).toEqual([]);
  });

  it('shows the client the step model and an own id, never the upstream ones', async () => {
    up.handler = (_c, init) => cachingStream(init);
    const { mt } = await setup('claude', 'claude-x');
    const res = await post(A, mt, anthropicBody({ stream: true }));
    expect(res.body).not.toContain('upstream-secret-model');
    expect(res.body).not.toContain('msg_upstream_internal');
    const start = frames(res.body)[0]!.data.message as Record<string, unknown>;
    expect(start.model).toBe('claude-x');
    expect(start.id).toBe(
      `msg_${String(res.headers['x-oax-call-id'])
        .replace(/[^A-Za-z0-9]/g, '')
        .slice(0, 40)}`,
    );
  });

  it('checks the token before it validates the body', async () => {
    const bad = { not: 'a request' };
    const unauth = await post(A, null, bad);
    expect(unauth.statusCode).toBe(401);
    const wrong = await post(A, 'oaxmt.garbage.garbage', bad);
    expect(wrong.statusCode).toBe(401);
    const { mt } = await setup('claude', 'claude-x');
    expect((await post(A, mt, bad)).statusCode).toBe(400);
  });

  it('ends the stream with an error for an oversized upstream delta', async () => {
    up.handler = (_c, init) =>
      sseResponse(
        up,
        async function* () {
          yield sse(
            {
              type: 'message_start',
              message: { id: 'm', model: 'claude-x', usage: { input_tokens: 5, output_tokens: 1 } },
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
              delta: { type: 'text_delta', text: 'x'.repeat(70_000) },
            },
            'content_block_delta',
          );
          yield sse({ type: 'message_stop' }, 'message_stop');
        },
        init,
      );
    const { mt } = await setup('claude', 'claude-x');
    const res = await post(A, mt, anthropicBody({ stream: true, max_tokens: 100_000 }));
    const last = frames(res.body).at(-1)!;
    expect(last.event).toBe('error');
    expect(last.data).toMatchObject({ error: { code: 'provider_error' } });
    expect(res.body).not.toContain('text_delta');
  });
});
