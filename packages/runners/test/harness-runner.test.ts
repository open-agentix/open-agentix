import { existsSync } from 'node:fs';
import {
  OaxError,
  PolicyBundleSchema,
  loadAgentDefinition,
  type AgentDefinition,
} from '@openagentix/core';
import { describe, expect, it } from 'vitest';
import {
  executeWithHarness,
  type ExternalHarness,
  type HarnessInvocation,
  type HarnessResult,
} from '../src/index.js';
import { agentFile, prepared, setup } from './helpers.js';

type Script = (
  call: (name: string, args: Record<string, unknown>) => Promise<string>,
) => Promise<Partial<HarnessResult>>;

/** A harness that behaves like Claude Code would: it connects to the gate and calls tools. */
class ScriptedHarness implements ExternalHarness {
  readonly name = 'claude-code' as const;
  invocations: HarnessInvocation[] = [];
  cwds: string[] = [];
  constructor(private readonly script: Script) {}

  buildInvocation(
    _def: AgentDefinition,
    _agent: unknown,
    prompt: string,
    gate: { serverName: string; url: string; runToken: string },
    tools?: readonly { modelName: string }[],
  ): HarnessInvocation {
    const inv: HarnessInvocation = {
      command: 'scripted',
      args: [],
      env: {},
      files: { 'gate.json': JSON.stringify(gate) },
      stdin: prompt,
      limits: { maxTurns: 3, ...(tools ? {} : {}) },
    };
    this.invocations.push(inv);
    return inv;
  }

  async run(inv: HarnessInvocation, opts: { cwd: string }): Promise<HarnessResult> {
    this.cwds.push(opts.cwd);
    const gate = JSON.parse(inv.files['gate.json']!) as { url: string; runToken: string };
    const called: HarnessResult['toolCalls'] = [];
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await fetch(gate.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${gate.runToken}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: called.length + 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      const r = ((await res.json()) as { result: { content: unknown; isError?: boolean } }).result;
      const text = JSON.stringify(r.content);
      called.push({
        id: String(called.length),
        name: `mcp__oax-gate__${name}`,
        input: args,
        isError: r.isError === true,
        output: text,
      });
      return text;
    };
    const partial = await this.script(call);
    return {
      exitCode: 0,
      text: 'answer',
      isError: false,
      turns: 2,
      costUsd: 0.002,
      tokensIn: 100,
      tokensOut: 20,
      toolCalls: called,
      terminated: 'none',
      ...partial,
    };
  }
}

const TOOLS = `    tools:
      - server: cve-db
        tool: lookup_cve
        allowAdditionalArgs: true
      - server: tickets
        tool: add_comment
        args: { key: { type: string }, comment: { type: string } }
      - server: tickets
        tool: update_ticket
        approval: required
        allowAdditionalArgs: true`;

const steps = (control: { steps: { kind: string; status: string }[] }) =>
  control.steps.map((s) => `${s.kind}:${s.status}`);

describe('executeWithHarness', () => {
  it('runs through the gate: policy decision, tool call, model call (harness cost), output, audit', async () => {
    const def = agentFile(TOOLS);
    const harness = new ScriptedHarness(async (call) => {
      await call('cve-db__lookup_cve', { cveId: 'CVE-2024-3094' });
      return {};
    });
    const { ctx, control, store, tools } = setup(def);
    const r = await executeWithHarness(prepared(def, { q: 1 }), ctx, harness, {});
    await tools.close();
    expect(r.status).toBe('succeeded');
    expect(r.outputs[0]).toMatchObject({ agentId: 'a', content: 'answer' });
    expect(r.usage).toMatchObject({ toolCalls: 1, tokensIn: 100, tokensOut: 20, costMicros: 2000 });
    expect(steps(control)).toEqual([
      'policy_decision:ok',
      'tool_call:ok',
      'model_call:ok',
      'output:ok',
    ]);
    expect(control.verifyAudit().valid).toBe(true);
    expect(store.size).toBe(0);
    // minimal prompt: the event, no secrets; temp dir removed afterwards
    expect(harness.invocations[0]!.stdin).toContain('"q": 1');
    expect(existsSync(harness.cwds[0]!)).toBe(false);
  });

  it('keeps the work directory on request', async () => {
    const def = agentFile(TOOLS);
    const harness = new ScriptedHarness(async () => ({}));
    const { ctx, tools } = setup(def);
    await executeWithHarness(prepared(def), ctx, harness, { keepWorkDir: true });
    await tools.close();
    expect(existsSync(harness.cwds[0]!)).toBe(true);
    const { rmSync } = await import('node:fs');
    rmSync(harness.cwds[0]!, { recursive: true });
  });

  it('refuses tools that are not granted and stops on forbidden tools', async () => {
    const def = agentFile(TOOLS);
    const policies = [PolicyBundleSchema.parse({ forbiddenTools: ['tickets/add_*'] })];
    const harness = new ScriptedHarness(async (call) => {
      expect(await call('tickets__delete_ticket', { key: 'X' })).toContain('not available');
      await call('tickets__add_comment', { key: 'SEC-1', comment: 'x' });
      return {};
    });
    const { ctx, control, store, tools } = setup(def, { control: { policies } });
    const r = await executeWithHarness({ ...prepared(def), policies }, ctx, harness, {});
    await tools.close();
    expect(r.status).toBe('blocked_by_policy');
    expect(r.error?.code).toBe('control_forbidden_action');
    expect(steps(control)).toContain('policy_decision:denied');
    expect(steps(control)).toContain('control:error');
    expect(store.size).toBe(0);
  });

  it('waits for approvals: approved executes, rejected is denied, timeout fails the run', async () => {
    const def = agentFile(TOOLS);
    for (const [outcome, status, expectedText] of [
      ['approved', 'succeeded', 'ok'],
      ['rejected', 'succeeded', 'Rejected by a human approver'],
      ['timeout', 'failed', 'Denied by policy'],
    ] as const) {
      const harness = new ScriptedHarness(async (call) => {
        const text = await call('tickets__update_ticket', { key: 'SEC-9', labels: ['a'] });
        expect(text).toContain(expectedText === 'ok' ? 'SEC-9' : expectedText);
        return {};
      });
      const { ctx, control, store, tools } = setup(def, { control: { approve: () => outcome } });
      const r = await executeWithHarness(prepared(def), ctx, harness, {});
      await tools.close();
      expect(r.status).toBe(status);
      expect(steps(control)).toContain(
        `approval:${outcome === 'approved' ? 'approved' : 'rejected'}`,
      );
      expect(store.has('SEC-9')).toBe(outcome === 'approved');
      if (outcome === 'timeout') expect(r.error?.code).toBe('approval_timeout');
    }
  });

  it('blocks the run when the harness used a tool outside the gate', async () => {
    const def = agentFile(TOOLS);
    const harness = new ScriptedHarness(async () => ({
      toolCalls: [{ id: '1', name: 'Bash', input: { command: 'id' }, isError: false, output: '' }],
    }));
    const { ctx, control, tools } = setup(def);
    const r = await executeWithHarness(prepared(def), ctx, harness, {});
    await tools.close();
    expect(r).toMatchObject({
      status: 'blocked_by_policy',
      error: { code: 'harness_unmanaged_tool' },
    });
    expect(r.error?.message).toContain('Bash');
    expect(steps(control)).toContain('control:error');
  });

  it('maps harness terminations to control error codes', async () => {
    const def = agentFile(TOOLS);
    const cases: [Partial<HarnessResult>, string, string][] = [
      [{ isError: true, terminated: 'turns', errorMessage: 'x' }, 'failed', 'control_budget_steps'],
      [{ isError: true, terminated: 'budget' }, 'failed', 'control_budget_cost'],
      [{ isError: true, terminated: 'timeout' }, 'failed', 'control_timeout'],
      [{ isError: true, terminated: 'cancelled' }, 'cancelled', 'cancelled'],
      [{ isError: true, errorMessage: 'broken' }, 'failed', 'harness_error'],
      [{ isError: true }, 'failed', 'harness_error'],
    ];
    for (const [partial, status, code] of cases) {
      const { ctx, tools } = setup(def);
      const r = await executeWithHarness(
        prepared(def),
        ctx,
        new ScriptedHarness(async () => partial),
        {},
      );
      await tools.close();
      expect(r).toMatchObject({ status, error: { code } });
    }
  });

  it('records harness start failures and keeps their error code', async () => {
    const def = agentFile(TOOLS);
    const { ctx, control, tools } = setup(def);
    const h = new ScriptedHarness(async () => ({}));
    h.run = () => Promise.reject(new OaxError('harness_spawn_failed', 'cannot start claude'));
    const r = await executeWithHarness(prepared(def), ctx, h, {});
    const h2 = new ScriptedHarness(async () => ({}));
    h2.run = () => Promise.reject(new Error('plain'));
    const r2 = await executeWithHarness(prepared(def), ctx, h2, {});
    await tools.close();
    expect(r.error?.code).toBe('harness_spawn_failed');
    expect(r2.error?.code).toBe('harness_error');
    expect(steps(control)).toContain('error:error');
  });

  it('enforces the run cost budget from the harness-reported cost', async () => {
    const def = agentFile('', 'budget:\n  maxCostUsd: 0.001\n');
    const { ctx, tools } = setup(def);
    const r = await executeWithHarness(
      prepared(def),
      ctx,
      new ScriptedHarness(async () => ({})),
      {},
    );
    await tools.close();
    expect(r).toMatchObject({ status: 'failed', error: { code: 'control_budget_cost' } });
  });

  it('applies classification clearance, cancellation and unknown agents', async () => {
    const restricted = agentFile(TOOLS, 'classification: restricted');
    const lowClearance = {
      ...restricted,
      agents: restricted.agents.map((a) => ({ ...a, provider: 'claude-code' })),
    };
    const { ctx, tools } = setup(lowClearance);
    const blocked = await executeWithHarness(
      prepared(lowClearance),
      ctx,
      new ScriptedHarness(async () => ({})),
      {
        clearance: 'internal',
      },
    );
    expect(blocked).toMatchObject({
      status: 'blocked_by_policy',
      error: { code: 'control_classification' },
    });
    const allowed = await executeWithHarness(
      prepared(lowClearance),
      ctx,
      new ScriptedHarness(async () => ({})),
      {
        clearance: 'restricted',
      },
    );
    expect(allowed.status).toBe('succeeded');

    const def = agentFile(TOOLS);
    const c = setup(def);
    c.control.cancel('run-1');
    expect(
      (await executeWithHarness(prepared(def), c.ctx, new ScriptedHarness(async () => ({})), {}))
        .status,
    ).toBe('cancelled');
    const broken = { ...def, pipeline: ['ghost'] };
    expect(
      (await executeWithHarness(prepared(broken), c.ctx, new ScriptedHarness(async () => ({})), {}))
        .error?.code,
    ).toBe('agent_unknown');
    await tools.close();
    await c.tools.close();
  });

  it('chains a pipeline and parses json outputs', async () => {
    const def = loadAgentDefinition(`---
apiVersion: openagentix.io/v1alpha1
kind: AgentPipeline
name: chain
version: 1.0.0
owner: team
agents:
  - id: a
    provider: simulated
    model: sim-1
    instructions: First.
    outputs: [{ format: json }]
  - id: b
    provider: simulated
    model: sim-1
    instructions: Second.
---
`);
    const prompts: string[] = [];
    const harness = new ScriptedHarness(async () => ({ text: '{"k":1}' }));
    const orig = harness.buildInvocation.bind(harness);
    harness.buildInvocation = (...args) => {
      prompts.push(args[2]);
      return orig(...args);
    };
    const { ctx, tools } = setup(def);
    const r = await executeWithHarness(prepared(def), ctx, harness, {});
    await tools.close();
    expect(r.status).toBe('succeeded');
    expect(r.outputs).toHaveLength(2);
    expect(r.outputs[0]!.json).toEqual({ k: 1 });
    expect(prompts[1]).toContain('previous agent "a"');
  });
});

describe('runLocal with a harness', () => {
  it('uses the harness executor and completes the run on the local control plane', async () => {
    const { runLocal } = await import('../src/index.js');
    const { example } = await import('./helpers.js');
    const harness = new ScriptedHarness(async (call) => {
      await call('cve-db__lookup_cve', { cveId: 'CVE-2024-3094' });
      return {};
    });
    const report = await runLocal({
      agentsSource: example('cve-triage.agents.md'),
      event: { image: 'x', finding: { cveId: 'CVE-2024-3094' }, ticket: 'SEC-42' },
      harness,
      harnessOptions: { clearance: 'restricted' },
      approve: 'all',
    });
    expect(report.result.status).toBe('succeeded');
    expect(report.steps.some((s) => s.provider === 'claude-code')).toBe(true);
    expect(report.audit.valid).toBe(true);
  });
});
