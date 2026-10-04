import { createHmac } from 'node:crypto';
import { issueModelToken, issueRunToken } from '@openagentix/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  auditLog,
  costLedger,
  modelReservations,
  runNodeSessions,
  runs,
  runSteps,
} from '../src/db/schema.js';
import { modelRateKey } from '../src/http/routes/worker.js';
import { RUN_TOKEN_SECRET, testNode, type TestNode } from './helpers.js';
import {
  ALL_KEYS,
  BASE_ENV,
  FakeUpstream,
  PLATFORM_OPENAI_KEY,
  TENANT_B_KEY,
  ask,
  captureLogger,
  getModelToken,
  json,
  mkRun,
  modelToken,
  openaiJson,
  postModel,
  secrets,
  tenantScope,
  type LogCapture,
  type MadeRun,
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
const audit = async (runId: string, action?: string) => {
  const rows = (await n.ctx.db.select().from(auditLog))
    .filter((r) => r.runId === runId)
    .map((r) => ({ ...r, payload: r.payload as Record<string, unknown> }));
  return action ? rows.filter((r) => r.action === action) : rows;
};
const session = async (id: string) =>
  (await n.ctx.db.select().from(runNodeSessions).where(eq(runNodeSessions.id, id)))[0]!;

/** The error code of a model route response (model envelope). */
const codeOf = (res: { json: () => unknown }) =>
  (res.json() as { error: { code: string } }).error.code;

describe('feature flag', () => {
  it('answers 503 model_proxy_unavailable on both routes while the flag is off, touching nothing', async () => {
    const off = await testNode(
      { ...BASE_ENV, OAX_MODEL_PROXY_ENABLED: 'false' },
      {
        secrets,
        fetchImpl: up.fetch,
      },
    );
    try {
      expect(off.ctx.config.modelProxy.enabled).toBe(false);
      const r = await mkRun(off);
      const tok = await getModelToken(off, r.runId, r.runToken);
      expect(tok.statusCode).toBe(503);
      expect(tok.json()).toEqual({
        error: { code: 'model_proxy_unavailable', message: expect.any(String) },
      });
      const call = await postModel(off, r.runId, r.runToken, ask());
      expect(call.statusCode).toBe(503);
      expect(codeOf(call)).toBe('model_proxy_unavailable');
      expect((await off.services.runNodes.sessionById(r.sessionId))?.modelTokenJti).toBeNull();
      expect(await off.services.modelAccounting.list(tenantScope, { runId: r.runId })).toEqual([]);
      expect(up.calls).toHaveLength(0);
      // The flag does not weaken authentication: a missing token is still a 401.
      expect((await postModel(off, r.runId, null, ask())).statusCode).toBe(401);
    } finally {
      await off.close();
    }
  });

  it('defaults to off and binds the limits from the OAX_MODEL_PROXY_* block', async () => {
    const dflt = await testNode({}, { secrets });
    try {
      expect(dflt.ctx.config.modelProxy).toMatchObject({
        enabled: false,
        maxBodyBytes: 8 * 1024 * 1024,
        reservation: 'upper-bound',
        minOutputTokens: 256,
        maxConcurrentPerSession: 2,
        maxConcurrentPerTenant: 16,
        maxStreams: 256,
        callsPerMinute: 60,
        maxCallSeconds: 600,
        ttfbSeconds: 120,
        idleSeconds: 60,
        graceSeconds: 60,
        revocationPollMs: 2000,
        maxResponseBytes: 16 * 1024 * 1024,
        capture: 'metadata',
      });
    } finally {
      await dflt.close();
    }
  });
});

describe('model token', () => {
  let r: MadeRun;
  beforeAll(async () => {
    r = await mkRun(n);
  });

  it('is issued once per step and session, bound to run, sid, node, agent and jti', async () => {
    const res = await getModelToken(n, r.runId, r.runToken);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json() as {
      token: string;
      expiresAt: string;
      protocol: string;
      baseUrl: string;
      model: string;
    };
    expect(body.token).toMatch(/^oaxmt\.[\w-]+\.[\w-]+$/);
    expect(body).toMatchObject({ protocol: 'native', model: 'sim-1' });
    expect(body.baseUrl).toContain(`/v1/worker/runs/${r.runId}`);
    expect(new Date(body.expiresAt).getTime()).toBeLessThanOrEqual(r.expiresAt.getTime());
    const claims = JSON.parse(Buffer.from(body.token.split('.')[1]!, 'base64url').toString()) as {
      runId: string;
      sid: string;
      nodeId: string;
      agentId: string;
      jti: string;
      aud: string;
    };
    expect(claims).toMatchObject({
      aud: 'model',
      runId: r.runId,
      sid: r.sessionId,
      nodeId: r.nodeId,
      agentId: 'a',
    });
    expect((await session(r.sessionId)).modelTokenJti).toBe(claims.jti);
    const issued = await audit(r.runId, 'model_token.issued');
    expect(issued).toHaveLength(1);
    expect(issued[0]?.payload).toMatchObject({
      runId: r.runId,
      nodeId: r.nodeId,
      agentId: 'a',
      jti: claims.jti,
    });
    expect(JSON.stringify(issued[0]?.payload)).not.toContain(body.token);
  });

  it('refuses a second token for the same step and session; a new session gets its own', async () => {
    const again = await getModelToken(n, r.runId, r.runToken);
    expect(again.statusCode).toBe(409);
    expect(codeOf(again)).toBe('model_token_already_issued');
    expect(
      (await audit(r.runId, 'model.denied')).some(
        (e) => e.payload.reason === 'model_token_already_issued',
      ),
    ).toBe(true);
    const fresh = await n.services.runNodes.createSession(r.runId, 'w1', {
      agentId: 'a',
      input: {},
      timeoutSeconds: 60,
      runner: 'container',
      image: 'img',
    });
    expect((await getModelToken(n, r.runId, fresh.token)).statusCode).toBe(200);
  });

  it('is refused for an agent outside the token, for a revoked session and a run that is not running', async () => {
    const x = await mkRun(n);
    const other = await getModelToken(n, x.runId, x.runToken, 'not-in-token');
    expect(other.statusCode).toBe(403);
    expect(codeOf(other)).toBe('model_not_allowed');
    expect((await session(x.sessionId)).modelTokenJti).toBeNull();

    await n.services.runNodes.revoke(x.sessionId, 'step_end');
    const revoked = await getModelToken(n, x.runId, x.runToken);
    expect(revoked.statusCode).toBe(403);
    expect(codeOf(revoked)).toBe('run_node_session_revoked');

    const y = await mkRun(n);
    await n.ctx.db.update(runs).set({ status: 'awaiting_approval' }).where(eq(runs.id, y.runId));
    expect(codeOf(await getModelToken(n, y.runId, y.runToken))).toBe('run_node_session_revoked');
  });

  it('is refused when the provider of the step does not resolve or is broken', async () => {
    const gone = await mkRun(n, { provider: 'no-such-provider' });
    const res = await getModelToken(n, gone.runId, gone.runToken);
    expect(res.statusCode).toBe(403);
    expect(codeOf(res)).toBe('model_not_allowed');
    expect((await session(gone.sessionId)).modelTokenJti).toBeNull();
  });

  it('is never issued to an orchestrator token or a model token (token confusion)', async () => {
    const x = await mkRun(n);
    const orchestrator = n.services.control.issueToken(x.runId, 'w1');
    const a = await getModelToken(n, x.runId, orchestrator);
    expect(a.statusCode).toBe(403);
    expect(codeOf(a)).toBe('model_not_allowed');
    const mt = await modelToken(n, x);
    const b = await getModelToken(n, x.runId, mt);
    expect(b.statusCode).toBe(401);
    expect(codeOf(b)).toBe('unauthenticated');
  });
});

describe('token confusion and binding', () => {
  it('a model token opens the model endpoint only; a run token is not a model token', async () => {
    const r = await mkRun(n);
    const mt = await modelToken(n, r);
    // It is not accepted by any run-token endpoint: gate, credentials, handover, steps, budget ...
    const endpoints = [
      {
        method: 'POST',
        url: `/v1/worker/runs/${r.runId}/gate`,
        payload: { agentId: 'a', call: { server: 's', tool: 't', args: {} } },
      },
      { method: 'POST', url: `/v1/worker/runs/${r.runId}/credentials`, payload: { agentId: 'a' } },
      { method: 'GET', url: `/v1/worker/runs/${r.runId}/handover?agentId=a`, payload: undefined },
      {
        method: 'POST',
        url: `/v1/worker/runs/${r.runId}/steps`,
        payload: { kind: 'output', agentId: 'a', name: 'x', status: 'ok' },
      },
      { method: 'GET', url: `/v1/worker/runs/${r.runId}/budget`, payload: undefined },
      { method: 'GET', url: `/v1/worker/runs/${r.runId}/status`, payload: undefined },
    ] as const;
    for (const e of endpoints) {
      const res = await n.req({
        method: e.method,
        url: e.url,
        token: mt,
        payload: e.payload as never,
      });
      expect(res.statusCode, e.url).toBe(401);
    }
    // And it works where it should.
    expect((await postModel(n, r.runId, mt, ask())).statusCode).toBe(200);
  });

  it('refuses a token forged with the raw run token secret, tampered tokens and expired tokens', async () => {
    const r = await mkRun(n);
    const mt = await modelToken(n, r);
    const [prefix, payload] = mt.split('.');
    // MAC with the secret itself instead of the domain-separated key
    const forged = `${prefix}.${payload}.${createHmac('sha256', RUN_TOKEN_SECRET).update(`oaxmt.${payload}`).digest('base64url')}`;
    const tampered = `${prefix}.${payload}.${mt.split('.')[2]!.slice(0, -2)}AA`;
    for (const t of [forged, tampered, 'oaxmt.x.y', 'garbage', '']) {
      const res = await postModel(n, r.runId, t, ask());
      expect(res.statusCode, t).toBe(401);
      expect(codeOf(res)).toBe('unauthenticated');
    }
    const issued = issueModelToken(
      RUN_TOKEN_SECRET,
      {
        runId: r.runId,
        sid: r.sessionId,
        nodeId: r.nodeId,
        agentId: 'a',
        ttlSeconds: 5,
      },
      Date.now() - 3_600_000,
    );
    const expired = await postModel(n, r.runId, issued.token, ask());
    expect(expired.statusCode).toBe(401);
    expect(up.calls).toHaveLength(0);
  });

  it('requires the jti the session stores: a validly signed but unissued token is refused', async () => {
    const r = await mkRun(n);
    await modelToken(n, r);
    const stray = issueModelToken(RUN_TOKEN_SECRET, {
      runId: r.runId,
      sid: r.sessionId,
      nodeId: r.nodeId,
      agentId: 'a',
      ttlSeconds: 60,
    });
    const res = await postModel(n, r.runId, stray.token, ask());
    expect(res.statusCode).toBe(401);
    expect(codeOf(res)).toBe('unauthenticated');
    // Before any token was issued at all, a signed token has no jti to match either.
    const none = await mkRun(n);
    const noJti = issueModelToken(RUN_TOKEN_SECRET, {
      runId: none.runId,
      sid: none.sessionId,
      nodeId: none.nodeId,
      agentId: 'a',
      ttlSeconds: 60,
    });
    expect((await postModel(n, none.runId, noJti.token, ask())).statusCode).toBe(401);
  });

  it('binds step and run: another agent, another run and an orchestrator token are refused', async () => {
    const r = await mkRun(n);
    const other = await mkRun(n);
    const mt = await modelToken(n, r);
    // step binding: the body names another agent than the token
    const wrongAgent = await postModel(n, r.runId, mt, { ...ask(), agentId: 'b' });
    expect(wrongAgent.statusCode).toBe(403);
    expect(codeOf(wrongAgent)).toBe('model_not_allowed');
    const viaRunToken = await postModel(n, r.runId, r.runToken, { ...ask(), agentId: 'b' });
    expect(codeOf(viaRunToken)).toBe('model_not_allowed');
    // run binding: another run's id in the path
    const wrongRun = await postModel(n, other.runId, mt, ask());
    expect(wrongRun.statusCode).toBe(403);
    expect(codeOf(wrongRun)).toBe('model_not_allowed');
    // orchestrator token (no sid) is not a node token
    const orchestrator = n.services.control.issueToken(r.runId, 'w1');
    const orch = await postModel(n, r.runId, orchestrator, ask());
    expect(orch.statusCode).toBe(403);
    expect(codeOf(orch)).toBe('model_not_allowed');
    expect(await reservations(r.runId)).toEqual([]);
    expect(up.calls).toHaveLength(0);
  });

  it('kills the token on the very next call when the session is revoked, expired or the run cancelled', async () => {
    const r = await mkRun(n);
    const mt = await modelToken(n, r);
    expect((await postModel(n, r.runId, mt, ask())).statusCode).toBe(200);
    await n.services.runNodes.revoke(r.sessionId, 'step_end');
    const res = await postModel(n, r.runId, mt, ask());
    expect(res.statusCode).toBe(403);
    expect(codeOf(res)).toBe('run_node_session_revoked');
    // the run token of the same session is dead too
    expect(codeOf(await postModel(n, r.runId, r.runToken, ask()))).toBe('run_node_session_revoked');

    const e = await mkRun(n);
    const et = await modelToken(n, e);
    await n.ctx.db
      .update(runNodeSessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(runNodeSessions.id, e.sessionId));
    expect(codeOf(await postModel(n, e.runId, et, ask()))).toBe('run_node_session_revoked');

    const c = await mkRun(n);
    const ct = await modelToken(n, c);
    await n.ctx.db.update(runs).set({ cancelRequested: true }).where(eq(runs.id, c.runId));
    expect(codeOf(await postModel(n, c.runId, ct, ask()))).toBe('run_node_session_revoked');

    const t = await mkRun(n);
    const tt = await modelToken(n, t);
    await n.ctx.db.update(runs).set({ lockedBy: 'another-worker' }).where(eq(runs.id, t.runId));
    expect(codeOf(await postModel(n, t.runId, tt, ask()))).toBe('run_node_session_revoked');
    expect(up.calls).toHaveLength(0);
  });
});

describe('native call (JSON)', () => {
  it('serves the simulated provider through the proxy and books the measured cost', async () => {
    const r = await mkRun(n, {
      simulation:
        '        - { text: "scripted answer", usage: { inputTokens: 120, outputTokens: 34 } }',
    });
    const mt = await modelToken(n, r);
    const res = await postModel(n, r.runId, mt, ask('what is up?'));
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(body).toMatchObject({
      response: { text: 'scripted answer', stopReason: 'end_turn', model: 'sim-1' },
      usage: { inputTokens: 120, outputTokens: 34, source: 'provider' },
      costMicros: 0,
      priced: true,
    });
    expect(body.callId).toMatch(/^[0-9a-f-]{36}$/);
    const [resv] = await reservations(r.runId);
    expect(resv).toMatchObject({ id: body.callId, status: 'settled', sessionId: r.sessionId });
    const [line] = await ledger(r.runId);
    expect(line).toMatchObject({
      via: 'proxy',
      usageSource: 'provider',
      tokensIn: 120,
      tokensOut: 34,
    });
    const [step] = (await steps(r.runId)).filter((s) => s.kind === 'model_call');
    expect(step).toMatchObject({ provider: 'simulated', model: 'sim-1', status: 'ok' });
    // metadata capture: response text and stop reason, not the request messages
    expect(JSON.stringify(step?.output)).toContain('scripted answer');
    expect(JSON.stringify(step?.input)).not.toContain('what is up?');
    const [entry] = await audit(r.runId, 'step.model_call');
    expect(entry?.payload).toMatchObject({
      callId: body.callId,
      nodeId: r.nodeId,
      via: 'proxy',
      usageSource: 'provider',
      stopReason: 'end_turn',
    });
    expect(entry?.payload.requestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(entry?.payload)).not.toContain('what is up?');
    // also reachable with the step-scoped run token of the node (ADR 0009 section 2.1)
    expect((await postModel(n, r.runId, r.runToken, ask())).statusCode).toBe(200);
  });

  it('uses the simulation of the published definition, never one sent by the node', async () => {
    const r = await mkRun(n, { simulation: '        - { text: "published script" }' });
    const mt = await modelToken(n, r);
    const refused = await postModel(
      n,
      r.runId,
      mt,
      ask('x', { hints: { simulation: [{ text: 'evil' }] } }),
    );
    expect(refused.statusCode).toBe(400);
    expect(codeOf(refused)).toBe('model_parameter_refused');
    expect(refused.json().error.message).toContain('simulation');
    const ok = await postModel(n, r.runId, mt, ask('x', { hints: { context: { a: 1 } } }));
    expect(ok.json().response.text).toBe('published script');
  });

  it('refuses a model that is not the published one and a provider field (the caller cannot choose)', async () => {
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    const wrong = await postModel(n, r.runId, mt, ask('hi', {}, 'gpt-other'));
    expect(wrong.statusCode).toBe(403);
    expect(codeOf(wrong)).toBe('model_not_allowed');
    const withProvider = await postModel(n, r.runId, mt, {
      agentId: 'a',
      request: { model: 'gpt-x', provider: 'claude', messages: [{ role: 'user', content: 'x' }] },
    });
    expect(withProvider.statusCode).toBe(400);
    expect(codeOf(withProvider)).toBe('model_parameter_refused');
    expect(up.calls).toHaveLength(0);
    expect(await reservations(r.runId)).toEqual([]);
    const denied = await audit(r.runId, 'model.denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]?.payload).toMatchObject({
      reason: 'model_not_allowed',
      provider: 'oai',
      model: 'gpt-x',
      agentId: 'a',
    });
    // repeated identical denials are written once per minute with a counter
    for (let i = 0; i < 3; i++) await postModel(n, r.runId, mt, ask('hi', {}, 'gpt-other'));
    expect(await audit(r.runId, 'model.denied')).toHaveLength(1);
  });

  it('forwards to a real provider with the platform key resolved on the control node', async () => {
    up.handler = () => openaiJson({ text: 'from gpt', prompt: 1000, completion: 500 });
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    const res = await postModel(
      n,
      r.runId,
      mt,
      ask('hello', { maxTokens: 999_999, temperature: 0.2 }, 'gpt-x'),
    );
    expect(res.statusCode).toBe(200);
    expect(up.calls).toHaveLength(1);
    const call = up.calls[0]!;
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions');
    // The upstream request carries the platform key, never the node's token, and a clamped output.
    expect(call.headers.authorization).toBe(`Bearer ${PLATFORM_OPENAI_KEY}`);
    expect(JSON.stringify(call.headers)).not.toContain('oaxmt');
    expect(JSON.stringify(call.headers)).not.toContain('oaxrt');
    expect(call.body).toMatchObject({ model: 'gpt-x', temperature: 0.2 });
    expect(call.body.max_completion_tokens).toBe(131_072);
    // 1000 in x 10 + 500 out x 20 (USD per MTok) = 20 000 micro-USD
    expect(res.json()).toMatchObject({
      costMicros: 20_000,
      usage: { inputTokens: 1000, outputTokens: 500 },
    });
    expect(JSON.stringify(res.json())).not.toContain(PLATFORM_OPENAI_KEY);
  });

  it('relays tool calls and refuses a provider answer that is not valid', async () => {
    up.handler = () =>
      openaiJson({ toolCalls: [{ id: 'c1', name: 'jira_get', arguments: '{"id":"SEC-1"}' }] });
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    const res = await postModel(
      n,
      r.runId,
      mt,
      ask(
        'x',
        { tools: [{ name: 'jira_get', description: 'd', inputSchema: { type: 'object' } }] },
        'gpt-x',
      ),
    );
    expect(res.json().response).toMatchObject({
      stopReason: 'tool_use',
      toolCalls: [{ id: 'c1', name: 'jira_get', args: { id: 'SEC-1' } }],
    });
    up.handler = () =>
      openaiJson({ toolCalls: [{ id: 'c2', name: 'x', arguments: '{"constructor":{"a":1}}' }] });
    const bad = await postModel(n, r.runId, mt, ask('x', {}, 'gpt-x'));
    expect(bad.statusCode).toBe(502);
    expect(codeOf(bad)).toBe('provider_error');
  });
});

describe('admission', () => {
  it('refuses restricted data to a provider cleared lower, with zero upstream connections', async () => {
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x', classification: 'restricted' });
    const mt = await modelToken(n, r);
    const res = await postModel(n, r.runId, mt, ask('secret', {}, 'gpt-x'));
    expect(res.statusCode).toBe(403);
    expect(codeOf(res)).toBe('classification_denied');
    expect(up.calls).toHaveLength(0);
    expect(await reservations(r.runId)).toEqual([]);
    expect((await audit(r.runId, 'model.denied'))[0]?.payload.reason).toBe('classification_denied');
    // cleared enough: confidential data to the confidential provider passes the check
    up.handler = () =>
      json({
        id: 'm',
        model: 'claude-x',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 2 },
      });
    const ok = await mkRun(n, {
      provider: 'claude',
      model: 'claude-x',
      classification: 'confidential',
    });
    const okTok = await modelToken(n, ok);
    expect((await postModel(n, ok.runId, okTok, ask('x', {}, 'claude-x'))).statusCode).toBe(200);
  });

  it('refuses an unpriced model when a cost limit applies, but serves it without a limit', async () => {
    const limited = await mkRun(n, {
      provider: 'oai',
      model: 'gpt-unpriced',
      budget: '  maxCostUsd: 1',
    });
    const lt = await modelToken(n, limited);
    const res = await postModel(n, limited.runId, lt, ask('x', {}, 'gpt-unpriced'));
    expect(res.statusCode).toBe(422);
    expect(codeOf(res)).toBe('model_unpriced');
    expect(up.calls).toHaveLength(0);
    expect(await reservations(limited.runId)).toEqual([]);
    const free = await mkRun(n, { provider: 'oai', model: 'gpt-unpriced' });
    const ft = await modelToken(n, free);
    const ok = await postModel(n, free.runId, ft, ask('x', {}, 'gpt-unpriced'));
    expect(ok.statusCode).toBe(200);
    expect(ok.json().priced).toBe(false);
    expect(up.calls).toHaveLength(1);
  });

  it('refuses when the run budget cannot cover the reservation (403 control_budget_*)', async () => {
    const tokens = await mkRun(n, { provider: 'oai', model: 'gpt-x', budget: '  maxTokens: 100' });
    const tt = await modelToken(n, tokens);
    const a = await postModel(n, tokens.runId, tt, ask('x'.repeat(2000), {}, 'gpt-x'));
    expect(a.statusCode).toBe(403);
    expect(codeOf(a)).toBe('control_budget_tokens');
    const cost = await mkRun(n, {
      provider: 'oai',
      model: 'gpt-x',
      budget: '  maxCostUsd: 0.0001',
    });
    const ct = await modelToken(n, cost);
    const b = await postModel(n, cost.runId, ct, ask('x'.repeat(2000), {}, 'gpt-x'));
    expect(b.statusCode).toBe(403);
    expect(codeOf(b)).toBe('control_budget_cost');
    expect(up.calls).toHaveLength(0);
  });

  it('never oversells a budget with concurrent calls: reservations, not hope', async () => {
    // 0.01 USD at 10/20 USD per MTok. One call: ~1000 in, up to 256 out reserved.
    up.handler = async () => {
      await new Promise((r) => setTimeout(r, 40));
      return openaiJson({ text: 'x', prompt: 1000, completion: 200 });
    };
    const r = await mkRun(n, {
      provider: 'oai',
      model: 'gpt-x',
      budget: '  maxCostUsd: 0.02',
      maxTokensPerCall: 300,
    });
    const mt = await modelToken(n, r);
    const body = ask('y'.repeat(700), { maxTokens: 300 }, 'gpt-x');
    const results = await Promise.all(
      Array.from({ length: 10 }, () => postModel(n, r.runId, mt, body)),
    );
    const ok = results.filter((x) => x.statusCode === 200).length;
    const refused = results.filter((x) => x.statusCode === 403);
    expect(ok).toBeGreaterThan(0);
    expect(ok).toBeLessThan(10);
    expect(ok + refused.length).toBe(10);
    for (const x of refused) expect(codeOf(x)).toBe('control_budget_cost');
    // The limit is never exceeded, regardless of how many calls raced.
    const spent = (await ledger(r.runId)).reduce((a, l) => a + Number(l.costMicros), 0);
    expect(spent).toBeLessThanOrEqual(20_000);
    expect(up.calls).toHaveLength(ok);
    expect((await reservations(r.runId)).every((x) => x.status === 'settled')).toBe(true);
  });
});

describe('request validation', () => {
  let r: MadeRun;
  let mt: string;
  beforeAll(async () => {
    r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    mt = await modelToken(n, r);
  });

  const refused: [string, Record<string, unknown>][] = [
    [
      'server tool (typed web search)',
      { tools: [{ type: 'web_search_20250305', name: 'web_search', inputSchema: {} }] },
    ],
    [
      'server tool (code execution)',
      { tools: [{ name: 'code_exec', type: 'code_execution_20250522', inputSchema: {} }] },
    ],
    ['mcp_servers', { mcp_servers: [{ type: 'url', url: 'https://evil.example/mcp', name: 'x' }] }],
    ['container', { container: 'abc' }],
    ['service_tier', { service_tier: 'auto' }],
    ['file id', { files: ['file_abc'] }],
    ['unknown key', { response_format: { type: 'json_object' } }],
  ];
  for (const [name, extra] of refused) {
    it(`refuses ${name} with 400 and zero upstream requests`, async () => {
      const res = await postModel(n, r.runId, mt, ask('x', extra, 'gpt-x'));
      expect(res.statusCode).toBe(400);
      expect(['model_parameter_refused', 'model_request_invalid']).toContain(codeOf(res));
      expect(up.calls).toHaveLength(0);
      expect(await reservations(r.runId)).toEqual([]);
    });
  }

  it('refuses content blocks with URL or file sources (strings only)', async () => {
    const res = await postModel(n, r.runId, mt, {
      agentId: 'a',
      request: {
        model: 'gpt-x',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'url', url: 'https://evil.example/a.png' } },
            ],
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(codeOf(res)).toBe('model_request_invalid');
    expect(up.calls).toHaveLength(0);
  });

  it('refuses prototype keys, duplicate keys, deep nesting and malformed JSON', async () => {
    const send = (payload: string) =>
      n.req({
        method: 'POST',
        url: `/v1/worker/runs/${r.runId}/model`,
        token: mt,
        payload,
        headers: { 'content-type': 'application/json' },
      });
    const base = (extra: string) =>
      `{"agentId":"a","request":{"model":"gpt-x","messages":[{"role":"user","content":"x"}]${extra}}}`;
    const proto = await send(base(',"__proto__":{"admin":true}'));
    expect(proto.statusCode).toBe(400);
    expect(codeOf(proto)).toBe('model_parameter_refused');
    const ctor = await send(base(',"hints":{"context":{"constructor":{"x":1}}}'));
    expect(ctor.statusCode).toBe(400);
    const dup = await send(base(',"temperature":0.1,"temperature":2'));
    expect(dup.statusCode).toBe(400);
    expect(codeOf(dup)).toBe('model_request_invalid');
    const deep = await send(base(`,"hints":{"context":${'{"a":'.repeat(80)}1${'}'.repeat(80)}}`));
    expect(deep.statusCode).toBe(400);
    const broken = await send('{"agentId":');
    expect(broken.statusCode).toBe(400);
    expect(codeOf(broken)).toBe('model_request_invalid');
    const nonJson = await n.req({
      method: 'POST',
      url: `/v1/worker/runs/${r.runId}/model`,
      token: mt,
      payload: 'agentId=a',
      headers: { 'content-type': 'text/plain' },
    });
    expect(nonJson.statusCode).toBe(400);
    expect(up.calls).toHaveLength(0);
    // error messages never echo request content
    expect(proto.body + ctor.body + dup.body + deep.body + broken.body).not.toContain('admin');
  });

  it('refuses a body with both content-length and transfer-encoding', async () => {
    const res = await n.req({
      method: 'POST',
      url: `/v1/worker/runs/${r.runId}/model`,
      token: mt,
      payload: JSON.stringify(ask('x', {}, 'gpt-x')),
      headers: {
        'content-type': 'application/json',
        'content-length': '10',
        'transfer-encoding': 'chunked',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(codeOf(res)).toBe('model_request_invalid');
    expect(up.calls).toHaveLength(0);
  });

  it('refuses an oversized body with 413 model_request_too_large', async () => {
    const res = await postModel(n, r.runId, mt, ask('z'.repeat(70_000), {}, 'gpt-x'));
    expect(res.statusCode).toBe(413);
    expect(codeOf(res)).toBe('model_request_too_large');
    expect(up.calls).toHaveLength(0);
  });

  it('refuses invalid parameters and a malformed run id', async () => {
    const bad = await postModel(n, r.runId, mt, ask('x', { temperature: 9 }, 'gpt-x'));
    expect(bad.statusCode).toBe(400);
    expect(codeOf(bad)).toBe('model_request_invalid');
    const noMessages = await postModel(n, r.runId, mt, {
      agentId: 'a',
      request: { model: 'gpt-x', messages: [] },
    });
    expect(noMessages.statusCode).toBe(400);
    const wrongId = await postModel(n, 'not-a-uuid', mt, ask());
    expect(wrongId.statusCode).toBe(400);
  });
});

describe('provider keys and secrets', () => {
  it('scrubs a provider error that echoes the key; the key is in no response, log, audit or step', async () => {
    up.handler = () =>
      json(
        {
          error: {
            message: `Incorrect API key provided: ${PLATFORM_OPENAI_KEY}. Visit platform.example`,
          },
        },
        401,
      );
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    const res = await postModel(n, r.runId, mt, ask('hi', {}, 'gpt-x'));
    expect(res.statusCode).toBe(502);
    expect(codeOf(res)).toBe('provider_error');
    expect(res.json().error.message.length).toBeLessThanOrEqual(400);
    const dump = async () =>
      JSON.stringify([
        res.body,
        res.headers,
        await audit(r.runId),
        await steps(r.runId),
        await ledger(r.runId),
        await reservations(r.runId),
      ]) + log.text();
    const all = await dump();
    for (const key of ALL_KEYS) expect(all).not.toContain(key);
    // a 4xx before generation releases the reservation at zero
    const [resv] = await reservations(r.runId);
    expect(resv).toMatchObject({ status: 'settled', actualMicros: 0 });
    const [step] = (await steps(r.runId)).filter((s) => s.kind === 'model_call');
    expect(step?.status).toBe('error');
  });

  it('never logs prompts, responses or keys (metadata only)', async () => {
    up.handler = () => openaiJson({ text: 'CONFIDENTIAL-RESPONSE-TEXT' });
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    const res = await postModel(n, r.runId, mt, ask('CONFIDENTIAL-PROMPT-TEXT', {}, 'gpt-x'));
    expect(res.statusCode).toBe(200);
    const logs = log.text();
    expect(logs).toContain('model call');
    expect(logs).not.toContain('CONFIDENTIAL-PROMPT-TEXT');
    expect(logs).not.toContain('CONFIDENTIAL-RESPONSE-TEXT');
    expect(logs).not.toContain(mt);
    for (const key of ALL_KEYS) expect(logs).not.toContain(key);
    const entries = JSON.stringify(await audit(r.runId));
    expect(entries).not.toContain('CONFIDENTIAL-PROMPT-TEXT');
  });
});

describe('fail closed', () => {
  it('turns an internal error before the call into 503 with nothing forwarded or reserved', async () => {
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    const original = n.services.modelAccounting.reserve.bind(n.services.modelAccounting);
    n.services.modelAccounting.reserve = () =>
      Promise.reject(new Error('connection to db lost: secret-host'));
    try {
      const res = await postModel(n, r.runId, mt, ask('hi', {}, 'gpt-x'));
      expect(res.statusCode).toBe(503);
      expect(codeOf(res)).toBe('model_proxy_unavailable');
      expect(res.body).not.toContain('secret-host');
      expect(up.calls).toHaveLength(0);
    } finally {
      n.services.modelAccounting.reserve = original;
    }
    expect(await reservations(r.runId)).toEqual([]);
  });

  it('returns no model output when the call cannot be settled; the reservation stays for the reaper', async () => {
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    const original = n.services.modelAccounting.settle.bind(n.services.modelAccounting);
    n.services.modelAccounting.settle = () => Promise.reject(new Error('db down'));
    try {
      up.handler = () => openaiJson({ text: 'MUST-NOT-REACH-THE-NODE' });
      const res = await postModel(n, r.runId, mt, ask('hi', {}, 'gpt-x'));
      expect(res.statusCode).toBe(503);
      expect(res.body).not.toContain('MUST-NOT-REACH-THE-NODE');
      expect(up.calls).toHaveLength(1);
    } finally {
      n.services.modelAccounting.settle = original;
    }
    const [resv] = await reservations(r.runId);
    expect(resv?.status).toBe('active');
    // the reaper settles it at the reserved amount
    await n.ctx.db
      .update(modelReservations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(modelReservations.runId, r.runId));
    expect(await n.services.modelAccounting.expire()).toBeGreaterThanOrEqual(1);
    expect((await reservations(r.runId))[0]).toMatchObject({ status: 'expired' });
  });

  it('maps unexpected provider failures to 502 and releases or charges conservatively', async () => {
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    up.handler = () => json({ error: 'bad' }, 400);
    const a = await postModel(n, r.runId, mt, ask('hi', {}, 'gpt-x'));
    expect(a.statusCode).toBe(502);
    up.handler = () => {
      throw new Error('socket hang up');
    };
    const b = await postModel(n, r.runId, mt, ask('hi', {}, 'gpt-x'));
    expect(b.statusCode).toBe(502);
    const all = await reservations(r.runId);
    expect(all.every((x) => x.status === 'settled')).toBe(true);
  });

  it('answers 503 for a provider that cannot be built (broken BYOK connection)', async () => {
    const res = await n.req({
      method: 'POST',
      url: '/v1/connections',
      payload: {
        name: 'broken-llm',
        kind: 'model',
        config: { kind: 'openai', apiKeySecret: 'does-not-exist' },
      },
    });
    expect(res.statusCode).toBe(201);
    const r = await mkRun(n, { provider: 'broken-llm', model: 'm1' });
    expect(codeOf(await getModelToken(n, r.runId, r.runToken))).toBe('model_not_allowed');
    // a token issued before the connection broke cannot be simulated here; the call path:
    const mt = issueModelToken(RUN_TOKEN_SECRET, {
      runId: r.runId,
      sid: r.sessionId,
      nodeId: r.nodeId,
      agentId: 'a',
      ttlSeconds: 60,
    });
    await n.ctx.db
      .update(runNodeSessions)
      .set({ modelTokenJti: mt.claims.jti })
      .where(eq(runNodeSessions.id, r.sessionId));
    const call = await postModel(n, r.runId, mt.token, ask('hi', {}, 'm1'));
    expect(call.statusCode).toBe(503);
    expect(codeOf(call)).toBe('model_proxy_unavailable');
    expect(up.calls).toHaveLength(0);
  });
});

describe('BYOK and tenants', () => {
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
    const conn = await asB({
      method: 'POST',
      url: '/v1/connections',
      payload: {
        name: 'byok',
        kind: 'model',
        config: {
          kind: 'openai-compatible',
          baseUrl: 'https://llm.tenant-b.example/v1',
          apiKeySecret: 'tenant-b.openai',
          clearance: 'internal',
          models: [{ id: 'byok-model', inputPerMTok: 1, outputPerMTok: 2 }],
        },
      },
    });
    expect(conn.statusCode).toBe(201);
  });

  it("resolves the tenant's own key on the control node and never returns it", async () => {
    up.handler = (call) =>
      call.headers.authorization === `Bearer ${TENANT_B_KEY}`
        ? openaiJson({ text: 'tenant b answer' })
        : json({ error: 'wrong key' }, 401);
    const r = await mkRun(n, { provider: 'byok', model: 'byok-model' }, asB);
    const mt = (await getModelToken(n, r.runId, r.runToken)).json().token as string;
    const res = await postModel(n, r.runId, mt, ask('hi', {}, 'byok-model'));
    expect(res.statusCode).toBe(200);
    expect(up.calls[0]?.url).toBe('https://llm.tenant-b.example/v1/chat/completions');
    expect(res.body).not.toContain(TENANT_B_KEY);
    const dump =
      JSON.stringify([res.headers, await audit(r.runId), await steps(r.runId)]) + log.text();
    expect(dump).not.toContain(TENANT_B_KEY);
  });

  it("cannot reach another tenant's connection: tenant A naming provider 'byok' is refused", async () => {
    const r = await mkRun(n, { provider: 'byok', model: 'byok-model' });
    const tok = await getModelToken(n, r.runId, r.runToken);
    expect(tok.statusCode).toBe(403);
    expect(codeOf(tok)).toBe('model_not_allowed');
    // even with a forged-in-DB jti the call itself is refused and no key is used
    const mt = issueModelToken(RUN_TOKEN_SECRET, {
      runId: r.runId,
      sid: r.sessionId,
      nodeId: r.nodeId,
      agentId: 'a',
      ttlSeconds: 60,
    });
    await n.ctx.db
      .update(runNodeSessions)
      .set({ modelTokenJti: mt.claims.jti })
      .where(eq(runNodeSessions.id, r.sessionId));
    const call = await postModel(n, r.runId, mt.token, ask('hi', {}, 'byok-model'));
    expect(call.statusCode).toBe(403);
    expect(codeOf(call)).toBe('model_not_allowed');
    expect(up.calls.filter((c) => c.headers.authorization?.includes(TENANT_B_KEY))).toEqual([]);
    expect(up.calls).toHaveLength(0);
  });

  it("a token of tenant B's run cannot be used on tenant A's run", async () => {
    const b = await mkRun(n, { provider: 'simulated' }, asB);
    const a = await mkRun(n, { provider: 'simulated' });
    const bt = (await getModelToken(n, b.runId, b.runToken)).json().token as string;
    const res = await postModel(n, a.runId, bt, ask());
    expect(res.statusCode).toBe(403);
    expect(await reservations(a.runId)).toEqual([]);
  });
});

describe('metrics', () => {
  it('exposes the oax_model_proxy_* series without tenant or run labels', async () => {
    const r = await mkRun(n);
    const mt = await modelToken(n, r);
    await postModel(n, r.runId, mt, ask());
    const text = await n.ctx.metrics.registry.metrics();
    for (const name of [
      'oax_model_proxy_requests_total',
      'oax_model_proxy_tokens_total',
      'oax_model_proxy_reserved_micros',
      'oax_model_proxy_reservations_active',
      'oax_model_proxy_duration_seconds',
      'oax_model_proxy_aborts_total',
      'oax_model_proxy_streams_active',
    ])
      expect(text).toContain(name);
    expect(text).toMatch(
      /oax_model_proxy_requests_total\{[^}]*surface="native"[^}]*provider="simulated"[^}]*code="ok"/,
    );
    expect(text).not.toContain(r.runId);
  });
});

describe('rate limit buckets', () => {
  it('keys the HTTP rate limit per peer and token, not by the shared token prefix', async () => {
    const a = await mkRun(n);
    const b = await mkRun(n);
    const ta = await modelToken(n, a);
    const tb = await modelToken(n, b);
    // all model tokens start with the same claim bytes; their buckets must still differ
    expect(ta.slice(0, 24)).toBe(tb.slice(0, 24));
    const key = (token: string, ip = '10.0.0.1') =>
      modelRateKey({ ip, headers: { authorization: `Bearer ${token}` } });
    expect(key(ta)).not.toBe(key(tb));
    expect(key(ta)).toBe(key(ta));
    expect(key(ta)).not.toBe(key(ta, '10.0.0.2'));
    expect(key(ta)).not.toContain(ta);
    expect(modelRateKey({ ip: '10.0.0.1', headers: {} })).toMatch(/^10\.0\.0\.1\|/);
  });
});

describe('edge cases', () => {
  it('refuses a session whose steps do not match the token and an agent missing from the definition', async () => {
    const r = await mkRun(n);
    await n.ctx.db
      .update(runNodeSessions)
      .set({ steps: ['other'] })
      .where(eq(runNodeSessions.id, r.sessionId));
    const res = await postModel(n, r.runId, r.runToken, ask());
    expect(res.statusCode).toBe(403);
    expect(codeOf(res)).toBe('run_node_session_revoked');
    // a step-scoped token for an agent that the published definition does not contain
    const ghost = await mkRun(n);
    await n.ctx.db
      .update(runNodeSessions)
      .set({ steps: ['ghost'] })
      .where(eq(runNodeSessions.id, ghost.sessionId));
    const tok = issueRunToken(
      RUN_TOKEN_SECRET,
      {
        runId: ghost.runId,
        workerId: ghost.nodeId,
        ttlSeconds: 60,
        sid: ghost.sessionId,
        steps: ['ghost'],
      },
      Date.now(),
    );
    const noAgent = await postModel(n, ghost.runId, tok, { ...ask(), agentId: 'ghost' });
    expect(noAgent.statusCode).toBe(403);
    expect(codeOf(noAgent)).toBe('model_not_allowed');
    expect(up.calls).toHaveLength(0);
  });

  it('still refuses when the denial audit entry cannot be written', async () => {
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    const original = n.services.audit.append.bind(n.services.audit);
    n.services.audit.append = () => Promise.reject(new Error('audit down'));
    try {
      const res = await postModel(n, r.runId, mt, ask('hi', {}, 'gpt-other'));
      expect(res.statusCode).toBe(403);
      expect(codeOf(res)).toBe('model_not_allowed');
    } finally {
      n.services.audit.append = original;
    }
  });

  it('releases or charges a failed call by what the provider can have done', async () => {
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    // a network failure before any response: nothing was processed
    up.handler = () => {
      throw new Error('ECONNRESET');
    };
    expect((await postModel(n, r.runId, mt, ask('hi', {}, 'gpt-x'))).statusCode).toBe(502);
    // a 504 from a gateway may have done work: charged conservatively
    up.handler = () => json({ error: 'gateway timeout' }, 504);
    expect((await postModel(n, r.runId, mt, ask('hi', {}, 'gpt-x'))).statusCode).toBe(502);
    const all = await reservations(r.runId);
    expect(all.every((x) => x.status === 'settled')).toBe(true);
    expect(all.some((x) => Number(x.actualMicros) === 0)).toBe(true);
    expect(all.some((x) => Number(x.actualMicros) > 0)).toBe(true);
  });

  it('ends a call whose session lookup keeps failing (cannot tell: fail closed)', async () => {
    const r = await mkRun(n, { provider: 'oai', model: 'gpt-x' });
    const mt = await modelToken(n, r);
    up.handler = async (_c, init) => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 5000);
        init.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
      return openaiJson({ text: 'late' });
    };
    const original = n.services.runNodes.sessionById.bind(n.services.runNodes);
    let calls = 0;
    // the first lookup (authentication) works; the watcher's lookups fail
    n.services.runNodes.sessionById = async (sid: string) => {
      if (++calls > 1) throw new Error('db down');
      return original(sid);
    };
    try {
      const res = await postModel(n, r.runId, mt, ask('hi', {}, 'gpt-x'));
      expect(res.statusCode).toBe(403);
      expect(codeOf(res)).toBe('run_node_session_revoked');
    } finally {
      n.services.runNodes.sessionById = original;
    }
    expect(up.calls[0]?.aborted).toBe(true);
  });

  it('settles with the usage the provider reported, marked as proxy', async () => {
    const r = await mkRun(n, {
      simulation: '        - { text: "x", usage: { inputTokens: 5, outputTokens: 5 } }',
    });
    const mt = await modelToken(n, r);
    const original = n.services.modelAccounting.settle.bind(n.services.modelAccounting);
    let seen: unknown;
    n.services.modelAccounting.settle = (scope, id, req) => {
      seen = req;
      return original(scope, id, req);
    };
    try {
      expect((await postModel(n, r.runId, mt, ask())).statusCode).toBe(200);
    } finally {
      n.services.modelAccounting.settle = original;
    }
    expect(seen).toMatchObject({ via: 'proxy', usage: { inputTokens: 5, outputTokens: 5 } });
  });

  it('issues no model token through the service for a model token caller', async () => {
    const r = await mkRun(n);
    const mt = await modelToken(n, r);
    const auth = await n.services.modelProxy.authenticate(mt, r.runId);
    expect(auth.via).toBe('model-token');
    await expect(n.services.modelProxy.issueToken(auth, 'a')).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('prunes old rate windows without losing active ones', async () => {
    const svc = n.services.modelProxy as unknown as { windows: Map<string, number[]> };
    for (let i = 0; i < 10_050; i++) svc.windows.set(`stale-${i}`, [Date.now() - 120_000]);
    const r = await mkRun(n);
    const mt = await modelToken(n, r);
    expect((await postModel(n, r.runId, mt, ask())).statusCode).toBe(200);
    expect(svc.windows.size).toBeLessThan(100);
    expect(svc.windows.has(r.runId)).toBe(true);
  });
});
