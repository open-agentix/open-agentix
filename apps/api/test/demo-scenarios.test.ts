import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { DEMO_SCENARIOS, findDemoScenario, visitorKey } from '../src/index.js';
import { testNode, type TestNode } from './helpers.js';

let n: TestNode;
let nonDemo: TestNode;
beforeAll(async () => {
  // Seeding the demo data set is slow: one demo node, limits are adjusted per test.
  n = await testNode({ OAX_DEMO_MODE: 'true' });
  nonDemo = await testNode();
}, 300_000);
afterAll(async () => {
  await n.close();
  await nonDemo.close();
});
const tune = (o: Partial<TestNode['ctx']['config']['demo']>) => Object.assign(n.ctx.config.demo, o);
const resetRuns = () => n.ctx.database.db.execute(`update runs set triggered_by = 'seed'` as never);

const run = (node: TestNode, scenario: string, ip = '203.0.113.5') =>
  node.req({
    method: 'POST',
    url: `/v1/demo/scenarios/${scenario}/run`,
    remoteAddress: ip,
  });

describe('demo scenarios', () => {
  it('are fixed data, found by id', () => {
    expect(DEMO_SCENARIOS.map((s) => s.id)).toHaveLength(3);
    expect(findDemoScenario('cve-xz-backdoor')?.agent).toBe('cve-triage');
    expect(findDemoScenario('nope')).toBeUndefined();
    expect(findDemoScenario(undefined)).toBeUndefined();
    expect(visitorKey('1.2.3.4', 's')).toMatch(/^[0-9a-f]{16}$/);
    expect(visitorKey('1.2.3.4', 's')).not.toBe(visitorKey('1.2.3.5', 's'));
  });

  it('do not exist outside demo mode', async () => {
    expect((await nonDemo.req({ method: 'GET', url: '/v1/demo/scenarios' })).statusCode).toBe(404);
    expect((await run(nonDemo, 'cve-xz-backdoor')).statusCode).toBe(404);
  }, 120_000);

  it('queue a run from the fixed table, rate limit per visitor and keep the demo read-only', async () => {
    await resetRuns();
    tune({ rate: { runs: 2, windowSeconds: 600 }, dailyRuns: 100, llm: 'simulated' });
    const overview = (await n.req({ method: 'GET', url: '/v1/demo/scenarios' })).json();
    expect(overview.llm).toMatchObject({ mode: 'simulated', model: null });
    expect(overview.rateLimit).toEqual({ runs: 2, windowSeconds: 600 });
    expect(overview.scenarios).toHaveLength(3);

    const first = await run(n, 'cve-xz-backdoor');
    expect(first.statusCode).toBe(202);
    const runId = first.json().runId as string;
    const detail = (await n.req({ method: 'GET', url: `/v1/runs/${runId}` })).json();
    expect(detail).toMatchObject({
      status: 'queued',
      triggeredBy: expect.stringMatching(/^demo-scenario:[0-9a-f]{16}$/),
    });
    expect(detail.triggeredBy).not.toContain('203.0.113.5');

    expect((await run(n, 'cve-log4shell')).statusCode).toBe(202);
    const limited = await run(n, 'cve-http2-rapid-reset');
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toBe('rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // another visitor is not affected
    expect((await run(n, 'cve-http2-rapid-reset', '203.0.113.99')).statusCode).toBe(202);
    // unknown scenarios, free-text bodies are not a thing
    expect((await run(n, 'free-text', '203.0.113.7')).statusCode).toBe(404);
    // everything else stays read-only
    const write = await n.req({ method: 'POST', url: '/v1/agents', payload: { source: 'x' } });
    expect(write.statusCode).toBe(403);
    expect(write.json().error).toBe('demo_read_only');
  }, 120_000);

  it('caps the runs per day', async () => {
    n = await testNode({
      OAX_DEMO_MODE: 'true',
      OAX_DEMO_DAILY_RUNS: '1',
      OAX_DEMO_RATE_RUNS: '10',
    });
    expect((await run(n, 'cve-xz-backdoor')).statusCode).toBe(202);
    const r = await run(n, 'cve-xz-backdoor', '203.0.113.50');
    expect(r.statusCode).toBe(429);
    expect(r.json().error).toBe('demo_daily_limit');
  }, 120_000);

  it('claude-code mode: one live run at a time and a daily budget', async () => {
    await resetRuns();
    tune({
      llm: 'claude-code',
      dailyBudgetUsd: 0.06,
      runBudgetUsd: 0.05,
      rate: { runs: 10, windowSeconds: 600 },
      dailyRuns: 100,
    });
    expect((await n.req({ method: 'GET', url: '/v1/demo/scenarios' })).json().llm).toMatchObject({
      mode: 'claude-code',
      model: 'haiku',
      dailyBudgetUsd: 0.06,
      spentTodayUsd: 0,
    });
    const first = await run(n, 'cve-xz-backdoor');
    expect(first.statusCode).toBe(202);
    const busy = await run(n, 'cve-log4shell', '203.0.113.60');
    expect(busy.statusCode).toBe(429);
    expect(busy.json().error).toBe('demo_busy');

    // finish the run with a cost: only 0.01 USD of the 0.06 budget remain -> a 0.05 run does not fit
    await n.ctx.database.db.execute(
      `update runs set status = 'succeeded', cost_micros = 20000 where triggered_by like 'demo-scenario:%'` as never,
    );
    const exhausted = await run(n, 'cve-log4shell', '203.0.113.61');
    expect(exhausted.statusCode).toBe(429);
    expect(exhausted.json().error).toBe('demo_budget_exhausted');
    const after = (await n.req({ method: 'GET', url: '/v1/demo/scenarios' })).json().llm;
    expect(after.spentTodayUsd).toBeCloseTo(0.02);
    expect(after.remainingUsd).toBeCloseTo(0.04);
  }, 120_000);

  it('refuses claude-code mode outside demo mode', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'test', OAX_DATABASE_URL: 'memory://', OAX_DEMO_LLM: 'claude-code' }),
    ).toThrow(/requires OAX_DEMO_MODE/);
    const c = loadConfig({
      NODE_ENV: 'test',
      OAX_DATABASE_URL: 'memory://',
      OAX_DEMO_MODE: 'true',
      OAX_DEMO_LLM: 'claude-code',
      OAX_DEMO_LLM_TOKEN_FILE: '/run/secrets/claude-oauth-token',
    });
    expect(c.demo).toMatchObject({
      llm: 'claude-code',
      llmModel: 'haiku',
      llmTokenFile: '/run/secrets/claude-oauth-token',
      dailyBudgetUsd: 1,
      runBudgetUsd: 0.05,
      rate: { runs: 3, windowSeconds: 600 },
      dailyRuns: 100,
    });
  });
});
