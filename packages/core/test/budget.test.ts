import { describe, expect, it } from 'vitest';
import {
  ControlAgent,
  DEFAULT_CONTROL_LIMITS,
  crossedThresholds,
  DEFAULT_DEV_BUDGET_SHARE,
  describeBudget,
  developmentBudget,
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

describe('development budget (ADR 0017 decision 9)', () => {
  const DEFAULT = 10_000_000;

  it('is 10 % of the monthly cap of the node until an administrator sets one', () => {
    expect(DEFAULT_DEV_BUDGET_SHARE).toBe(0.1);
    expect(developmentBudget(null, 100_000_000, DEFAULT)).toEqual({
      limitMicros: 10_000_000,
      source: 'default',
    });
  });

  it('prefers the explicit budget but never lets it exceed the cap', () => {
    expect(developmentBudget(2_000_000, 100_000_000, DEFAULT)).toEqual({
      limitMicros: 2_000_000,
      source: 'explicit',
    });
    expect(developmentBudget(0, 100_000_000, DEFAULT).limitMicros).toBe(0);
    expect(developmentBudget(500_000_000, 100_000_000, DEFAULT)).toEqual({
      limitMicros: 100_000_000,
      source: 'explicit',
    });
  });

  it('uses the platform default for a node without a cap and without an explicit budget', () => {
    expect(developmentBudget(null, null, DEFAULT)).toEqual({
      limitMicros: DEFAULT,
      source: 'platform',
    });
    expect(developmentBudget(7, null, DEFAULT)).toEqual({ limitMicros: 7, source: 'explicit' });
  });

  it('rounds the default down and stops at the limit like every other budget', () => {
    expect(developmentBudget(null, 15, DEFAULT).limitMicros).toBe(1);
    const v = evaluateBudgets([
      { scope: 'development', key: 'acme', limitMicros: 1_000_000, spentMicros: 1_000_000 },
    ]);
    expect(v.blocked).toBe(true);
    expect(v.breaches[0]?.message).toBe(
      'development "acme" reached its monthly budget (1.00 of 1.00 USD)',
    );
  });
});
