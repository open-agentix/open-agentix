import { OaxError, loadAgentDefinition, type AgentDefinition } from '@openagentix/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NodeStepFailure,
  executePipeline,
  type StepDispatchRequest,
  type StepDispatchResult,
  type StepDispatcher,
  type StepInput,
} from '../src/index.js';
import { prepared, setup } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

const def = (): AgentDefinition =>
  loadAgentDefinition(`---
apiVersion: openagentix.io/v1alpha1
kind: AgentPipeline
name: isolated
version: 1.0.0
owner: team
budget: { maxCostUsd: 1 }
schemas:
  Finding: { type: object, required: [severity], properties: { severity: { enum: [low, high] } } }
agents:
  - id: research
    provider: simulated
    model: sim-1
    instructions: Research.
    outputs: [{ format: json }]
    output: { schema: { $ref: "#/schemas/Finding" } }
    simulation:
      responses:
        - text: '{"severity":"high"}'
  - id: action
    provider: simulated
    model: sim-1
    instructions: Act.
    runtime: { runner: container }
    input: { from: [research] }
    outputs: [{ format: json }]
    output: { schema: { $ref: "#/schemas/Finding" } }
---
`);

const usage = { tokensIn: 5, tokensOut: 7, costMicros: 11, steps: 2, toolCalls: 1 };

function run(dispatcher: StepDispatcher | undefined) {
  const d = def();
  const recorded: StepInput[] = [];
  const s = setup(d, { control: { onStep: (_r, st) => void recorded.push(st) } });
  cleanups.push(() => s.tools.close());
  return {
    recorded,
    exec: () => executePipeline(prepared(d), { ...s.ctx, ...(dispatcher ? { dispatcher } : {}) }),
  };
}

function dispatcher(
  handler: (req: StepDispatchRequest) => Promise<StepDispatchResult>,
  isolated = ['action'],
) {
  const seen: StepDispatchRequest[] = [];
  const d: StepDispatcher = {
    isolates: (a) => isolated.includes(a.id),
    dispatch: async (req) => (seen.push(req), handler(req)),
  };
  return { d, seen };
}

const ok = (content = '{"severity":"low"}'): StepDispatchResult => ({
  output: { agentId: 'action', format: 'json', content },
  usage,
});

describe('dispatchStep seam', () => {
  it('runs inline when no dispatcher is configured (unchanged behaviour)', async () => {
    const r = await run(undefined).exec();
    // the second step has no simulation script: it still runs inline and reaches its own end
    expect(r.outputs[0]?.agentId).toBe('research');
  });
  it('hands isolated steps to the dispatcher with input, resolved schema and no inline run', async () => {
    const { d, seen } = dispatcher(async () => ok());
    const h = run(d);
    const r = await h.exec();
    expect(r.status).toBe('succeeded');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.agent.id).toBe('action');
    // minimal handover: only what `input.from` selected, as the parsed output of "research"
    expect(seen[0]!.input).toEqual({ research: { severity: 'high' } });
    // named schemas are inlined for the node, which does not know them
    expect(seen[0]!.outputSchema).toMatchObject({ type: 'object', required: ['severity'] });
    expect(JSON.stringify(seen[0]!.outputSchema)).not.toContain('$ref');
    expect(r.outputs.map((o) => o.agentId)).toEqual(['research', 'action']);
    // usage of the node is added to the run's usage
    expect(r.usage.costMicros).toBeGreaterThanOrEqual(11);
    expect(r.usage.toolCalls).toBe(1);
    expect(r.usage.tokensIn).toBeGreaterThanOrEqual(5);
    // the orchestrator does not record a model call or output step for the isolated step
    expect(h.recorded.filter((s) => s.agentId === 'action')).toEqual([]);
  });
  it('validates the node result against the output schema again (authoritative)', async () => {
    const { d } = dispatcher(async () => ok('{"severity":"catastrophic"}'));
    const h = run(d);
    const r = await h.exec();
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('handover_invalid');
    expect(h.recorded.some((s) => s.kind === 'handover' && s.agentId === 'action')).toBe(true);
    const { d: d2 } = dispatcher(async () => ok('not json at all'));
    expect((await run(d2).exec()).error?.code).toBe('handover_invalid');
  });
  it('carries a node failure over with its status and code', async () => {
    for (const status of ['failed', 'blocked_by_policy', 'cancelled'] as const) {
      const { d } = dispatcher(async () => {
        throw new NodeStepFailure(status, 'some_code', 'because');
      });
      const r = await run(d).exec();
      expect(r.status).toBe(status);
      expect(r.error).toEqual({ code: 'some_code', message: 'because' });
    }
  });
  it('maps a cancellation of the dispatcher to a cancelled run', async () => {
    const { d } = dispatcher(async () => {
      throw new OaxError('cancelled', 'x');
    });
    const r = await run(d).exec();
    expect(r.status).toBe('cancelled');
    expect(r.error?.code).toBe('cancelled');
  });
  it('fails the run closed on any other dispatcher error', async () => {
    const { d } = dispatcher(async () => {
      throw new OaxError('runner_unavailable', 'no container runner');
    });
    const h = run(d);
    const r = await h.exec();
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('runner_unavailable');
    expect(r.outputs.map((o) => o.agentId)).toEqual(['research']);
    expect(h.recorded.some((s) => s.kind === 'error')).toBe(true);
  });
  it('checks cancellation before it dispatches', async () => {
    const d = def();
    let cancel = () => {};
    const s = setup(d, {
      control: {
        onStep: (_r, st) => {
          if (st.kind === 'output' && st.agentId === 'research') cancel();
        },
      },
    });
    cancel = () => s.control.cancel('run-1');
    cleanups.push(() => s.tools.close());
    const { d: disp, seen } = dispatcher(async () => ok());
    const r = await executePipeline(prepared(d), { ...s.ctx, dispatcher: disp });
    expect(r.status).toBe('cancelled');
    expect(seen).toHaveLength(0);
  });
});
