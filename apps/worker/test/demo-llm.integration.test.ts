import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { demoServerFactories, inMemoryServers } from '@openagentix/mcp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testNode, type TestNode } from '../../api/test/helpers.js';
import { DemoLlmRunner, Worker } from '../src/index.js';

/**
 * Opt-in (OAX_TEST_CLAUDE=1): the public-demo flow with the REAL Claude Code CLI. A visitor starts
 * a fixed scenario through the API, the worker runs it through the harness (haiku, strict
 * budgets), steps and costs end up in the run. Uses the login of the current user or
 * OAX_TEST_CLAUDE_TOKEN_FILE. OAX_TEST_CLAUDE_REPORT=<file> writes a sanitized summary.
 */
const enabled = process.env.OAX_TEST_CLAUDE === '1';
let n: TestNode;
let worker: Worker;

describe.skipIf(!enabled)('demo with OAX_DEMO_LLM=claude-code (real run)', () => {
  beforeAll(async () => {
    n = await testNode({
      OAX_DEMO_MODE: 'true',
      OAX_DEMO_LLM: 'claude-code',
      OAX_WORKER_POLL_MS: '50',
      ...(process.env.OAX_TEST_CLAUDE_TOKEN_FILE
        ? { OAX_DEMO_LLM_TOKEN_FILE: process.env.OAX_TEST_CLAUDE_TOKEN_FILE }
        : {}),
    });
    worker = new Worker(n.ctx, {
      workerId: 'demo-real',
      inMemoryMcp: inMemoryServers(demoServerFactories()),
      runner: new DemoLlmRunner(n.ctx.config.demo, {
        workRoot: process.env.OAX_TEST_WORKROOT ?? '/root/work/scratch/b/work',
      }),
    });
    mkdirSync(process.env.OAX_TEST_WORKROOT ?? '/root/work/scratch/b/work', { recursive: true });
    worker.start();
  }, 300_000);
  afterAll(async () => {
    await worker?.stop(true);
    await n?.close();
  });

  it('runs a fixed scenario end to end', async () => {
    const started = Date.now();
    const res = await n.req({
      method: 'POST',
      url: '/v1/demo/scenarios/cve-xz-backdoor/run',
      remoteAddress: '198.51.100.9',
    });
    expect(res.statusCode).toBe(202);
    const id = res.json().runId as string;
    let run: Record<string, unknown>;
    for (;;) {
      run = (await n.req({ method: 'GET', url: `/v1/runs/${id}` })).json();
      if (['succeeded', 'failed', 'blocked_by_policy'].includes(String(run.status))) break;
      if (Date.now() - started > 240_000) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 500));
    }
    const steps = (await n.req({ method: 'GET', url: `/v1/runs/${id}/steps` })).json().items as {
      kind: string;
      name: string;
      status: string;
      provider?: string;
    }[];
    expect(run.errorCode).toBeNull();
    expect(run.status).toBe('succeeded');
    expect(Number(run.costMicros)).toBeGreaterThan(0);
    expect(Number(run.costMicros)).toBeLessThan(50_000); // below the per-run cap of 0.05 USD
    expect(steps.some((s) => s.kind === 'tool_call' && s.status === 'ok')).toBe(true);
    expect(steps.every((s) => s.kind !== 'tool_call' || /^(cve-db|tickets)\//.test(s.name))).toBe(
      true,
    );
    expect(
      (await n.req({ method: 'POST', url: '/v1/audit/verify', payload: {} })).json().valid,
    ).toBe(true);
    const overview = (await n.req({ method: 'GET', url: '/v1/demo/scenarios' })).json();
    expect(overview.llm.spentTodayUsd).toBeGreaterThan(0);

    const path = process.env.OAX_TEST_CLAUDE_REPORT;
    if (path) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        `# Demo with OAX_DEMO_LLM=claude-code: real verification

A visitor request \`POST /v1/demo/scenarios/cve-xz-backdoor/run\` (no body, fixed scenario) was
executed by the worker through the Claude Code harness on ${new Date().toISOString().slice(0, 10)}
(CLI \`${process.env.OAX_TEST_CLAUDE_VERSION ?? 'n/a'}\`, model \`haiku\`, existing host login, no token printed).

| Field | Value |
| --- | --- |
| Run status | \`${String(run.status)}\` |
| Wall time | ${((Date.now() - started) / 1000).toFixed(1)} s |
| Cost (both pipeline agents) | $${(Number(run.costMicros) / 1e6).toFixed(4)} of the $0.05 per-run cap |
| Policy-gated tool calls | ${String(run.toolCalls)} |
| Daily budget spent / cap | $${overview.llm.spentTodayUsd.toFixed(4)} / $${overview.llm.dailyBudgetUsd.toFixed(2)} |
| Audit chain | valid |

Recorded steps: ${steps.map((s) => `\`${s.kind}:${s.name}:${s.status}\``).join(', ')}
`,
      );
    }
  }, 300_000);
});
