import { describe, expect, it } from 'vitest';
import { HttpControlPlane, LocalControlPlane, type RunResult } from '../src/index.js';
import { agentFile } from './helpers.js';

const def = agentFile(`    tools:
      - { server: s, tool: t, maxCallsPerRun: 1 }`);

describe('LocalControlPlane', () => {
  it('decides, counts calls, audits and verifies', async () => {
    const steps: string[] = [];
    const cp = new LocalControlPlane({
      definition: def,
      onStep: (_r, s) => void steps.push(s.kind),
    });
    expect((await cp.decideToolCall('r', 'a', { server: 's', tool: 't', args: {} })).effect).toBe(
      'allow',
    );
    expect((await cp.decideToolCall('r', 'a', { server: 's', tool: 't', args: {} })).effect).toBe(
      'deny',
    );
    expect(
      (await cp.decideToolCall('r', 'ghost', { server: 's', tool: 't', args: {} })).effect,
    ).toBe('deny');
    await cp.recordStep('r', { kind: 'output', agentId: 'a', name: 'x', status: 'ok' });
    expect(
      await cp.awaitApproval(
        'r',
        'a',
        { server: 's', tool: 't', args: {} },
        { effect: 'require_approval', reasons: [], grant: null },
      ),
    ).toBe('rejected');
    expect(await cp.isCancelled('r')).toBe(false);
    const result: RunResult = {
      status: 'succeeded',
      outputs: [],
      usage: { tokensIn: 0, tokensOut: 0, costMicros: 0, steps: 0, toolCalls: 0 },
    };
    await cp.completeRun('r', result);
    expect(steps).toEqual(['output']);
    expect(cp.audit.map((a) => a.action)).toEqual([
      'policy.decision',
      'policy.decision',
      'policy.decision',
      'step.output',
      'approval.decided',
      'run.completed',
    ]);
    expect(cp.verifyAudit().valid).toBe(true);
  });
});

describe('HttpControlPlane', () => {
  it('speaks the worker API with the run token', async () => {
    const calls: { url: string; method: string; auth: string; body: unknown }[] = [];
    const replies: unknown[] = [
      { effect: 'allow', reasons: [], grant: null },
      null,
      { approvalId: 'ap1' },
      { status: 'pending' },
      { status: 'approved' },
      { cancelled: true },
      { blocked: false, breaches: [] },
      null,
    ];
    const cp = new HttpControlPlane({
      baseUrl: 'https://control.example/',
      runToken: 'oaxrt.x.y',
      approvalPollMs: 1,
      fetchImpl: async (url, init) => {
        const headers = init?.headers as Record<string, string>;
        calls.push({
          url,
          method: String(init?.method),
          auth: headers.authorization ?? '',
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        const r = replies.shift();
        return r === null ? new Response(null, { status: 204 }) : Response.json(r);
      },
    });
    const call = { server: 's', tool: 't', args: {} };
    expect((await cp.decideToolCall('r1', 'a', call)).effect).toBe('allow');
    await cp.recordStep('r1', { kind: 'output', agentId: 'a', name: 'x', status: 'ok' });
    expect(
      await cp.awaitApproval('r1', 'a', call, {
        effect: 'require_approval',
        reasons: [],
        grant: null,
      }),
    ).toBe('approved');
    expect(await cp.isCancelled('r1')).toBe(true);
    expect(await cp.checkBudget('r1')).toEqual({ blocked: false, breaches: [] });
    await cp.completeRun('r1', {
      status: 'failed',
      outputs: [],
      usage: { tokensIn: 0, tokensOut: 0, costMicros: 0, steps: 0, toolCalls: 0 },
    });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://control.example/v1/worker/runs/r1/gate',
      'POST https://control.example/v1/worker/runs/r1/steps',
      'POST https://control.example/v1/worker/runs/r1/approvals',
      'GET https://control.example/v1/worker/runs/r1/approvals/ap1',
      'GET https://control.example/v1/worker/runs/r1/approvals/ap1',
      'GET https://control.example/v1/worker/runs/r1/status',
      'GET https://control.example/v1/worker/runs/r1/budget',
      'POST https://control.example/v1/worker/runs/r1/complete',
    ]);
    expect(calls.every((c) => c.auth === 'Bearer oaxrt.x.y')).toBe(true);
  });

  it('raises on HTTP errors and uses global fetch by default', async () => {
    const cp = new HttpControlPlane({
      baseUrl: 'http://x',
      runToken: 't',
      fetchImpl: async () => new Response('no', { status: 401 }),
    });
    await expect(cp.isCancelled('r')).rejects.toThrow(/HTTP 401/);
    expect(new HttpControlPlane({ baseUrl: 'http://x', runToken: 't' })).toBeTruthy();
  });
});

describe('HttpControlPlane run node protocol', () => {
  const calls: { url: string; method: string; body?: string }[] = [];
  const mk = (reply: () => Response) =>
    new HttpControlPlane({
      baseUrl: 'http://api:8080/',
      runToken: 'oaxrt.a.b',
      fetchImpl: async (url, init) => {
        calls.push({
          url,
          method: init?.method ?? 'GET',
          ...(init?.body ? { body: String(init.body) } : {}),
        });
        return reply();
      },
    });
  const handover = {
    agentId: 'a',
    agent: { id: 'a', provider: 'simulated', model: 'sim-1', instructions: 'x' },
    input: { x: 1 },
    attempt: 1,
    run: { name: 'n', version: '1.0.0', classification: 'internal', budget: {} },
    mcp: [],
  };
  it('fetches and parses the handover, credentials and posts the result', async () => {
    calls.length = 0;
    const cp = mk(() => Response.json(handover));
    const h = await cp.fetchHandover('run-1', 'a b');
    expect(h.agent.id).toBe('a');
    expect(calls[0]!.url).toBe('http://api:8080/v1/worker/runs/run-1/handover?agentId=a%20b');
    const cred = mk(() =>
      Response.json({ agentId: 'a', expiresAt: 'x', credentials: [], connections: [] }),
    );
    await cred.fetchCredentials('run-1', 'a');
    expect(calls[1]).toMatchObject({ method: 'POST', body: '{"agentId":"a"}' });
    const post = mk(() => new Response(null, { status: 204 }));
    await post.postHandoverResult('run-1', { agentId: 'a', format: 'json', content: '{}' });
    expect(calls[2]!.url).toBe('http://api:8080/v1/worker/runs/run-1/handover/result');
  });
  it('refuses a malformed handover and exposes the HTTP status of errors', async () => {
    await expect(
      mk(() => Response.json({ ...handover, extra: 1 })).fetchHandover('r', 'a'),
    ).rejects.toThrow();
    await expect(
      mk(() => Response.json({ ...handover, agent: {} })).fetchHandover('r', 'a'),
    ).rejects.toThrow();
    const err = await mk(() => new Response('{}', { status: 409 }))
      .fetchCredentials('r', 'a')
      .catch((e) => e);
    expect(err.details).toEqual({ status: 409 });
    expect(err.message).toContain('HTTP 409');
  });
});

describe('HttpControlPlane model proxy calls (ADR 0009)', () => {
  const mk = (reply: () => Response, seen: { url: string; body?: string; auth?: string }[] = []) =>
    new HttpControlPlane({
      baseUrl: 'http://api:8080/',
      runToken: 'oaxrt.a.b',
      fetchImpl: async (url, init) => {
        seen.push({
          url,
          ...(init?.body ? { body: String(init.body) } : {}),
          auth: String((init?.headers as Record<string, string>).authorization),
        });
        return reply();
      },
    });
  const req = {
    agentId: 'a',
    request: { model: 'm', messages: [{ role: 'user' as const, content: 'x' }] },
  };

  it('posts model calls to the native endpoint with the run token', async () => {
    const seen: { url: string; body?: string; auth?: string }[] = [];
    const out = { callId: 'c' };
    const cp = mk(() => Response.json(out), seen);
    await expect(cp.modelCall('r1', req)).resolves.toEqual(out);
    expect(seen[0]).toMatchObject({
      url: 'http://api:8080/v1/worker/runs/r1/model',
      auth: 'Bearer oaxrt.a.b',
    });
    expect(JSON.parse(seen[0]!.body!)).toEqual(req);
  });

  it('posts reservations to the reservation endpoint', async () => {
    const seen: { url: string; body?: string }[] = [];
    const grant = {
      reservationId: 'x',
      maxOutputTokens: 5,
      reservedMicros: 1,
      priced: true,
      remaining: {},
    };
    const cp = mk(() => Response.json(grant), seen);
    await expect(
      cp.reserveModelCall('r1', { agentId: 'a', inputTokens: 10, maxOutputTokens: 5 }),
    ).resolves.toEqual(grant);
    expect(seen[0]!.url).toBe('http://api:8080/v1/worker/runs/r1/model-reservations');
  });

  it('surfaces the stable code of a refusal, but only a well-formed one', async () => {
    const refuse = (body: unknown) => mk(() => new Response(JSON.stringify(body), { status: 403 }));
    await expect(
      refuse({ error: { code: 'control_budget_cost', message: 'no' } }).modelCall('r', req),
    ).rejects.toMatchObject({ code: 'control_budget_cost', message: 'no' });
    await expect(
      refuse({ error: { code: 'Not A Code!', message: 'x' } }).modelCall('r', req),
    ).rejects.toMatchObject({ code: 'control_plane_error' });
    await expect(
      mk(() => new Response('<html>', { status: 502 })).reserveModelCall('r', {
        agentId: 'a',
        inputTokens: 1,
        maxOutputTokens: 1,
      }),
    ).rejects.toMatchObject({ code: 'control_plane_error' });
  });
});
