import { loadAgentDefinition, verifyAuditChain, type AgentDefinition } from '@openagentix/core';
import {
  SimulatedProvider,
  type ChatRequest,
  type ChatResponse,
  type CompleteOptions,
  type ModelProvider,
} from '@openagentix/providers';
import { afterEach, describe, expect, it } from 'vitest';
import { executePipeline, type StepInput } from '../src/index.js';
import { example, prepared, setup } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

/** Simulated provider that remembers every request (prompts) per agent model name. */
class Recording implements ModelProvider {
  readonly requests: ChatRequest[] = [];
  private readonly inner = new SimulatedProvider({ name: 'simulated' });
  readonly kind = this.inner.kind;
  readonly family = this.inner.family;
  readonly catalogProvider = this.inner.catalogProvider;
  readonly name = 'simulated';
  readonly clearance = this.inner.clearance;
  complete(req: ChatRequest, opts?: CompleteOptions): Promise<ChatResponse> {
    this.requests.push({ ...req, messages: [...req.messages] });
    return this.inner.complete(req, opts);
  }
}

function build(agents: string, extra = ''): AgentDefinition {
  return loadAgentDefinition(`---
apiVersion: openagentix.io/v1alpha1
kind: AgentPipeline
name: handover
version: 1.0.0
owner: team
${extra}
agents:
${agents.replaceAll('    model: sim-1\n', '    model: sim-1\n    instructions: Do it.\n')}
---
`);
}

function run(def: AgentDefinition, data: unknown = { ticket: 'SEC-1' }) {
  const provider = new Recording();
  const s = setup(def, { providers: [provider] });
  cleanups.push(() => s.tools.close());
  return {
    ...s,
    provider,
    go: () => executePipeline(prepared(def, data), s.ctx),
  };
}

const kinds = (steps: StepInput[]) => steps.map((s) => `${s.kind}:${s.name}:${s.status}`);
const actions = (audit: { action: string }[]) => audit.map((a) => a.action);

const FINDING = `
schemas:
  Finding:
    type: object
    required: [severity]
    additionalProperties: false
    properties:
      severity: { enum: [low, high] }
`;

const json = (s: string) => `'${s}'`;

describe('output validation', () => {
  const two = (first: string, onInvalid = 'fail') => `  - id: first
    provider: simulated
    model: sim-1
    outputs: [{ format: json }]
    output: { schema: { $ref: "#/schemas/Finding" }, onInvalid: ${onInvalid} }
    simulation:
      responses:
${first}
  - id: second
    provider: simulated
    model: sim-1
    input: { from: [first] }
    simulation:
      responses:
        - text: second ran`;

  it('hands a valid output over and records the validated value', async () => {
    const def = build(two(`        - text: ${json('{"severity":"high"}')}`), FINDING);
    const t = run(def);
    const r = await t.go();
    expect(r.status).toBe('succeeded');
    expect(r.outputs.map((o) => o.agentId)).toEqual(['first', 'second']);
    expect(kinds(t.control.steps)).not.toContain('handover:output:error');
  });

  it('fails the run with handover_invalid, records a step and an audit entry without the value', async () => {
    const def = build(
      two(`        - text: ${json('{"severity":"TOPSECRET","extra":1}')}`),
      FINDING,
    );
    const t = run(def);
    const r = await t.go();
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('handover_invalid');
    expect(r.outputs).toHaveLength(0);
    expect(t.provider.requests).toHaveLength(1); // the next step never ran
    const bad = t.control.steps.find((s) => s.kind === 'handover');
    expect(bad).toMatchObject({ name: 'output', status: 'error', agentId: 'first' });
    const audit = t.control.audit.find((a) => a.action === 'handover.invalid');
    expect(audit?.payload).toMatchObject({
      agentId: 'first',
      direction: 'output',
      attempt: 1,
    });
    const text = JSON.stringify([bad, audit]);
    expect(text).not.toContain('TOPSECRET');
    expect((audit?.payload as { errors: unknown[] }).errors.length).toBeGreaterThan(0);
    expect(verifyAuditChain(t.control.audit).valid).toBe(true);
  });

  it('treats non-JSON text as a violation', async () => {
    const def = build(two('        - text: not json at all'), FINDING);
    const r = await run(def).go();
    expect(r.error?.code).toBe('handover_invalid');
  });

  it('retries exactly once with the validation errors and then continues', async () => {
    const def = build(
      two(
        `        - text: ${json('{"severity":"WRONGVALUE"}')}\n        - text: ${json('{"severity":"low"}')}`,
        'retry',
      ),
      FINDING,
    );
    const t = run(def);
    const r = await t.go();
    expect(r.status).toBe('succeeded');
    expect(actions(t.control.audit)).toEqual(
      expect.arrayContaining(['step.model_call', 'handover.invalid', 'handover.retry']),
    );
    expect(kinds(t.control.steps).filter((k) => k.startsWith('handover'))).toEqual([
      'handover:output:error',
      'handover:retry:pending',
    ]);
    const retryPrompt = t.provider.requests[1]!.messages.at(-1)!.content;
    expect(retryPrompt).toContain('/severity');
    expect(retryPrompt).toContain('enum');
    expect(retryPrompt).not.toContain('WRONGVALUE');
    expect(t.provider.requests).toHaveLength(3); // first, retry, second
  });

  it('fails when the retry is invalid too, with two violations recorded', async () => {
    const def = build(
      two(
        `        - text: ${json('{"severity":"a"}')}\n        - text: ${json('{"severity":"b"}')}`,
        'retry',
      ),
      FINDING,
    );
    const t = run(def);
    const r = await t.go();
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('handover_invalid');
    expect(
      t.control.audit
        .filter((a) => a.action === 'handover.invalid')
        .map((a) => (a.payload as { attempt: number }).attempt),
    ).toEqual([1, 2]);
    expect(t.provider.requests).toHaveLength(2);
  });

  it('keeps the legacy behaviour for outputs without output.schema', async () => {
    const def = build(`  - id: only
    provider: simulated
    model: sim-1
    outputs: [{ format: json }]
    simulation:
      responses:
        - text: 'not json but fine'`);
    const r = await run(def).go();
    expect(r.status).toBe('succeeded');
    expect(r.outputs[0]?.json).toBeUndefined();
  });
});

describe('input handover', () => {
  const agents = `  - id: first
    provider: simulated
    model: sim-1
    input:
      schema: { type: object, required: [ticket], properties: { ticket: { type: string, maxLength: 8 } } }
    outputs: [{ format: json }]
    simulation:
      responses:
        - text: ${json('{"a":1,"private":"PREV-TEXT-MARKER"}')}
  - id: second
    provider: simulated
    model: sim-1
    input: { from: [event, first] }
    simulation:
      responses:
        - text: ok
  - id: third
    provider: simulated
    model: sim-1
    input: { from: [first] }
    simulation:
      responses:
        - text: ok`;

  it('validates event data for the first step and fails with handover_invalid', async () => {
    const t = run(build(agents), { ticket: 'WAY-TOO-LONG-VALUE' });
    const r = await t.go();
    expect(r.error?.code).toBe('handover_invalid');
    expect(t.provider.requests).toHaveLength(0);
    const a = t.control.audit.find((x) => x.action === 'handover.invalid');
    expect(a?.payload).toMatchObject({ direction: 'input', agentId: 'first' });
    expect(JSON.stringify(t.control.audit)).not.toContain('WAY-TOO-LONG-VALUE');
  });

  it('refuses event data with an own __proto__ key when a schema is declared', async () => {
    const evil = JSON.parse('{"ticket":"SEC-1","__proto__":{"polluted":true}}') as unknown;
    const r = await run(build(agents), evil).go();
    expect(r.error?.code).toBe('handover_invalid');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('gives a step with input.from only the selected JSON, not the previous text', async () => {
    const t = run(build(agents));
    const r = await t.go();
    expect(r.status).toBe('succeeded');
    const second = t.provider.requests[1]!.messages[0]!.content;
    expect(second).toContain('"event"');
    expect(second).toContain('"ticket": "SEC-1"');
    expect(second).toContain('"first"');
    expect(second).not.toContain('previous agent');
    const third = JSON.parse(
      /```json\n([\s\S]*)\n```/.exec(t.provider.requests[2]!.messages[0]!.content)![1]!,
    ) as Record<string, unknown>;
    expect(Object.keys(third)).toEqual(['first']);
    expect(t.provider.requests[2]!.messages[0]!.content).not.toContain('SEC-1');
  });

  it('keeps the legacy prompt for steps without input.from', async () => {
    const def = build(`  - id: a
    provider: simulated
    model: sim-1
    outputs: [{ format: json }]
    simulation: { responses: [{ text: '{"x":1}' }] }
  - id: b
    provider: simulated
    model: sim-1
    simulation: { responses: [{ text: ok }] }`);
    const t = run(def);
    await t.go();
    expect(t.provider.requests[1]!.messages[0]!.content).toContain(
      'Output of the previous agent "a"',
    );
    expect(t.provider.requests[1]!.messages[0]!.content).toContain('"ticket": "SEC-1"');
  });

  it('validates the previous output as input of a later step without from', async () => {
    const def = build(`  - id: a
    provider: simulated
    model: sim-1
    outputs: [{ format: json }]
    simulation: { responses: [{ text: '{"x":"str"}' }] }
  - id: b
    provider: simulated
    model: sim-1
    input: { schema: { type: object, properties: { x: { type: number } } } }
    simulation: { responses: [{ text: ok }] }`);
    const t = run(def);
    const r = await t.go();
    expect(r.error?.code).toBe('handover_invalid');
    expect(t.provider.requests).toHaveLength(1);
  });
});

describe('when', () => {
  const pipeline = (when: string) => `  - id: research
    provider: simulated
    model: sim-1
    outputs: [{ format: json }]
    output: { schema: { $ref: "#/schemas/Finding" } }
    simulation: { responses: [{ text: ${json('{"severity":"low"}')} }] }
  - id: action
    provider: simulated
    model: sim-1
    when: ${json(when)}
    input: { from: [research] }
    simulation: { responses: [{ text: acted }] }
  - id: report
    provider: simulated
    model: sim-1
    simulation: { responses: [{ text: reported }] }`;

  it('runs the step when the condition holds', async () => {
    const t = run(build(pipeline('steps.research.output.severity == "low"'), FINDING));
    const r = await t.go();
    expect(r.outputs.map((o) => o.agentId)).toEqual(['research', 'action', 'report']);
    expect(kinds(t.control.steps).some((k) => k.startsWith('condition'))).toBe(false);
  });

  it('skips the step, records a skipped condition step and an audit entry, and goes on', async () => {
    const t = run(build(pipeline('steps.research.output.severity == "high"'), FINDING));
    const r = await t.go();
    expect(r.status).toBe('succeeded');
    expect(r.outputs.map((o) => o.agentId)).toEqual(['research', 'report']);
    expect(t.provider.requests).toHaveLength(2);
    expect(kinds(t.control.steps)).toContain('condition:when:skipped');
    expect(t.control.audit.find((a) => a.action === 'step.skipped')?.payload).toEqual({
      agentId: 'action',
      when: 'steps.research.output.severity == "high"',
    });
    // the later legacy step sees the previous step that actually ran
    expect(t.provider.requests[1]!.messages[0]!.content).toContain('previous agent "research"');
  });

  it('fails the run with condition_error on an evaluation error (never a silent skip)', async () => {
    const t = run(build(pipeline('steps.research.output.missing == "x"'), FINDING));
    const r = await t.go();
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('condition_error');
    expect(t.provider.requests).toHaveLength(1);
    expect(kinds(t.control.steps)).toContain('condition:when:error');
    expect(t.control.audit.find((a) => a.action === 'condition.error')?.payload).toMatchObject({
      agentId: 'action',
      reason: expect.stringContaining('does not exist') as string,
    });
    expect(r.outputs.map((o) => o.agentId)).toEqual(['research']);
  });

  it('fails closed when the stored condition no longer parses', async () => {
    const def = build(pipeline('steps.research.output.severity == "low"'), FINDING);
    def.agents.find((a) => a.id === 'action')!.when = 'eval("1")';
    const r = await run(def).go();
    expect(r.error?.code).toBe('condition_error');
  });

  it('fails a type mismatch instead of treating it as false', async () => {
    const r = await run(build(pipeline('steps.research.output.severity > 3'), FINDING)).go();
    expect(r.error?.code).toBe('condition_error');
  });

  it('evaluates over the event too and can skip the first step', async () => {
    const def = build(`  - id: only
    provider: simulated
    model: sim-1
    when: 'event.data.ticket == "OTHER"'
    simulation: { responses: [{ text: x }] }`);
    const t = run(def);
    const r = await t.go();
    expect(r.status).toBe('succeeded');
    expect(r.outputs).toEqual([]);
    expect(t.provider.requests).toHaveLength(0);
  });

  it('fails with handover_missing when input.from names a skipped step', async () => {
    const def = build(`  - id: gate
    provider: simulated
    model: sim-1
    when: 'event.data.ticket == "OTHER"'
    outputs: [{ format: json }]
    simulation: { responses: [{ text: '{}' }] }
  - id: after
    provider: simulated
    model: sim-1
    input: { from: [gate] }
    simulation: { responses: [{ text: x }] }`);
    const t = run(def);
    const r = await t.go();
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('handover_missing');
    expect(t.provider.requests).toHaveLength(0);
    expect(t.control.audit.find((a) => a.action === 'handover.invalid')?.payload).toMatchObject({
      direction: 'input',
      agentId: 'after',
    });
  });

  it('supports exists() to guard a possibly skipped step', async () => {
    const def = build(`  - id: gate
    provider: simulated
    model: sim-1
    when: 'event.data.ticket == "OTHER"'
    simulation: { responses: [{ text: x }] }
  - id: after
    provider: simulated
    model: sim-1
    when: '!exists(steps.gate.output)'
    simulation: { responses: [{ text: y }] }`);
    const r = await run(def).go();
    expect(r.outputs.map((o) => o.agentId)).toEqual(['after']);
  });
});

describe('ticket-triage example', () => {
  const source = example('ticket-triage.agents.md');
  const event = (cve: string) => ({
    image: 'ghcr.io/acme/api:1.4.2',
    scanner: 'trivy',
    finding: { cveId: cve, package: 'xz-utils', installed: '5.6.0' },
    ticket: 'SEC-42',
  });

  it('runs end to end: research -> analysis -> action comments on the ticket', async () => {
    const def = loadAgentDefinition(source);
    const t = run(def, event('CVE-2024-3094'));
    const r = await t.go();
    expect(r.error).toBeUndefined();
    expect(r.status).toBe('succeeded');
    expect(r.outputs.map((o) => o.agentId)).toEqual(['research', 'analysis', 'action']);
    expect(r.outputs[1]?.json).toMatchObject({ severity: 'CRITICAL', action: 'comment' });
    expect(t.store.size).toBeGreaterThanOrEqual(0);
    expect(kinds(t.control.steps)).toContain('tool_call:tickets/add_comment:ok');
    expect(verifyAuditChain(t.control.audit).valid).toBe(true);
  });

  it('skips the action step when the condition is false and still succeeds', async () => {
    const def = loadAgentDefinition(source.replace('["HIGH", "CRITICAL"]', '["CRITICAL"]'));
    const t = run(def, event('CVE-2023-44487'));
    const r = await t.go();
    expect(r.status).toBe('succeeded');
    expect(r.outputs.map((o) => o.agentId)).toEqual(['research', 'analysis']);
    expect(kinds(t.control.steps)).toContain('condition:when:skipped');
    expect(kinds(t.control.steps)).not.toContain('tool_call:tickets/add_comment:ok');
  });

  it('fails the first step on invalid event data', async () => {
    const t = run(loadAgentDefinition(source), { finding: { cveId: 'CVE-2024-3094' } });
    const r = await t.go();
    expect(r.error?.code).toBe('handover_invalid');
  });
});
