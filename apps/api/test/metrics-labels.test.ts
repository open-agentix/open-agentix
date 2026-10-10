import { describe, expect, it } from 'vitest';
import { Metrics } from '../src/metrics.js';
import { errorTypeOf, triggerLabel } from '../src/metric-labels.js';
import { recordStepMetric } from '../src/services/step-metrics.js';
import type { StepMetric } from '../src/services/step-writer.js';

/** Tenant-chosen text of every kind: none of it may ever appear in the exposition. */
const HOSTILE = 'Acme Corp "prod" <script>{x="1"}\n7f3a';

const lines = async (m: Metrics, prefix: string): Promise<string[]> =>
  (await m.registry.metrics()).split('\n').filter((l) => l.startsWith(prefix));

const stepMetric = (over: Partial<StepMetric> = {}): StepMetric => ({
  provider: HOSTILE,
  costMicros: 1_000,
  scope: { tenantId: 't', teamId: null, agentId: 'a' },
  tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 },
  via: 'in-process',
  model: HOSTILE,
  seconds: 0.5,
  failed: false,
  ...over,
});

describe('metric label normalisation (ADR 0015 S5)', () => {
  it('labels cost with the provider family, never with the instance name', async () => {
    const m = new Metrics();
    // The resolver answers with the family of the tenant's connection.
    await recordStepMetric(m, async () => 'openai', stepMetric());
    // Without a resolver an arbitrary instance name falls back to `other`.
    await recordStepMetric(m, undefined, stepMetric());
    // A cost line without a provider is a tool line.
    await recordStepMetric(m, undefined, stepMetric({ provider: null, tokens: null }));
    const out = (await m.registry.metrics()).split('\n');
    expect(out).toContain('oax_cost_micro_usd_total{provider="openai"} 1000');
    expect(out).toContain('oax_cost_micro_usd_total{provider="other"} 1000');
    expect(out).toContain('oax_cost_micro_usd_total{provider="tool"} 1000');
    expect(out.join('\n')).not.toContain('Acme');
  });

  it('survives a failing resolver without leaking the instance name', async () => {
    const m = new Metrics();
    await recordStepMetric(
      m,
      async () => {
        throw new Error('db down');
      },
      stepMetric(),
    );
    expect((await m.registry.metrics()).includes('Acme')).toBe(false);
  });

  it('splits tokens by direction, excluding cache tokens from the input', async () => {
    const m = new Metrics();
    await recordStepMetric(m, async () => 'anthropic', stepMetric({ via: 'proxy' }));
    const out = (await lines(m, 'oax_tokens_total')).join('\n');
    expect(out).toContain('direction="input",provider="anthropic",via="proxy"} 10');
    expect(out).toContain('direction="output",provider="anthropic",via="proxy"} 5');
    expect(out).toContain('direction="cache_read",provider="anthropic",via="proxy"} 2');
    expect(out).toContain('direction="cache_write",provider="anthropic",via="proxy"} 1');
  });

  it('turns every unknown label value into the fallback of its closed set', async () => {
    const m = new Metrics();
    m.toolCall(HOSTILE, HOSTILE);
    m.approval(HOSTILE, Number.NaN);
    m.step(HOSTILE, true, -1);
    m.runFinished(HOSTILE, HOSTILE, 1, HOSTILE);
    m.controlKill([HOSTILE, 'budget_tenant', 'budget_tenant', 'classification']);
    m.guard(HOSTILE, 2, 3);
    m.nodeReport(HOSTILE, HOSTILE);
    m.eventIngested(HOSTILE, HOSTILE);
    const text = await m.registry.metrics();
    expect(text).not.toContain('Acme');
    expect(text).not.toContain('7f3a');
    expect(text).toContain('oax_budget_exhausted_total{scope="tenant",limit="usd"} 1');
    expect(text).toContain('oax_guard_replacements_total{source="input",class="secret"} 2');
    expect(text).toContain('oax_events_ingested_total{kind="other",outcome="error"} 1');
  });

  it('keeps only the trigger family of a run', () => {
    expect(triggerLabel('webhook:Acme Corp Prod Hook')).toBe('webhook');
    expect(triggerLabel('cron:0 */6 * * *')).toBe('cron');
    expect(triggerLabel('manual:3f2b8c1e')).toBe('manual');
    expect(triggerLabel('demo-scenario:visitor-1')).toBe('demo');
    expect(triggerLabel(`${HOSTILE}:x`)).toBe('other');
    expect(triggerLabel('')).toBe('other');
  });

  it('maps error codes to the closed error.type list', () => {
    expect(errorTypeOf(null)).toBe('');
    expect(errorTypeOf('control_budget_use_case')).toBe('budget');
    expect(errorTypeOf('control_timeout')).toBe('timeout');
    expect(errorTypeOf('provider_error')).toBe('provider_error');
    expect(errorTypeOf(HOSTILE)).toBe('_OTHER');
  });
});

describe('opt-in GenAI metrics', () => {
  it('registers nothing unless enabled', async () => {
    const off = new Metrics();
    await recordStepMetric(off, async () => 'openai', stepMetric());
    expect((await off.registry.metrics()).includes('gen_ai_')).toBe(false);
  });

  it('labels the model only when it is in the catalog, else _OTHER', async () => {
    const m = new Metrics('oax_', { genai: true, catalogModels: new Set(['gpt-4.1']) });
    await recordStepMetric(m, async () => 'openai', stepMetric({ model: 'gpt-4.1' }));
    await recordStepMetric(m, async () => 'openai', stepMetric({ model: 'my-finetune-of-acme' }));
    const out = (await lines(m, 'gen_ai_client_inference_usage_input_tokens_total')).join('\n');
    expect(out).toContain('gen_ai_request_model="gpt-4.1"');
    expect(out).toContain('gen_ai_request_model="_OTHER"');
    expect(out).not.toContain('acme');
    const text = await m.registry.metrics();
    expect(text).toContain('gen_ai_client_inference_duration_seconds_bucket');
    expect(text).not.toContain('Acme');
  });

  it('records agent, workflow and tool durations with closed error types', async () => {
    const m = new Metrics('oax_', { genai: true });
    m.step('in-process', false, 2, 'control_budget_cost');
    m.runFinished('failed', 'cron', 5, 'provider_error');
    m.toolExecuted(0.2, true);
    const text = await m.registry.metrics();
    expect(text).toContain(
      'gen_ai_invoke_agent_duration_seconds_count{gen_ai_operation_name="invoke_agent",error_type="budget"} 1',
    );
    expect(text).toContain(
      'gen_ai_invoke_workflow_duration_seconds_count{gen_ai_operation_name="invoke_workflow",error_type="provider_error"} 1',
    );
    expect(text).toContain(
      'gen_ai_execute_tool_duration_seconds_count{gen_ai_operation_name="execute_tool",error_type="tool_error"} 1',
    );
  });
});
