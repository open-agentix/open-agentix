import { describe, expect, it } from 'vitest';
import {
  ControlAgent,
  DEFAULT_CONTROL_LIMITS,
  limitsFromBudget,
  newRunMetrics,
  recordModelCall,
  recordPolicyDenial,
  recordStepResult,
  recordToolCall,
  stricter,
  type ControlReviewer,
} from '../src/index.js';

const T0 = 1_000_000;

describe('limitsFromBudget', () => {
  it('maps budgets and keeps defaults', () => {
    const l = limitsFromBudget(
      { maxTokens: 10, maxCostUsd: 0.25, maxSteps: 3, maxToolCalls: 2, timeoutSeconds: 5 },
      { maxToolCallsPerMinute: 7 },
    );
    expect(l).toMatchObject({
      maxTokens: 10,
      maxCostMicros: 250_000,
      maxSteps: 3,
      maxToolCalls: 2,
      timeoutMs: 5000,
      maxToolCallsPerMinute: 7,
      maxIdenticalToolCalls: DEFAULT_CONTROL_LIMITS.maxIdenticalToolCalls,
    });
    expect(limitsFromBudget({}).maxTokens).toBeUndefined();
  });
});

describe('ControlAgent.evaluate', () => {
  it('continues within limits', () => {
    const agent = new ControlAgent(limitsFromBudget({ maxTokens: 100 }));
    const m = newRunMetrics(T0);
    recordModelCall(m, 50, 10);
    expect(agent.evaluate(m, T0 + 1)).toEqual({ action: 'continue', reasons: [] });
  });

  it('kills on every exceeded budget', () => {
    const agent = new ControlAgent(
      limitsFromBudget({
        maxTokens: 10,
        maxCostUsd: 0.000001,
        maxSteps: 1,
        maxToolCalls: 0 + 1,
        timeoutSeconds: 1,
      }),
    );
    const m = newRunMetrics(T0);
    recordModelCall(m, 11, 2);
    recordToolCall(m, { server: 's', tool: 't', args: { a: 1 } }, T0);
    recordToolCall(m, { server: 's', tool: 't', args: { a: 2 } }, T0);
    const d = agent.evaluate(m, T0 + 2000);
    expect(d.action).toBe('kill');
    expect(d.reasons.map((r) => r.rule)).toEqual([
      'budget_tokens',
      'budget_cost',
      'budget_steps',
      'budget_tool_calls',
      'timeout',
    ]);
  });

  it('detects loops, error streaks, denials and forbidden actions', () => {
    const agent = new ControlAgent(DEFAULT_CONTROL_LIMITS);
    const m = newRunMetrics(T0);
    for (let i = 0; i < 3; i++)
      recordToolCall(m, { server: 's', tool: 't', args: { same: true } }, T0 + i);
    for (let i = 0; i < 3; i++) recordStepResult(m, false);
    for (let i = 0; i < 3; i++) recordPolicyDenial(m, i === 0);
    const rules = agent.evaluate(m, T0 + 10).reasons.map((r) => r.rule);
    expect(rules).toEqual(['loop', 'error_streak', 'policy_denials', 'forbidden_action']);
    recordStepResult(m, true);
    expect(m.consecutiveErrors).toBe(0);
  });

  it('pauses when the tool call rate is too high', () => {
    const agent = new ControlAgent({ ...DEFAULT_CONTROL_LIMITS, maxToolCallsPerMinute: 2 });
    const m = newRunMetrics(T0);
    recordToolCall(m, { server: 's', tool: 't', args: { i: 1 } }, T0);
    recordToolCall(m, { server: 's', tool: 't', args: { i: 2 } }, T0 + 10_000);
    const d = agent.evaluate(m, T0 + 20_000);
    expect(d.action).toBe('pause');
    expect(d.resumeAfterMs).toBe(40_000);
    expect(agent.evaluate(m, T0 + 61_000).action).toBe('continue');
  });

  it('checks data flow to providers', () => {
    const agent = new ControlAgent(DEFAULT_CONTROL_LIMITS);
    expect(agent.checkDataFlow('internal', 'confidential').action).toBe('continue');
    expect(agent.checkDataFlow('restricted', 'internal').reasons[0]?.rule).toBe('classification');
  });
});

describe('ControlAgent.check with reviewer', () => {
  const m = newRunMetrics(T0);
  it('uses the reviewer only to tighten', async () => {
    const strict: ControlReviewer = { review: async () => ({ action: 'kill', reasons: [] }) };
    const lax: ControlReviewer = { review: async () => ({ action: 'continue', reasons: [] }) };
    const tightened = await new ControlAgent(DEFAULT_CONTROL_LIMITS, strict).check(m, T0);
    expect(tightened.action).toBe('kill');
    expect(tightened.reasons[0]?.rule).toBe('reviewer');
    const kept = await new ControlAgent(DEFAULT_CONTROL_LIMITS, lax).check(m, T0);
    expect(kept.action).toBe('continue');
    const noReviewer = await new ControlAgent(DEFAULT_CONTROL_LIMITS).check(m, T0);
    expect(noReviewer.action).toBe('continue');
  });

  it('keeps reviewer reasons and skips the reviewer after a kill', async () => {
    const pause: ControlReviewer = {
      review: async () => ({
        action: 'pause',
        reasons: [{ rule: 'reviewer', message: 'odd output' }],
        resumeAfterMs: 5,
      }),
    };
    const d = await new ControlAgent(DEFAULT_CONTROL_LIMITS, pause).check(m, T0);
    expect(d).toEqual({
      action: 'pause',
      reasons: [{ rule: 'reviewer', message: 'odd output' }],
      resumeAfterMs: 5,
    });
    const killed = newRunMetrics(T0);
    recordPolicyDenial(killed, true);
    let called = false;
    const spy: ControlReviewer = {
      review: async (_m, dec) => {
        called = true;
        return dec;
      },
    };
    expect((await new ControlAgent(DEFAULT_CONTROL_LIMITS, spy).check(killed, T0)).action).toBe(
      'kill',
    );
    expect(called).toBe(false);
  });
});

describe('stricter', () => {
  it('picks the stricter action and merges reasons', () => {
    const a = {
      action: 'pause' as const,
      reasons: [{ rule: 'rate' as const, message: 'a' }],
      resumeAfterMs: 3,
    };
    const b = { action: 'continue' as const, reasons: [] };
    expect(stricter(a, b)).toEqual({ action: 'pause', reasons: a.reasons, resumeAfterMs: 3 });
    expect(stricter(b, { action: 'kill', reasons: [] }).action).toBe('kill');
  });
});
