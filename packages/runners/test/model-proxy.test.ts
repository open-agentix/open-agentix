import { describe, expect, it } from 'vitest';
import { ModelProxyProvider, type ModelProxyClient } from '../src/index.js';
import type { WorkerModelRequest, WorkerModelResponse } from '@openagentix/providers';

const reply = (over: Partial<WorkerModelResponse> = {}): WorkerModelResponse => ({
  callId: 'call-1',
  response: {
    text: 'hi',
    toolCalls: [{ id: 't1', name: 'lookup', args: { a: 1 } }],
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: 'tool_use',
    model: 'sim-1',
  },
  usage: {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    source: 'provider',
  },
  costMicros: 42,
  priced: true,
  remaining: { costMicros: 100 },
  ...over,
});

function client(res: WorkerModelResponse = reply()) {
  const calls: { runId: string; req: WorkerModelRequest }[] = [];
  const c: ModelProxyClient = {
    modelCall: async (runId, req) => (calls.push({ runId, req }), res),
  };
  return { c, calls };
}

describe('ModelProxyProvider', () => {
  it('is metered, restricted-clearance and carries the published provider name', () => {
    const p = new ModelProxyProvider({
      name: 'anthropic',
      runId: 'r1',
      agentId: 'a',
      client: client().c,
    });
    expect(p).toMatchObject({ name: 'anthropic', metered: true, clearance: 'restricted' });
  });

  it('sends only the allowed wire fields (never the simulation script) and maps the answer', async () => {
    const { c, calls } = client();
    const p = new ModelProxyProvider({
      name: 'simulated',
      runId: 'r1',
      agentId: 'a',
      client: c,
      kind: 'simulated',
    });
    const res = await p.complete({
      model: 'sim-1',
      system: 'sys',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'lookup', inputSchema: {} }],
      maxTokens: 99,
      temperature: 0.2,
      hints: { simulation: [{ text: 'secret script' }], context: { k: 1 } },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.runId).toBe('r1');
    expect(calls[0]!.req).toEqual({
      agentId: 'a',
      request: {
        model: 'sim-1',
        system: 'sys',
        messages: [{ role: 'user', content: 'x' }],
        tools: [{ name: 'lookup', inputSchema: {} }],
        maxTokens: 99,
        temperature: 0.2,
        hints: { context: { k: 1 } },
      },
    });
    expect(JSON.stringify(calls[0]!.req)).not.toContain('secret script');
    expect(res).toMatchObject({
      text: 'hi',
      stopReason: 'tool_use',
      model: 'sim-1',
      usage: { inputTokens: 10, outputTokens: 5 },
      metered: { callId: 'call-1', costMicros: 42, priced: true, remaining: { costMicros: 100 } },
    });
  });

  it('omits empty optional fields and keeps cache tokens when present', async () => {
    const { c, calls } = client(
      reply({ usage: { ...reply().usage, cacheReadTokens: 3, cacheWriteTokens: 4 } }),
    );
    const p = new ModelProxyProvider({ name: 'p', runId: 'r', agentId: 'a', client: c });
    const res = await p.complete({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      tools: [],
    });
    expect(calls[0]!.req.request).toEqual({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(res.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
    });
  });

  it('passes the abort signal on and fails closed on an unusable body', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const bad: ModelProxyClient = {
      modelCall: async (_r, _q, o) => (signals.push(o?.signal), {} as WorkerModelResponse),
    };
    const p = new ModelProxyProvider({ name: 'p', runId: 'r', agentId: 'a', client: bad });
    const ac = new AbortController();
    await expect(
      p.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }] }, { signal: ac.signal }),
    ).rejects.toMatchObject({ code: 'model_proxy_invalid' });
    expect(signals[0]).toBe(ac.signal);
  });

  it('lets a refusal of the proxy through unchanged', async () => {
    const refuse: ModelProxyClient = {
      modelCall: async () => {
        throw Object.assign(new Error('budget'), { code: 'control_budget_cost' });
      },
    };
    const p = new ModelProxyProvider({ name: 'p', runId: 'r', agentId: 'a', client: refuse });
    await expect(
      p.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({ code: 'control_budget_cost' });
  });
});
