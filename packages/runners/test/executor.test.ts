import { PolicyBundleSchema, loadAgentDefinition } from '@openagentix/core';
import { SimulatedProvider, type ModelProvider } from '@openagentix/providers';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InProcessRunner,
  buildUserPrompt,
  executePipeline,
  type ModelReservationRequest,
  type StepInput,
} from '../src/index.js';
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

describe('executePipeline budgets', () => {
  const def = agentFile(`    simulation:
      responses:
        - text: done`);
  const breach = {
    scope: 'use_case' as const,
    key: 'triage',
    limitMicros: 100,
    spentMicros: 100,
    message: 'use case "triage" reached its monthly budget (0.00 of 0.00 USD)',
  };

  it('stops before the first model call when a monthly budget is already reached', async () => {
    const { ctx, control } = env(def, {
      control: { checkBudget: async () => ({ blocked: true, breaches: [breach] }) },
    });
    let model = 0;
    const base = ctx.providers.get('simulated');
    ctx.providers.get = () => ({
      ...base,
      name: base.name,
      kind: base.kind,
      clearance: base.clearance,
      complete: async (...a: Parameters<typeof base.complete>) => (model++, base.complete(...a)),
    });
    const r = await executePipeline(prepared(def), ctx);
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('control_budget_use_case');
    expect(model).toBe(0);
    expect(kinds(control.steps)).toEqual(['control:error']);
  });

  it('stops mid-run when another run exhausts the budget between two steps', async () => {
    const def2 = agentFile(`    tools:
      - { server: tickets, tool: "*", allowAdditionalArgs: true }
    simulation:
      responses:
        - toolCalls: [{ server: tickets, tool: list_tickets, args: {} }]
        - text: never reached`);
    // Another run spends the rest of the budget after this run's first model call.
    let seen: StepInput[] = [];
    const { ctx, control } = env(def2, {
      control: {
        checkBudget: async () =>
          seen.some((st) => st.kind === 'model_call')
            ? { blocked: true, breaches: [breach] }
            : { blocked: false, breaches: [] },
      },
    });
    seen = control.steps;
    const r = await executePipeline(prepared(def2), ctx);
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('control_budget_use_case');
    expect(kinds(control.steps)).toContain('model_call:ok');
    expect(kinds(control.steps).at(-1)).toBe('control:error');
  });

  it('runs normally while the budget has headroom', async () => {
    const { ctx } = env(def, {
      control: { checkBudget: async () => ({ blocked: false, breaches: [] }) },
    });
    expect((await executePipeline(prepared(def), ctx)).status).toBe('succeeded');
  });
});

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

describe('executePipeline model reservations and metered providers (ADR 0009)', () => {
  const def = agentFile(
    `    maxTokensPerCall: 1000
    simulation:
      responses:
        - text: done`,
  );

  it('reserves before each call, caps the output at the grant and settles with the reservation id', async () => {
    const { ctx, control } = env(def);
    const reserved: ModelReservationRequest[] = [];
    const seen: (number | undefined)[] = [];
    const base = ctx.providers.get('simulated');
    ctx.providers.get = () => ({
      ...base,
      name: base.name,
      kind: base.kind,
      clearance: base.clearance,
      complete: async (...a: Parameters<typeof base.complete>) => (
        seen.push(a[0].maxTokens),
        base.complete(...a)
      ),
    });
    (control as { reserveModelCall?: unknown }).reserveModelCall = async (
      _run: string,
      req: (typeof reserved)[number],
    ) => {
      reserved.push(req);
      return {
        reservationId: 'res-1',
        maxOutputTokens: 300,
        reservedMicros: 7,
        priced: true,
        remaining: {},
      };
    };
    const r = await executePipeline(prepared(def), ctx);
    expect(r.status).toBe('succeeded');
    expect(reserved).toHaveLength(1);
    expect(reserved[0]).toMatchObject({
      agentId: 'a',
      maxOutputTokens: 1000,
      minOutputTokens: 256,
    });
    expect(reserved[0]!.inputTokens).toBeGreaterThan(64);
    expect(seen).toEqual([300]);
    const call = control.steps.find((s) => s.kind === 'model_call');
    expect(call?.reservationId).toBe('res-1');
  });

  it('uses the default output bound when the step names none', async () => {
    const d = agentFile(`    simulation:\n      responses:\n        - text: done`);
    const { ctx, control } = env(d);
    let asked = 0;
    (control as { reserveModelCall?: unknown }).reserveModelCall = async (
      _run: string,
      req: { maxOutputTokens: number },
    ) => {
      asked = req.maxOutputTokens;
      return {
        reservationId: 'r',
        maxOutputTokens: 100,
        reservedMicros: 0,
        priced: false,
        remaining: {},
      };
    };
    await executePipeline(prepared(d), ctx);
    expect(asked).toBe(4096);
  });

  it.each([
    ['control_budget_cost', 'failed'],
    ['control_budget_tenant', 'failed'],
    ['model_unpriced', 'failed'],
    ['classification_denied', 'blocked_by_policy'],
  ])(
    'keeps the code of a refused reservation (%s) and never calls the model',
    async (code, status) => {
      const { ctx, control } = env(def);
      let model = 0;
      const base = ctx.providers.get('simulated');
      ctx.providers.get = () => ({
        ...base,
        name: base.name,
        kind: base.kind,
        clearance: base.clearance,
        complete: async (...a: Parameters<typeof base.complete>) => (model++, base.complete(...a)),
      });
      (control as { reserveModelCall?: unknown }).reserveModelCall = async () => {
        throw Object.assign(new Error('refused'), { code });
      };
      const r = await executePipeline(prepared(def), ctx);
      expect(r.status).toBe(status);
      expect(r.error?.code).toBe(code);
      expect(model).toBe(0);
      // the failed call is recorded as an error without a reservation to give back
      expect(control.steps.find((s) => s.kind === 'error')?.reservationId).toBeUndefined();
    },
  );

  it('gives the reservation back only for failures that provably did no work', async () => {
    const failWith = (err: Error): ModelProvider => ({
      name: 'simulated',
      kind: 'simulated',
      clearance: 'restricted',
      complete: async () => {
        throw err;
      },
    });
    const grantOf = () => async () => ({
      reservationId: 'res-x',
      maxOutputTokens: 10,
      reservedMicros: 1,
      priced: true,
      remaining: {},
    });
    const released = async (err: Error): Promise<boolean> => {
      const e = env(def, { providers: [failWith(err)] });
      (e.control as { reserveModelCall?: unknown }).reserveModelCall = grantOf();
      await executePipeline(prepared(def), e.ctx);
      return e.control.steps.find((s) => s.kind === 'error')?.reservationId === 'res-x';
    };
    const withProps = (m: string, p: object) => Object.assign(new Error(m), p);
    expect(await released(withProps('denied', { code: 'egress_denied' }))).toBe(true);
    expect(await released(withProps('dns', { status: null, preSend: true }))).toBe(true);
    expect(await released(withProps('bad request', { status: 400 }))).toBe(true);
    expect(await released(withProps('forbidden', { status: 403 }))).toBe(true);
    // may have been billed: the reservation stays and expires at the reserved amount
    expect(await released(new Error('upstream 500'))).toBe(false);
    expect(await released(withProps('server', { status: 500 }))).toBe(false);
    expect(await released(withProps('timeout', { status: 408 }))).toBe(false);
    expect(await released(withProps('conflict', { status: 409 }))).toBe(false);
    expect(await released(withProps('rate', { status: 429 }))).toBe(false);
    expect(await released(withProps('reset', { status: null }))).toBe(false);
  });

  it('bounds the provider call by the reservation deadline and keeps the reservation', async () => {
    const waiting: ModelProvider = {
      name: 'simulated',
      kind: 'simulated',
      clearance: 'restricted',
      complete: (_req, opts) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(new Error('call timed out')));
        }),
    };
    const e = env(def, { providers: [waiting] });
    (e.control as { reserveModelCall?: unknown }).reserveModelCall = async () => ({
      reservationId: 'res-d',
      maxOutputTokens: 10,
      reservedMicros: 1,
      priced: true,
      deadlineMs: 30,
      remaining: {},
    });
    const r = await executePipeline(prepared(def), e.ctx);
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('provider_error');
    expect(e.control.steps.find((s) => s.kind === 'error')?.reservationId).toBeUndefined();
  });

  it('gives the reservation back when the provider fails on its own, but not when aborted', async () => {
    const failing: ModelProvider = {
      name: 'simulated',
      kind: 'simulated',
      clearance: 'restricted',
      complete: async () => {
        throw Object.assign(new Error('bad request'), { status: 400 });
      },
    };
    const { ctx, control } = env(def, { providers: [failing] });
    (control as { reserveModelCall?: unknown }).reserveModelCall = async () => ({
      reservationId: 'res-9',
      maxOutputTokens: 10,
      reservedMicros: 1,
      priced: true,
      remaining: {},
    });
    const r = await executePipeline(prepared(def), ctx);
    expect(r.error?.code).toBe('provider_error');
    expect(control.steps.find((s) => s.kind === 'error')?.reservationId).toBe('res-9');

    const ac = new AbortController();
    const hanging: ModelProvider = {
      ...failing,
      complete: async () => {
        ac.abort();
        throw new Error('aborted');
      },
    };
    const s2 = env(def, { providers: [hanging] });
    (s2.control as { reserveModelCall?: unknown }).reserveModelCall = async () => ({
      reservationId: 'res-10',
      maxOutputTokens: 10,
      reservedMicros: 1,
      priced: true,
      remaining: {},
    });
    const r2 = await executePipeline(prepared(def), { ...s2.ctx, signal: ac.signal });
    expect(r2.status).toBe('cancelled');
    expect(s2.control.steps.find((s) => s.kind === 'error')?.reservationId).toBeUndefined();
  });

  it('trusts a metered provider: no reservation, no model_call step, cost from the proxy', async () => {
    const metered: ModelProvider = {
      name: 'simulated',
      kind: 'simulated',
      clearance: 'restricted',
      metered: true,
      complete: async () => ({
        text: 'done',
        toolCalls: [],
        usage: { inputTokens: 11, outputTokens: 4 },
        stopReason: 'end_turn',
        model: 'sim-1',
        metered: { callId: 'c1', costMicros: 123, priced: true, remaining: {} },
      }),
    };
    const { ctx, control } = env(def, { providers: [metered] });
    let reserved = 0;
    (control as { reserveModelCall?: unknown }).reserveModelCall = async () => (reserved++, {});
    const r = await executePipeline(prepared(def), ctx);
    expect(r.status).toBe('succeeded');
    expect(reserved).toBe(0);
    expect(control.steps.some((s) => s.kind === 'model_call')).toBe(false);
    expect(r.usage).toMatchObject({ tokensIn: 11, tokensOut: 4, costMicros: 123 });
  });

  it('turns a refusal of the proxy into the run failure with the same code', async () => {
    const refusing: ModelProvider = {
      name: 'simulated',
      kind: 'simulated',
      clearance: 'restricted',
      metered: true,
      complete: async () => {
        throw Object.assign(new Error('the token budget cannot cover the call'), {
          code: 'control_budget_tokens',
        });
      },
    };
    const { ctx } = env(def, { providers: [refusing] });
    const r = await executePipeline(prepared(def), ctx);
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('control_budget_tokens');
  });

  it('calls the model unreserved when the control plane has no ledger', async () => {
    const { ctx, control } = env(def);
    expect('reserveModelCall' in control).toBe(false);
    const r = await executePipeline(prepared(def), ctx);
    expect(r.status).toBe('succeeded');
    expect(control.steps.find((s) => s.kind === 'model_call')?.reservationId).toBeUndefined();
  });
});
