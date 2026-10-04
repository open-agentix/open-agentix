import { describe, expect, it } from 'vitest';
import {
  ControlAgent,
  DEFAULT_CONTROL_LIMITS,
  crossedThresholds,
  describeBudget,
  evaluateBudgets,
  newRunMetrics,
  percentUsed,
  recordBudgetBreaches,
} from '../src/index.js';

const usage = (spentMicros: number, limitMicros = 10_000_000) => ({
  scope: 'use_case' as const,
  key: 'triage',
  limitMicros,
  spentMicros,
});

describe('budgets', () => {
  it('stays open below the limit and stops at the limit', () => {
    expect(evaluateBudgets([usage(9_999_999)])).toEqual({ blocked: false, breaches: [] });
    const v = evaluateBudgets([usage(10_000_000)]);
    expect(v.blocked).toBe(true);
    expect(v.breaches[0]?.message).toBe(
      'use case "triage" reached its monthly budget (10.00 of 10.00 USD)',
    );
  });

  it('reports every breached scope and treats a zero limit as "nothing may be spent"', () => {
    const v = evaluateBudgets([
      { scope: 'tenant', key: 'acme', limitMicros: 5, spentMicros: 5 },
      usage(1),
      { scope: 'team', key: 'platform', limitMicros: 0, spentMicros: 0 },
    ]);
    expect(v.breaches.map((b) => b.scope)).toEqual(['tenant', 'team']);
    expect(describeBudget('use_case')).toBe('use case');
    expect(describeBudget('tenant')).toBe('tenant');
  });

  it('computes the used percentage', () => {
    expect(percentUsed(usage(2_500_000))).toBe(25);
    expect(percentUsed(usage(1, 0))).toBe(0);
  });

  it('finds thresholds crossed by a spend increase, each only once', () => {
    const limit = 100;
    expect(crossedThresholds(limit, 0, 49)).toEqual([]);
    expect(crossedThresholds(limit, 49, 50)).toEqual([50]);
    expect(crossedThresholds(limit, 50, 79)).toEqual([]);
    expect(crossedThresholds(limit, 10, 85)).toEqual([50, 80]);
    expect(crossedThresholds(limit, 79, 130)).toEqual([80, 100]);
    expect(crossedThresholds(limit, 100, 120)).toEqual([]);
    expect(crossedThresholds(0, 0, 10)).toEqual([]);
  });

  it('lets the control agent kill a run mid-run when a budget was reported as reached', () => {
    const agent = new ControlAgent(DEFAULT_CONTROL_LIMITS);
    const m = newRunMetrics(0);
    expect(agent.evaluate(m, 1).action).toBe('continue');
    recordBudgetBreaches(m, evaluateBudgets([usage(10_000_000)]).breaches);
    const d = agent.evaluate(m, 1);
    expect(d.action).toBe('kill');
    expect(d.reasons[0]?.rule).toBe('budget_use_case');
    recordBudgetBreaches(m, []);
    expect(agent.evaluate(m, 1).action).toBe('continue');
  });
});
