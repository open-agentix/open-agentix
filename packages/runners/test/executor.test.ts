import { PolicyBundleSchema, loadAgentDefinition } from '@openagentix/core';
import { SimulatedProvider, type ModelProvider } from '@openagentix/providers';
import { afterEach, describe, expect, it } from 'vitest';
import { InProcessRunner, buildUserPrompt, executePipeline, type StepInput } from '../src/index.js';
import { agentFile, example, prepared, setup } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});
function env(...args: Parameters<typeof setup>) {
  const s = setup(...args);
  cleanups.push(() => s.tools.close());
  return s;
}
const kinds = (steps: StepInput[]) => steps.map((s) => `${s.kind}:${s.status}`);

describe('executePipeline', () => {
  it('runs the cve-triage example end to end', async () => {
    const def = loadAgentDefinition(example('cve-triage.agents.md'));
    const { ctx, control, store } = env(def);
    const event = JSON.parse(example('events/trivy-finding.json')) as unknown;
    const result = await new InProcessRunner().execute(prepared(def, event), ctx);
    expect(result.status).toBe('succeeded');
    expect(result.outputs[0]?.json).toMatchObject({
      cveId: 'CVE-2024-3094',
      severity: 'CRITICAL',
      cvss: 10,
      fixedIn: '5.6.2',
    });
    expect(result.outputs[1]?.content).toContain('## CVE-2024-3094: CRITICAL');
    expect(store.get('SEC-42')?.comments[0]).toBe(
      'CVE-2024-3094 (CRITICAL, CVSS 10) affects xz-utils in ghcr.io/acme/api:1.4.2. Fixed in 5.6.2.',
    );
    expect(kinds(control.steps)).toEqual([
      'model_call:ok',
      'policy_decision:ok',
      'tool_call:ok',
      'model_call:ok',
      'output:ok',
      'model_call:ok',
      'policy_decision:ok',
      'tool_call:ok',
      'model_call:ok',
      'output:ok',
    ]);
    expect(result.usage.toolCalls).toBe(2);
    expect(control.results.get('run-1')?.status).toBe('succeeded');
    expect(control.verifyAudit().valid).toBe(true);
  });

  it('denies calls outside the allowlist and lets the model continue', async () => {
    const def = agentFile(`    tools:
      - { server: tickets, tool: get_ticket, allowAdditionalArgs: true }
    simulation:
      responses:
        - toolCalls: [{ server: tickets, tool: delete_ticket, args: { key: SEC-1 } }]
        - text: gave up`);
    const { ctx, control } = env(def);
    const r = await executePipeline(prepared(def), ctx);
    expect(r.status).toBe('succeeded');
    expect(kinds(control.steps)).toEqual([
      'model_call:ok',
      'policy_decision:denied',
      'model_call:ok',
      'output:ok',
    ]);
  });

  it('blocks the run when a globally forbidden tool is attempted', async () => {
    const def = agentFile(`    tools:
      - { server: tickets, tool: "*", allowAdditionalArgs: true, approval: required }
    simulation:
      responses:
        - toolCalls: [{ server: tickets, tool: delete_ticket, args: { key: SEC-1 } }]
        - text: never`);
    const { ctx, store } = env(def);
    store.set('SEC-1', { key: 'SEC-1', status: 'open', labels: [], comments: [] });
    const run = {
      ...prepared(def),
      policies: [PolicyBundleSchema.parse({ forbiddenTools: ['*/delete_*'] })],
    };
    ctx.control = new (await import('../src/index.js')).LocalControlPlane({
      definition: def,
      policies: run.policies,
    });
    const r = await executePipeline(run, ctx);
    expect(r.status).toBe('blocked_by_policy');
    expect(r.error?.code).toBe('control_forbidden_action');
    expect(store.has('SEC-1')).toBe(true);
  });

  it('waits for approvals: approved, rejected and timeout', async () => {
    const def = loadAgentDefinition(example('ticket-updater.agents.md'));
    const event = JSON.parse(example('events/jira-issue.json')) as { data: unknown };
    const approved = env(def, { control: { approve: () => 'approved' } });
    const r1 = await executePipeline(prepared(def, event.data), approved.ctx);
    expect(r1.status).toBe('succeeded');
    expect(approved.store.get('SEC-42')).toMatchObject({
      status: 'triaged',
      labels: ['security', 'critical'],
    });
    expect(kinds(approved.control.steps)).toContain('approval:approved');

    const rejected = env(def, { control: { approve: () => 'rejected' } });
    const r2 = await executePipeline(prepared(def, event.data), rejected.ctx);
    expect(r2.status).toBe('succeeded');
    expect(rejected.store.get('SEC-42')?.status).toBe('open');

    const timeout = env(def, { control: { approve: () => 'timeout' } });
    const r3 = await executePipeline(prepared(def, event.data), timeout.ctx);
    expect(r3).toMatchObject({ status: 'failed', error: { code: 'approval_timeout' } });
  });

  it('kills runs that exceed budgets', async () => {
    const def = agentFile(
      `    simulation:
      responses:
        - text: one`,
      'budget: { maxTokens: 1 }',
    );
    const { ctx } = env(def);
    const r = await executePipeline(prepared(def), ctx);
    expect(r).toMatchObject({ status: 'succeeded' });
    const loop = agentFile(`    tools:
      - { server: cve-db, tool: lookup_cve, allowAdditionalArgs: true }
    simulation:
      responses:
        - toolCalls: [{ server: cve-db, tool: lookup_cve, args: { cveId: CVE-2021-44228 } }]
        - toolCalls: [{ server: cve-db, tool: lookup_cve, args: { cveId: CVE-2021-44228 } }]
        - toolCalls: [{ server: cve-db, tool: lookup_cve, args: { cveId: CVE-2021-44228 } }]
        - text: done`);
    const l = env(loop);
    const r2 = await executePipeline(prepared(loop), l.ctx);
    expect(r2).toMatchObject({ status: 'failed', error: { code: 'control_loop' } });
  });

  it('enforces per-agent step budgets and token budgets', async () => {
    const def = agentFile(`    budget: { maxSteps: 1 }
    tools:
      - { server: cve-db, tool: lookup_cve, allowAdditionalArgs: true }
    simulation:
      responses:
        - toolCalls: [{ server: cve-db, tool: lookup_cve, args: { cveId: CVE-2022-0778 } }]
        - text: done`);
    const { ctx } = env(def);
    expect((await executePipeline(prepared(def), ctx)).error?.code).toBe('control_budget_steps');
    const tokens = agentFile(
      `    tools:
      - { server: cve-db, tool: lookup_cve, allowAdditionalArgs: true }
    simulation:
      responses:
        - toolCalls: [{ server: cve-db, tool: lookup_cve, args: { cveId: CVE-2022-0778 } }]
          usage: { inputTokens: 100, outputTokens: 100 }
        - text: done`,
      'budget: { maxTokens: 50 }',
    );
    const t = env(tokens);
    expect((await executePipeline(prepared(tokens), t.ctx)).error?.code).toBe(
      'control_budget_tokens',
    );
  });

  it('blocks providers without clearance for the data classification', async () => {
    const def = agentFile('', 'classification: restricted');
    const { ctx } = env(def, {
      providers: [new SimulatedProvider({ name: 'simulated', clearance: 'internal' })],
    });
    const r = await executePipeline(prepared(def), ctx);
    expect(r).toMatchObject({
      status: 'blocked_by_policy',
      error: { code: 'control_classification' },
    });
  });

  it('handles cancellation, provider errors, refusals and timeouts', async () => {
    const def = agentFile('');
    const c = env(def);
    c.control.cancel('run-1');
    expect((await executePipeline(prepared(def), c.ctx)).status).toBe('cancelled');

    const failing: ModelProvider = {
      name: 'simulated',
      kind: 'simulated',
      clearance: 'restricted',
      complete: async () => {
        throw new Error('upstream 500');
      },
    };
    const f = env(def, { providers: [failing] });
    expect(await executePipeline(prepared(def), f.ctx)).toMatchObject({
      status: 'failed',
      error: { code: 'provider_error' },
    });

    const refusing: ModelProvider = {
      ...failing,
      complete: async () => ({
        text: '',
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 0 },
        stopReason: 'refusal',
        model: 'm',
      }),
    };
    const rf = env(def, { providers: [refusing] });
    expect((await executePipeline(prepared(def), rf.ctx)).error?.code).toBe('model_refusal');

    const ac = new AbortController();
    const hanging: ModelProvider = {
      ...failing,
      complete: (_req, opts) =>
        new Promise((_res, rej) => {
          if (opts?.signal?.aborted) rej(new Error('aborted'));
          opts?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
        }),
    };
    const h = env(def, { providers: [hanging] });
    h.ctx.signal = ac.signal;
    const pending = executePipeline(prepared(def), h.ctx);
    ac.abort();
    expect((await pending).status).toBe('cancelled');

    const slow = agentFile('', 'budget: { timeoutSeconds: 1 }');
    const s = env(slow, { providers: [hanging] });
    expect((await executePipeline(prepared(slow), s.ctx)).error?.code).toBe('control_timeout');
  });

  it('reports tool errors and unknown providers, charges tool prices', async () => {
    const def = agentFile(
      `    model: priced
    tools:
      - { server: cve-db, tool: lookup_cve, allowAdditionalArgs: true }
      - { server: tickets, tool: get_ticket, allowAdditionalArgs: true }
    simulation:
      responses:
        - toolCalls: [{ server: cve-db, tool: lookup_cve, args: { cveId: CVE-0000-1 } }, { server: tickets, tool: get_ticket, args: { key: X } }]
        - text: done`.replace('    model: priced\n', ''),
    );
    def.agents[0]!.model = 'priced';
    const { ctx, control } = env(def);
    ctx.tools.close = ctx.tools.close.bind(ctx.tools);
    const r = await executePipeline(prepared(def), ctx);
    expect(r.status).toBe('succeeded');
    expect(control.steps.filter((s) => s.kind === 'tool_call').map((s) => s.status)).toEqual([
      'error',
      'ok',
    ]);
    expect(r.usage.costMicros).toBeGreaterThan(20_000);

    const unknown = agentFile('');
    unknown.agents[0]!.provider = 'missing';
    const u = env(unknown);
    expect(await executePipeline(prepared(unknown), u.ctx)).toMatchObject({
      status: 'failed',
      error: { code: 'provider_unknown' },
    });
  });

  it('records gateway failures as tool errors', async () => {
    const def = agentFile(`    tools:
      - { server: ghost, tool: x, allowAdditionalArgs: true }
    simulation:
      responses:
        - text: hi`);
    const { ctx } = env(def);
    expect((await executePipeline(prepared(def), ctx)).error?.message).toMatch(/not configured/);
    const def2 = agentFile(`    tools:
      - { server: cve-db, tool: lookup_cve, allowAdditionalArgs: true }
    simulation:
      responses:
        - toolCalls: [{ server: cve-db, tool: lookup_cve, args: {} }]
        - text: ok`);
    const e2 = env(def2);
    e2.ctx.tools.call = async () => {
      throw new Error('connection reset');
    };
    const r = await executePipeline(prepared(def2), e2.ctx);
    expect(r.status).toBe('succeeded');
    expect(e2.control.steps.find((s) => s.kind === 'tool_call')?.output).toEqual({
      error: 'connection reset',
    });
    const e3 = env(def2);
    e3.ctx.tools.call = async (_c, gate) => ({
      status: 'denied',
      decision: await gate.decide({ server: 'x', tool: 'y', args: {} }),
    });
    expect((await executePipeline(prepared(def2), e3.ctx)).status).toBe('succeeded');
  });

  it('pauses on rate limits and keeps json output as text when invalid', async () => {
    const def = agentFile(`    outputs: [{ format: json }]
    tools:
      - { server: cve-db, tool: lookup_cve, allowAdditionalArgs: true }
    simulation:
      responses:
        - toolCalls: [{ server: cve-db, tool: lookup_cve, args: { cveId: CVE-2022-0778 } }]
        - text: not json`);
    const { ctx, control } = env(def);
    const run = { ...prepared(def), limits: { maxToolCallsPerMinute: 1 } };
    const r = await executePipeline(run, ctx);
    expect(r.status).toBe('succeeded');
    expect(r.outputs[0]).toEqual({ agentId: 'a', format: 'json', content: 'not json' });
    expect(kinds(control.steps)).toContain('control:ok');
  });

  it('redacts secrets in prompts and includes previous output', () => {
    const def = agentFile('');
    const p = {
      ...prepared(def, { token: 'abc', note: 'x' }),
      event: { ...prepared(def).event, data: { password: 'p' }, subject: 'S' },
    };
    const text = buildUserPrompt(p, { agentId: 'prev', format: 'text', content: 'hello' });
    expect(text).toContain('[REDACTED]');
    expect(text).toContain('(subject: S)');
    expect(text).toContain('Output of the previous agent "prev"');
  });
});
