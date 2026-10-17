import type { AgentDefinition } from '@openagentix/core';
import { describe, expect, it, vi } from 'vitest';
import { NodeDispatcher } from '../src/node-dispatcher.js';

/** ADR 0017 S5: a development run (a draft revision) never delivers a pull request. */
const request = {
  runId: 'r1',
  input: {},
  agent: {
    id: 'fix',
    provider: 'simulated',
    model: 'sim-1',
    outputs: [{ format: 'pull-request', target: 't' }],
  },
};
const dispatcher = (stage?: 'production' | 'development') => {
  const prepare = vi.fn();
  const d = new NodeDispatcher(
    {
      services: {} as never,
      runners: {},
      workerId: 'w',
      controlUrl: 'http://api',
      limits: { cpus: 1, memoryMb: 512, pids: 64 },
      delivery: { has: () => true, prepare } as never,
      ...(stage ? { stage } : {}),
    },
    { runtime: { runner: 'container' } } as AgentDefinition,
  );
  return { d, prepare };
};

describe('pull request output in a development run', () => {
  it('fails closed before the workspace is prepared', async () => {
    const { d, prepare } = dispatcher('development');
    await expect(d.dispatch(request as never)).rejects.toMatchObject({
      code: 'pull_request_not_in_development',
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('is not refused for that reason in a production run', async () => {
    const { d } = dispatcher('production');
    const err = await d.dispatch(request as never).catch((e: unknown) => e);
    expect((err as { code?: string }).code).not.toBe('pull_request_not_in_development');
  });
});
