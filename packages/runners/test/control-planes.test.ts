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
