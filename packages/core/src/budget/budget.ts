/**
 * Spending budgets per scope and calendar month (UTC). Pure functions only: the control node
 * feeds them the limits and the spend from the cost ledger.
 *
 * Amounts are integer micro-USD like everywhere else in the cost model.
 */

export const BUDGET_SCOPES = ['tenant', 'use_case', 'team'] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

/** Alert thresholds in percent of the monthly limit. 100 means "limit reached, hard stop". */
export const ALERT_THRESHOLDS = [50, 80, 100] as const;
export type AlertThreshold = (typeof ALERT_THRESHOLDS)[number];

/** One budget with what has been spent against it in the current month. */
export interface BudgetUsage {
  scope: BudgetScope;
  /** Use case label, team slug or tenant slug (for messages and audit payloads). */
  key: string;
  limitMicros: number;
  spentMicros: number;
}

export interface BudgetBreach extends BudgetUsage {
  message: string;
}

export interface BudgetVerdict {
  blocked: boolean;
  breaches: BudgetBreach[];
}

const usd = (micros: number) => (micros / 1_000_000).toFixed(2);

/** Percent of the limit that is used (0 for a missing or zero limit). */
export function percentUsed(u: Pick<BudgetUsage, 'limitMicros' | 'spentMicros'>): number {
  return u.limitMicros > 0 ? (u.spentMicros / u.limitMicros) * 100 : 0;
}

export function describeBudget(scope: BudgetScope): string {
  return scope === 'use_case' ? 'use case' : scope;
}

/**
 * Hard stop: a budget is breached as soon as the spend reaches the limit (`>=`), so a limit of
 * 0 blocks everything. Budgets without a limit are not passed in.
 */
export function evaluateBudgets(usages: readonly BudgetUsage[]): BudgetVerdict {
  const breaches: BudgetBreach[] = usages
    .filter((u) => u.spentMicros >= u.limitMicros)
    .map((u) => ({
      ...u,
      message: `${describeBudget(u.scope)} "${u.key}" reached its monthly budget (${usd(u.spentMicros)} of ${usd(u.limitMicros)} USD)`,
    }));
  return { blocked: breaches.length > 0, breaches };
}

/**
 * Thresholds that a spend increase from `before` to `after` crossed for the first time.
 * A threshold counts as crossed when the spend is at or above `limit * threshold / 100`.
 */
export function crossedThresholds(
  limitMicros: number,
  beforeMicros: number,
  afterMicros: number,
  thresholds: readonly AlertThreshold[] = ALERT_THRESHOLDS,
): AlertThreshold[] {
  if (limitMicros <= 0) return [];
  return thresholds.filter((t) => {
    const line = (limitMicros * t) / 100;
    return beforeMicros < line && afterMicros >= line;
  });
}

/** CloudEvent type of budget alerts (stored as events, readable like any other event). */
export const BUDGET_ALERT_EVENT_TYPE = 'io.openagentix.budget.alert';

export interface BudgetAlertData {
  tenantId: string;
  scope: BudgetScope;
  /** Use case or team slug; null for the tenant budget. */
  key: string | null;
  month: string;
  thresholdPercent: AlertThreshold;
  limitUsd: number;
  spentUsd: number;
}
