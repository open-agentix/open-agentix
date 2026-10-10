import { loadAgentDefinition, type AgentDefinition } from '@openagentix/core';
import { withSpan } from '@openagentix/api';
import type { ChatRequest, ChatResponse, ModelProvider } from '@openagentix/providers';
import { SimulatedProvider } from '@openagentix/providers';
import {
  NodeStepFailure,
  executePipeline,
  type RunResult,
  type RunnerContext,
} from '@openagentix/runners';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureTelemetryRuntime, resetTelemetryRuntime } from '../../api/src/telemetry.js';
import { sanitizeReadableSpan } from '../../api/src/telemetry-export.js';
import { telemetryRuntime } from '../../api/src/telemetry-runtime.js';
import { attributesComply, startTracing } from '../../api/test/trace-harness.js';
import { agentFile, example, prepared, setup } from '../../../packages/runners/test/helpers.js';
import { executorTelemetry } from '../src/executor-spans.js';

/**
 * Slice S3 of ADR 0015: executor spans. The pipeline runs against the real span adapter, the real
 * allowlist and an in-memory exporter; nothing is mocked on the telemetry side.
 */
let t: ReturnType<typeof startTracing>;
type ReadableSpan = ReturnType<
  ReturnType<typeof startTracing>['exporter']['getFinishedSpans']
>[number];
const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
  t = startTracing();
});
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
  await t.stop();
  resetTelemetryRuntime();
});

const RUN = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const ROOT = '33333333-3333-4333-8333-333333333333';
const KIND: readonly string[] = ['INTERNAL', 'SERVER', 'CLIENT', 'PRODUCER', 'CONSUMER'];

interface Node {
  line: string;
  span: ReadableSpan;
  children: Node[];
}

/** Indented `name (kind) [!error]` lines of the finished spans, parents before children. */
function shape(spans: readonly ReadableSpan[]): string[] {
  const nodes = new Map<string, Node>();
  for (const span of spans) {
    const err = span.status.code === 2 ? ` !${String(span.attributes['error.type'])}` : '';
    nodes.set(span.spanContext().spanId, {
      line: `${span.name} (${KIND[span.kind]})${err}`,
      span,
      children: [],
    });
  }
  const roots: Node[] = [];
  for (const n of nodes.values()) {
    const parent = nodes.get(n.span.parentSpanContext?.spanId ?? '');
    (parent ? parent.children : roots).push(n);
  }
  const out: string[] = [];
  const walk = (n: Node, depth: number) => {
    out.push(`${'  '.repeat(depth)}${n.line}`);
    n.children.sort((a, b) => hr(a.span) - hr(b.span)).forEach((c) => walk(c, depth + 1));
  };
  roots.forEach((r) => walk(r, 0));
  return out;
}
const hr = (s: ReadableSpan) => s.startTime[0] * 1e9 + s.startTime[1];

const byName = (prefix: string) =>
  t.exporter.getFinishedSpans().filter((s) => s.name.startsWith(prefix));
const one = (prefix: string): ReadableSpan => {
  const found = byName(prefix);
  expect(found, prefix).toHaveLength(1);
  return found[0]!;
};
const events = (s: ReadableSpan): Record<string, unknown>[] =>
  s.events.map((e) => ({ name: e.name, ...e.attributes }));
const without = (a: Record<string, unknown>, ...keys: string[]) =>
  Object.fromEntries(Object.entries(a).filter(([k]) => !keys.includes(k)));

interface Scenario {
  def: AgentDefinition;
  data?: unknown;
  control?: Parameters<typeof setup>[1] extends infer O
    ? O extends { control?: infer C }
      ? C
      : never
    : never;
  providers?: ModelProvider[];
  configure?: (ctx: RunnerContext) => void;
}

/** Runs the pipeline inside an attempt-like parent span, with executor spans switched on. */
async function go(sc: Scenario, withTelemetry = true) {
  const s = setup(sc.def, {
    ...(sc.providers ? { providers: sc.providers } : {}),
    ...(sc.control ? { control: sc.control } : {}),
  });
  cleanups.push(() => s.tools.close());
  sc.configure?.(s.ctx);
  const telemetry = withTelemetry
    ? executorTelemetry({ runId: RUN, tenantId: TENANT, tenantRootId: ROOT })
    : undefined;
  if (telemetry) s.ctx.telemetry = telemetry;
  let result!: RunResult;
  await withSpan({ name: 'invoke_workflow t', kind: 'invoke_workflow' }, {}, async () => {
    result = await executePipeline(prepared(sc.def, sc.data ?? {}), s.ctx);
  });
  return { ...s, result };
}

const simple = agentFile(`    tools:
      - { server: cve-db, tool: lookup_cve, allowAdditionalArgs: true }
    simulation:
      responses:
        - toolCalls: [{ server: cve-db, tool: lookup_cve, args: { cveId: CVE-2021-44228 } }]
        - text: done`);

describe('span shape (golden)', () => {
  it('a simple run: handover, agent, two model calls, policy check and tool call', async () => {
    const { result } = await go({ def: simple });
    expect(result.status).toBe('succeeded');
    expect(shape(t.exporter.getFinishedSpans())).toEqual([
      'invoke_workflow t (INTERNAL)',
      '  oax.handover a (INTERNAL)',
      '  invoke_agent a (INTERNAL)',
      '    chat sim-1 (CLIENT)',
      '    oax.policy.check cve-db/lookup_cve (INTERNAL)',
      '    execute_tool lookup_cve (INTERNAL)',
      '    chat sim-1 (CLIENT)',
    ]);
    const spans = t.exporter.getFinishedSpans();
    // Every span of the run carries the run and tenant identity.
    for (const s of spans.filter((x) => x.name !== 'invoke_workflow t'))
      expect(s.attributes).toMatchObject({
        'oax.run.id': RUN,
        'oax.tenant.id': TENANT,
        'oax.tenant.root_id': ROOT,
      });
    expect(
      without(one('oax.handover').attributes, 'oax.run.id', 'oax.tenant.id', 'oax.tenant.root_id'),
    ).toEqual({
      'oax.step.id': 'a',
      'oax.handover.explicit': false,
      'oax.handover.result': 'ok',
    });
    const agent = one('invoke_agent');
    expect(agent.attributes).toMatchObject({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': 'a',
      'gen_ai.agent.id': 't/a',
      'gen_ai.agent.version': '1.0.0',
      'gen_ai.request.model': 'sim-1',
      'gen_ai.provider.name': 'simulated',
      'oax.runner.kind': 'in-process',
    });
    // Step totals equal the model calls' sums.
    const chats = byName('chat');
    expect(agent.attributes['gen_ai.usage.input_tokens']).toBe(
      chats.reduce((n, c) => n + Number(c.attributes['gen_ai.usage.input_tokens']), 0),
    );
    expect(chats[0]!.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'simulated',
      'gen_ai.request.model': 'sim-1',
      'gen_ai.response.finish_reasons': ['tool_use'],
      'oax.model.via': 'in-process',
      'oax.provider.instance': 'simulated',
      'oax.reservation.result': 'none',
      'oax.usage.source': 'provider',
    });
    expect(chats[1]!.attributes['gen_ai.response.finish_reasons']).toEqual(['end_turn']);
    expect(one('oax.policy.check').attributes).toMatchObject({
      'gen_ai.tool.name': 'lookup_cve',
      'oax.mcp.server': 'cve-db',
      'oax.policy.effect': 'allow',
    });
    expect(one('execute_tool').attributes).toMatchObject({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'lookup_cve',
      'gen_ai.tool.type': 'extension',
      'oax.mcp.server': 'cve-db',
      'oax.tool.is_error': false,
      'oax.tool.truncated': false,
    });
    expect(typeof one('execute_tool').attributes['oax.tool.result_bytes']).toBe('number');
    expect(attributesComply(spans)).toEqual([]);
  });

  it('a denied tool: the policy span says deny, no approval, no tool call', async () => {
    const def = agentFile(`    tools:
      - { server: tickets, tool: get_ticket, allowAdditionalArgs: true }
    simulation:
      responses:
        - toolCalls: [{ server: tickets, tool: delete_ticket, args: { key: SEC-1 } }]
        - text: gave up`);
    const { result } = await go({ def });
    expect(result.status).toBe('succeeded');
    expect(shape(t.exporter.getFinishedSpans())).toEqual([
      'invoke_workflow t (INTERNAL)',
      '  oax.handover a (INTERNAL)',
      '  invoke_agent a (INTERNAL)',
      '    chat sim-1 (CLIENT)',
      '    oax.policy.check _unknown (INTERNAL)',
      '    chat sim-1 (CLIENT)',
    ]);
    const policy = one('oax.policy.check');
    expect(policy.attributes).toMatchObject({
      'oax.policy.effect': 'deny',
      'oax.policy.reason_codes': ['tool_not_granted'],
    });
    // The model-chosen name of a tool that was never exposed is not exported.
    expect(policy.attributes['gen_ai.tool.name']).toBeUndefined();
    expect(policy.attributes['oax.mcp.server']).toBeUndefined();
  });

  const ticketUpdater = () => loadAgentDefinition(example('ticket-updater.agents.md'));
  const jira = () => (JSON.parse(example('events/jira-issue.json')) as { data: unknown }).data;

  it.each([
    ['approved', 'succeeded', ['execute_tool update_ticket (INTERNAL)']],
    ['rejected', 'succeeded', []],
  ] as const)('an %s approval', async (outcome, status, tail) => {
    const { result } = await go({
      def: ticketUpdater(),
      data: jira(),
      control: { approve: () => outcome },
    });
    expect(result.status).toBe(status);
    const lines = shape(t.exporter.getFinishedSpans());
    expect(lines).toContain('    oax.approval.wait tickets/update_ticket (INTERNAL)');
    for (const l of tail) expect(lines).toContain(`    ${l}`);
    if (outcome === 'rejected')
      expect(lines.some((l) => l.includes('execute_tool update_ticket'))).toBe(false);
    expect(one('oax.approval.wait').attributes['oax.approval.outcome']).toBe(outcome);
    expect(
      byName('oax.policy.check').find((s) => s.name.endsWith('update_ticket'))!.attributes[
        'oax.policy.effect'
      ],
    ).toBe('require_approval');
  });

  it('a timed-out approval fails the step with its code', async () => {
    const { result } = await go({
      def: ticketUpdater(),
      data: jira(),
      control: { approve: () => 'timeout' },
    });
    expect(result).toMatchObject({ status: 'failed', error: { code: 'approval_timeout' } });
    expect(one('oax.approval.wait').attributes['oax.approval.outcome']).toBe('timeout');
    const agent = one('invoke_agent');
    expect(agent.status.code).toBe(2);
    expect(agent.attributes['error.type']).toBe('approval_timeout');
    expect(shape(t.exporter.getFinishedSpans())).toContainEqual(
      expect.stringMatching(/^ {2}invoke_agent \S+ \(INTERNAL\) !approval_timeout$/),
    );
  });

  it('a budget kill: control and budget events on the agent span, the code as error', async () => {
    const breach = {
      scope: 'use_case' as const,
      key: 'k',
      limitMicros: 1,
      spentMicros: 1,
      message: 'BUDGET-MESSAGE-CANARY',
    };
    const { result } = await go({
      def: simple,
      control: { checkBudget: async () => ({ blocked: true, breaches: [breach] }) },
    });
    expect(result.error?.code).toBe('control_budget_use_case');
    expect(shape(t.exporter.getFinishedSpans())).toEqual([
      'invoke_workflow t (INTERNAL)',
      '  oax.handover a (INTERNAL)',
      '  invoke_agent a (INTERNAL) !control_budget_use_case',
    ]);
    expect(events(one('invoke_agent')).filter((e) => e.name !== 'exception')).toEqual([
      expect.objectContaining({
        name: 'oax.budget.breach',
        'oax.budget.scopes': ['use_case'],
      }),
      expect.objectContaining({
        name: 'oax.control.decision',
        'oax.control.action': 'kill',
        'oax.control.rules': ['budget_use_case'],
      }),
    ]);
    expect(
      JSON.stringify(t.exporter.getFinishedSpans().map((s) => [s.attributes, s.events])),
    ).not.toContain('BUDGET-MESSAGE-CANARY');
  });

  it('an invalid handover with a retry: invalid and retry events, then a valid output', async () => {
    const def = loadAgentDefinition(`---
apiVersion: openagentix.io/v1alpha1
kind: AgentPipeline
name: handover
version: 1.0.0
owner: team
schemas:
  Finding:
    type: object
    required: [severity]
    additionalProperties: false
    properties:
      severity: { enum: [low, high] }
agents:
  - id: first
    provider: simulated
    model: sim-1
    instructions: Do it.
    outputs: [{ format: json }]
    output: { schema: { $ref: "#/schemas/Finding" }, onInvalid: retry }
    simulation:
      responses:
        - text: '{"severity":"WRONGVALUE"}'
        - text: '{"severity":"low"}'
---
`);
    const { result } = await go({ def });
    expect(result.status).toBe('succeeded');
    expect(shape(t.exporter.getFinishedSpans())).toEqual([
      'invoke_workflow t (INTERNAL)',
      '  oax.handover first (INTERNAL)',
      '  invoke_agent first (INTERNAL)',
      '    chat sim-1 (CLIENT)',
      '    chat sim-1 (CLIENT)',
    ]);
    const ev = events(one('invoke_agent'));
    expect(ev.map((e) => e.name)).toEqual([
      'oax.handover.invalid',
      'oax.handover.retry',
      'oax.output.valid',
    ]);
    expect(ev[0]).toMatchObject({
      'oax.validation.direction': 'output',
      'oax.validation.attempt': 1,
      'oax.validation.violations': 1,
    });
    expect(String(ev[0]!['oax.schema.digest'])).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ev[2]).toMatchObject({ 'oax.validation.attempt': 2 });
  });

  it('an invalid input fails the handover span; a skipped step has no agent span', async () => {
    const bad = loadAgentDefinition(`---
apiVersion: openagentix.io/v1alpha1
kind: AgentPipeline
name: handover
version: 1.0.0
owner: team
agents:
  - id: first
    provider: simulated
    model: sim-1
    instructions: Do it.
    input:
      schema: { type: object, required: [ticket], properties: { ticket: { type: string, maxLength: 4 } } }
    simulation:
      responses:
        - text: never
  - id: second
    provider: simulated
    model: sim-1
    instructions: Do it.
    when: "false"
    simulation:
      responses:
        - text: never
---
`);
    const { result } = await go({ def: bad, data: { ticket: 'WAY-TOO-LONG' } });
    expect(result.error?.code).toBe('handover_invalid');
    expect(shape(t.exporter.getFinishedSpans())).toEqual([
      'invoke_workflow t (INTERNAL)',
      '  oax.handover first (INTERNAL) !handover_invalid',
    ]);
    const h = one('oax.handover');
    expect(h.attributes['oax.handover.result']).toBe('invalid');
    expect(events(h).find((e) => e.name === 'oax.handover.invalid')).toMatchObject({
      'oax.validation.direction': 'input',
    });
  });
});

describe('no behaviour change', () => {
  it('runs identically with and without spans, and records nothing without a provider', async () => {
    const withSpans = await go({ def: simple });
    const plain = await go({ def: simple }, false);
    expect(withSpans.result).toEqual(plain.result);
    expect(withSpans.control.steps.map((s) => `${s.kind}:${s.name}:${s.status}`)).toEqual(
      plain.control.steps.map((s) => `${s.kind}:${s.name}:${s.status}`),
    );
  });

  it('hands out no hooks while no SDK is registered', async () => {
    await t.stop();
    expect(executorTelemetry({ runId: RUN, tenantId: TENANT })).toBeUndefined();
    t = startTracing();
    expect(executorTelemetry({ runId: RUN, tenantId: TENANT })).toBeDefined();
  });

  it('a throwing event sink cannot change the outcome (executor never depends on spans)', async () => {
    const hooks = executorTelemetry({ runId: RUN, tenantId: TENANT })!;
    const hostile = {
      span: <T>(
        spec: Parameters<typeof hooks.span>[0],
        attrs: Record<string, unknown>,
        fn: Parameters<typeof hooks.span<T>>[2],
      ) =>
        hooks.span(spec, attrs, (s) =>
          fn({
            setAttributes: s.setAttributes.bind(s),
            addEvent: () => {
              throw new Error('sink down');
            },
          }),
        ),
    };
    const breach = {
      scope: 'team' as const,
      key: 'k',
      limitMicros: 1,
      spentMicros: 1,
      message: 'm',
    };
    const { result } = await go({
      def: simple,
      control: { checkBudget: async () => ({ blocked: true, breaches: [breach] }) },
      configure: (ctx) => void (ctx.telemetry = hostile),
    });
    expect(result.error?.code).toBe('control_budget_team');
  });
});

describe('only the allowlist gets through', () => {
  it('content keys passed to a span are dropped at the adapter', async () => {
    const hooks = executorTelemetry({ runId: RUN, tenantId: TENANT })!;
    await hooks.span(
      { kind: 'execute_tool', name: 'execute_tool x' },
      {
        'gen_ai.tool.name': 'x',
        'gen_ai.tool.call.arguments': '{"k":"CANARY-ARGS"}',
        'gen_ai.tool.call.result': 'CANARY-RESULT',
        'gen_ai.input.messages': 'CANARY-PROMPT',
        'http.url': 'https://x.example/?token=CANARY-URL',
        'oax.unlisted': 'CANARY-UNLISTED',
      },
      async (s) => {
        s.setAttributes({ 'gen_ai.output.messages': 'CANARY-OUT' });
        s.addEvent('oax.custom', { message: 'CANARY-EVENT' });
      },
    );
    const [span] = t.exporter.getFinishedSpans();
    expect(Object.keys(span!.attributes).sort()).toEqual([
      'gen_ai.tool.name',
      'oax.run.id',
      'oax.tenant.id',
    ]);
    expect(JSON.stringify([span!.attributes, span!.events])).not.toContain('CANARY');
  });
});

/** Everything a span can carry out of the process, as one string. */
function exported(spans: readonly ReadableSpan[]): string {
  return JSON.stringify(
    spans.map((s) => {
      const clean = sanitizeReadableSpan(s, telemetryRuntime());
      return {
        raw: {
          name: s.name,
          attributes: s.attributes,
          events: s.events.map((e) => [e.name, e.attributes]),
          links: s.links.map((l) => [l.context, l.attributes]),
          status: s.status,
          resource: s.resource.attributes,
          scope: s.instrumentationScope,
        },
        boundary: clean,
      };
    }),
  );
}

describe('redaction canary suite', () => {
  const C = {
    event: 'CANARY-EVENT-PAYLOAD-7f3a',
    prompt: 'CANARY-PROMPT-TEXT-91bc',
    response: 'CANARY-MODEL-RESPONSE-22de',
    args: 'CANARY-TOOL-ARGS-5a10',
    result: 'CANARY-TOOL-RESULT-c8f4',
    toolError: 'CANARY-TOOL-ERROR-03aa',
    providerBody: 'CANARY-PROVIDER-BODY-e4d2',
    description: 'CANARY-MCP-DESCRIPTION-b77c',
    useCase: 'CANARY-USE-CASE-1d9e',
    connection: 'CANARY-BYOK-CONNECTION-a6f0',
    apiKey: 'CANARY-API-KEY-sk-0123456789abcdef',
    invented: 'CANARY_INVENTED_TOOL_NAME',
    comment: 'CANARY-APPROVAL-COMMENT-3b3b',
  };

  const def = loadAgentDefinition(`---
apiVersion: openagentix.io/v1alpha1
kind: AgentPipeline
name: canary
version: 1.0.0
owner: team
labels: { useCase: ${C.useCase} }
agents:
  - id: a
    provider: simulated
    model: sim-1
    instructions: ${C.prompt}
    tools:
      - { server: tickets, tool: get_ticket, allowAdditionalArgs: true }
      - { server: tickets, tool: add_comment, allowAdditionalArgs: true }
    simulation:
      responses:
        - toolCalls:
            - { server: tickets, tool: add_comment, args: { key: SEC-1, comment: ${C.args} } }
            - { server: tickets, tool: get_ticket, args: { key: ${C.result} } }
            - { server: tickets, tool: get_ticket, args: { key: SEC-ERR } }
            - { server: tickets, tool: ${C.invented}, args: { x: ${C.args} } }
        - text: ${C.response}
---
`);

  /** The connection name of a BYOK provider is the one tenant label that may appear on a span. */
  class Byok implements ModelProvider {
    readonly kind = 'openai' as const;
    readonly family = 'openrouter';
    readonly clearance = 'restricted' as const;
    readonly name = C.connection;
    private readonly inner = new SimulatedProvider({ name: C.connection });
    complete(req: ChatRequest): Promise<ChatResponse> {
      return this.inner.complete(req);
    }
  }

  it('keeps every canary out of every exported value', async () => {
    const provider = new Byok();
    const sc: Scenario = {
      def: { ...def, agents: def.agents.map((a) => ({ ...a, provider: C.connection })) },
      data: { note: C.event },
      providers: [provider],
      configure: (ctx) => {
        const exposed = ctx.tools.exposedTools.bind(ctx.tools);
        ctx.tools.exposedTools = async (agent) =>
          (await exposed(agent)).map((t) => ({ ...t, description: C.description }));
        // A failing tool call: its error text must stay out of the spans as well.
        const call = ctx.tools.call.bind(ctx.tools);
        ctx.tools.call = async (...args: Parameters<typeof call>) => {
          if (args[0].args.key === 'SEC-ERR')
            throw Object.assign(new Error(`upstream failed: ${C.toolError}`), {
              code: 'tool_failed',
            });
          return call(...args);
        };
      },
    };
    const run = await go(sc);
    expect(['succeeded', 'failed']).toContain(run.result.status);
    const spans = t.exporter.getFinishedSpans();
    // The model invented a tool name: it is not exported, the span says `_unknown`.
    expect(shape(spans)).toContain('    oax.policy.check _unknown (INTERNAL)');
    expect(spans.length).toBeGreaterThan(5);
    const out = exported(spans);
    for (const [name, canary] of Object.entries(C)) {
      if (name === 'connection') continue;
      expect(out, name).not.toContain(canary);
    }
    // Control: the pipeline really handled the canaries, so their absence above means something.
    const handled = JSON.stringify([run.control.steps, run.control.audit]);
    expect(handled).toContain(C.args);
    expect(handled).toContain(C.response);
    expect(handled).toContain(C.result);
    expect(handled).toContain(C.toolError);
    expect(shape(spans)).toContain('    execute_tool get_ticket (INTERNAL) !tool_failed');

    // The connection name is exported on the model-call and agent spans as the instance, never in a
    // span name, never under another key, and never together with the API key.
    for (const s of spans) {
      expect(s.name).not.toContain(C.connection);
      for (const [k, v] of Object.entries(s.attributes))
        if (JSON.stringify(v).includes(C.connection)) expect(k).toBe('oax.provider.instance');
      for (const e of s.events) expect(JSON.stringify(e.attributes)).not.toContain(C.connection);
    }
    expect(
      byName('chat').every((c) => c.attributes['oax.provider.instance'] === C.connection),
    ).toBe(true);
    expect(byName('chat').every((c) => c.attributes['gen_ai.provider.name'] === 'openrouter')).toBe(
      true,
    );
    expect(attributesComply(spans)).toEqual([]);
  });

  it('never exports a failure code a run node claimed', async () => {
    const isolated = agentFile(`    simulation:
      responses:
        - text: x`);
    const node = (failure: NodeStepFailure) => ({
      def: isolated,
      configure: (ctx: RunnerContext) => {
        ctx.dispatcher = {
          isolates: () => true,
          dispatch: () => Promise.reject(failure),
        };
      },
    });
    // The node is untrusted: its code reaches the run result, but the span gets a closed value.
    const claimed = await go(
      node(new NodeStepFailure('failed', 'CANARY-NODE-CODE', C.providerBody, true)),
    );
    expect(claimed.result.error?.code).toBe('CANARY-NODE-CODE');
    expect(one('invoke_agent').attributes['error.type']).toBe('run_node_failed');
    const out = exported(t.exporter.getFinishedSpans());
    expect(out).not.toContain('CANARY-NODE-CODE');
    expect(out).not.toContain(C.providerBody);
    // Also with the opt-in exception detail, the node's message stays out.
    t.exporter.reset();
    configureTelemetryRuntime({ exceptionDetail: 'guarded' });
    await go(node(new NodeStepFailure('failed', 'CANARY-NODE-CODE', C.providerBody, true)));
    expect(exported(t.exporter.getFinishedSpans())).not.toContain(C.providerBody);
    const exception = one('invoke_agent').events.find((e) => e.name === 'exception');
    expect(exception?.attributes?.['exception.message']).toBe('run_node_failed');
    resetTelemetryRuntime();
    // A failure the orchestrator decided itself keeps its platform code.
    t.exporter.reset();
    await go(node(new NodeStepFailure('failed', 'pull_request_unavailable', 'no target')));
    expect(one('invoke_agent').attributes['error.type']).toBe('pull_request_unavailable');
  });

  it('records a provider failure as its code and class only', async () => {
    const failing: ModelProvider = {
      kind: 'openai',
      family: 'azure-openai',
      clearance: 'restricted',
      name: 'simulated',
      complete: async () => {
        throw Object.assign(new Error(`upstream said ${C.providerBody} key ${C.apiKey}`), {
          code: 'ECONNRESET',
          body: C.providerBody,
        });
      },
    };
    const simpleDef = agentFile(`    simulation:
      responses:
        - text: x`);
    const { result } = await go({ def: simpleDef, providers: [failing] });
    expect(result.error?.code).toBe('provider_error');
    const chat = one('chat');
    expect(chat.status.code).toBe(2);
    expect(chat.attributes['error.type']).toBe('ECONNRESET');
    expect(chat.attributes['gen_ai.provider.name']).toBe('azure.ai.openai');
    expect(chat.events.map((e) => e.attributes)).toEqual([{ 'exception.type': 'Error' }]);
    const out = exported(t.exporter.getFinishedSpans());
    expect(out).not.toContain(C.providerBody);
    expect(out).not.toContain(C.apiKey);
  });
});
