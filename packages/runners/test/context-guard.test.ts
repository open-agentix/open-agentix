import { ContextGuard } from '@openagentix/core';
import type { ChatMessage, ChatRequest, ModelProvider } from '@openagentix/providers';
import { SimulatedProvider } from '@openagentix/providers';
import { afterEach, describe, expect, it } from 'vitest';
import { executePipeline, type StepInput } from '../src/index.js';
import { agentFile, prepared, setup } from './helpers.js';

// Example values only.
const FAKE_TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
const HIDDEN = String.fromCodePoint(0xe0049, 0xe0047); // tag characters

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

/** Wraps the simulated provider and keeps every request, i.e. exactly what the model would see. */
function recording(requests: ChatRequest[]): ModelProvider {
  const inner = new SimulatedProvider({ name: 'simulated' });
  return {
    name: inner.name,
    kind: inner.kind,
    clearance: inner.clearance,
    complete: async (req, opts) => {
      requests.push(structuredClone(req));
      return inner.complete(req, opts);
    },
  } as ModelProvider;
}

const def = agentFile(`    tools:
      - { server: tickets, tool: "*", allowAdditionalArgs: true }
    simulation:
      responses:
        - toolCalls: [{ server: tickets, tool: get_ticket, args: { key: "T-1" } }]
        - text: done`);

/** A ticket whose stored text carries a hidden character and a token (the tool result echoes it). */
const ticketStore = () =>
  new Map([
    ['T-1', { key: 'T-1', status: 'open', labels: [], comments: [`note\u200B ${FAKE_TOKEN}`] }],
  ]);

const guards = (steps: StepInput[]) => steps.filter((s) => s.name === 'input_guard');
const seen = (reqs: ChatRequest[]) => JSON.stringify(reqs.map((r) => r.messages as ChatMessage[]));

describe('executor context guard', () => {
  it('keeps hidden characters and secrets out of the model context and the recorded steps', async () => {
    const requests: ChatRequest[] = [];
    const { ctx, control, tools } = setup(def, {
      providers: [recording(requests)],
      store: ticketStore(),
    });
    cleanups.push(() => tools.close());
    const run = prepared(def, { text: `please fix${HIDDEN}\u200B this`, other: FAKE_TOKEN });
    const r = await executePipeline(run, ctx);
    expect(r.status).toBe('succeeded');

    const model = seen(requests);
    expect(model).not.toContain(FAKE_TOKEN);
    expect(model).not.toContain('\u200B');
    expect(model).not.toContain(HIDDEN);
    expect(model).toContain('[redacted:github-token]');
    expect(JSON.stringify(control.steps)).not.toContain(FAKE_TOKEN);

    const entries = guards(control.steps);
    const sources = entries.map((e) => (e.output as { source: string }).source).sort();
    expect(sources).toEqual(['input', 'tool_result']);
    const input = entries.find((e) => (e.output as { source: string }).source === 'input')!;
    expect(input.kind).toBe('control');
    expect(input.output).toMatchObject({
      invisible: { total: 3, classes: { zero_width: 1, tag: 2 } },
      secrets: { total: 0, kinds: {} },
    });
    const tool = entries.find((e) => (e.output as { source: string }).source === 'tool_result')!;
    expect(tool.output).toMatchObject({ tool: 'get_ticket', secrets: { total: 1 } });
    // counts and names only
    expect(JSON.stringify(entries)).not.toContain('ghp_');
    expect(JSON.stringify(entries)).not.toContain('please fix');
  });

  it('records no guard entry when nothing was found', async () => {
    const requests: ChatRequest[] = [];
    const clean = agentFile(`    simulation:
      responses:
        - text: done`);
    const { ctx, control, tools } = setup(clean, { providers: [recording(requests)] });
    cleanups.push(() => tools.close());
    await executePipeline(prepared(clean, { text: 'hello' }), ctx);
    expect(guards(control.steps)).toEqual([]);
  });

  it('registers extra known secrets of the run through the guard', async () => {
    const requests: ChatRequest[] = [];
    const { ctx, control, tools } = setup(def, {
      providers: [recording(requests)],
      store: ticketStore(),
    });
    cleanups.push(() => tools.close());
    ctx.guard = new ContextGuard({ knownSecrets: ['run-secret-value-42'] });
    await executePipeline(prepared(def, { note: 'the secret is run-secret-value-42' }), ctx);
    expect(seen(requests)).not.toContain('run-secret-value-42');
    expect(JSON.stringify(control.steps)).not.toContain('run-secret-value-42');
  });

  it('does nothing when the guard is switched off for diagnostics', async () => {
    const requests: ChatRequest[] = [];
    const { ctx, control, tools } = setup(def, {
      providers: [recording(requests)],
      store: ticketStore(),
    });
    cleanups.push(() => tools.close());
    ctx.guard = new ContextGuard({ stripInvisible: false, redactSecrets: false });
    const g = ctx.guard;
    // the gateway keeps its own (default, on) guard: the switch applies to the prompt only
    await executePipeline(prepared(def, { text: `a\u200B` }), ctx);
    expect(g.stripInvisible).toBe(false);
    expect(seen(requests)).toContain('\u200B');
    expect(guards(control.steps).map((e) => (e.output as { source: string }).source)).toEqual([
      'tool_result',
    ]);
  });
});
