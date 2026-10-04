import { canonicalJson } from '../canonical.js';
import { mayFlow, type Classification } from '../classification.js';
import type { Budget } from '../agents/schema.js';
import type { BudgetBreach } from '../budget/budget.js';

/**
 * The global "control agent": deterministic guardrails that watch a run and can pause or kill it.
 * An optional reviewer (e.g. an LLM second opinion) may only make a decision stricter.
 */

export type ControlAction = 'continue' | 'pause' | 'kill';

export interface ControlReason {
  rule:
    | 'budget_tokens'
    | 'budget_cost'
    | 'budget_steps'
    | 'budget_tool_calls'
    | 'budget_tenant'
    | 'budget_use_case'
    | 'budget_team'
    | 'timeout'
    | 'rate'
    | 'loop'
    | 'error_streak'
    | 'policy_denials'
    | 'forbidden_action'
    | 'classification'
    | 'reviewer';
  message: string;
}

export interface ControlDecision {
  action: ControlAction;
  reasons: ControlReason[];
  /** For `pause`: how long the run should wait before it continues. */
  resumeAfterMs?: number;
}

export interface ControlLimits {
  maxTokens?: number;
  maxCostMicros?: number;
  maxSteps?: number;
  maxToolCalls?: number;
  timeoutMs?: number;
  /** Rate guardrail: tool calls per sliding minute before the run is paused. */
  maxToolCallsPerMinute: number;
  /** Anomaly: the same tool with identical arguments this many times = loop. */
  maxIdenticalToolCalls: number;
  /** Anomaly: consecutive failing steps. */
  maxConsecutiveErrors: number;
  /** Policy denials per run before the control agent kills the run. */
  maxPolicyDenials: number;
}

export const DEFAULT_CONTROL_LIMITS: ControlLimits = {
  maxToolCallsPerMinute: 30,
  maxIdenticalToolCalls: 3,
  maxConsecutiveErrors: 3,
  maxPolicyDenials: 3,
};

/** Converts an agents.md budget into control limits (platform defaults fill the gaps). */
export function limitsFromBudget(
  budget: Budget,
  defaults: Partial<ControlLimits> = {},
): ControlLimits {
  const limits: ControlLimits = { ...DEFAULT_CONTROL_LIMITS, ...defaults };
  if (budget.maxTokens !== undefined) limits.maxTokens = budget.maxTokens;
  if (budget.maxCostUsd !== undefined)
    limits.maxCostMicros = Math.round(budget.maxCostUsd * 1_000_000);
  if (budget.maxSteps !== undefined) limits.maxSteps = budget.maxSteps;
  if (budget.maxToolCalls !== undefined) limits.maxToolCalls = budget.maxToolCalls;
  if (budget.timeoutSeconds !== undefined) limits.timeoutMs = budget.timeoutSeconds * 1000;
  return limits;
}

/** Mutable counters of one run; updated by the executor via the `record*` helpers. */
export interface RunMetrics {
  startedAt: number;
  tokens: number;
  costMicros: number;
  steps: number;
  toolCalls: number;
  toolCallTimes: number[];
  identicalCalls: Map<string, number>;
  consecutiveErrors: number;
  policyDenials: number;
  forbiddenAttempts: number;
  /** Monthly tenant/use-case/team budgets reported as reached by the control node. */
  budgetBreaches: BudgetBreach[];
}

export function newRunMetrics(startedAt: number): RunMetrics {
  return {
    startedAt,
    tokens: 0,
    costMicros: 0,
    steps: 0,
    toolCalls: 0,
    toolCallTimes: [],
    identicalCalls: new Map(),
    consecutiveErrors: 0,
    policyDenials: 0,
    forbiddenAttempts: 0,
    budgetBreaches: [],
  };
}

/** Replaces the known breaches with the latest verdict of the control node. */
export function recordBudgetBreaches(m: RunMetrics, breaches: readonly BudgetBreach[]): void {
  m.budgetBreaches = [...breaches];
}

export function recordModelCall(m: RunMetrics, tokens: number, costMicros: number): void {
  m.steps += 1;
  m.tokens += tokens;
  m.costMicros += costMicros;
}

export function recordToolCall(
  m: RunMetrics,
  call: { server: string; tool: string; args: unknown },
  at: number,
): void {
  m.steps += 1;
  m.toolCalls += 1;
  m.toolCallTimes.push(at);
  const key = `${call.server}/${call.tool}:${canonicalJson(call.args ?? {})}`;
  m.identicalCalls.set(key, (m.identicalCalls.get(key) ?? 0) + 1);
}

export function recordStepResult(m: RunMetrics, ok: boolean): void {
  m.consecutiveErrors = ok ? 0 : m.consecutiveErrors + 1;
}

export function recordPolicyDenial(m: RunMetrics, forbidden: boolean): void {
  m.policyDenials += 1;
  if (forbidden) m.forbiddenAttempts += 1;
}

export interface ControlReviewer {
  /** Must never relax a decision; results that are less strict are ignored. */
  review(metrics: Readonly<RunMetrics>, decision: ControlDecision): Promise<ControlDecision>;
}

const SEVERITY: Record<ControlAction, number> = { continue: 0, pause: 1, kill: 2 };

/** Combines two decisions; the stricter action wins and reasons are merged. */
export function stricter(a: ControlDecision, b: ControlDecision): ControlDecision {
  const winner = SEVERITY[b.action] > SEVERITY[a.action] ? b : a;
  const out: ControlDecision = { action: winner.action, reasons: [...a.reasons, ...b.reasons] };
  if (out.action === 'pause') {
    out.resumeAfterMs = Math.max(a.resumeAfterMs ?? 0, b.resumeAfterMs ?? 0);
  }
  return out;
}

export class ControlAgent {
  constructor(
    private readonly limits: ControlLimits,
    private readonly reviewer?: ControlReviewer,
  ) {}

  /** Checks a provider/data classification pair before the first model call. */
  checkDataFlow(data: Classification, providerClearance: Classification): ControlDecision {
    if (mayFlow(data, providerClearance)) return { action: 'continue', reasons: [] };
    return {
      action: 'kill',
      reasons: [
        {
          rule: 'classification',
          message: `"${data}" data must not be sent to a provider cleared for "${providerClearance}"`,
        },
      ],
    };
  }

  /** Deterministic evaluation of all guardrails. */
  evaluate(m: Readonly<RunMetrics>, now: number): ControlDecision {
    const l = this.limits;
    const kill: ControlReason[] = [];
    if (l.maxTokens !== undefined && m.tokens > l.maxTokens) {
      kill.push({
        rule: 'budget_tokens',
        message: `token budget exceeded (${m.tokens} > ${l.maxTokens})`,
      });
    }
    if (l.maxCostMicros !== undefined && m.costMicros > l.maxCostMicros) {
      kill.push({
        rule: 'budget_cost',
        message: `cost budget exceeded (${(m.costMicros / 1e6).toFixed(6)} USD > ${(l.maxCostMicros / 1e6).toFixed(6)} USD)`,
      });
    }
    if (l.maxSteps !== undefined && m.steps > l.maxSteps) {
      kill.push({
        rule: 'budget_steps',
        message: `step budget exceeded (${m.steps} > ${l.maxSteps})`,
      });
    }
    if (l.maxToolCalls !== undefined && m.toolCalls > l.maxToolCalls) {
      kill.push({
        rule: 'budget_tool_calls',
        message: `tool call budget exceeded (${m.toolCalls} > ${l.maxToolCalls})`,
      });
    }
    for (const b of m.budgetBreaches) {
      kill.push({ rule: `budget_${b.scope}`, message: b.message });
    }
    if (l.timeoutMs !== undefined && now - m.startedAt > l.timeoutMs) {
      kill.push({ rule: 'timeout', message: `run exceeded its timeout of ${l.timeoutMs} ms` });
    }
    for (const [key, n] of m.identicalCalls) {
      if (n >= l.maxIdenticalToolCalls) {
        kill.push({
          rule: 'loop',
          message: `identical tool call repeated ${n} times (${key.split(':')[0]})`,
        });
      }
    }
    if (m.consecutiveErrors >= l.maxConsecutiveErrors) {
      kill.push({
        rule: 'error_streak',
        message: `${m.consecutiveErrors} consecutive failing steps`,
      });
    }
    if (m.policyDenials >= l.maxPolicyDenials) {
      kill.push({
        rule: 'policy_denials',
        message: `${m.policyDenials} tool calls denied by policy`,
      });
    }
    if (m.forbiddenAttempts > 0) {
      kill.push({
        rule: 'forbidden_action',
        message: 'the agent attempted a globally forbidden action',
      });
    }
    if (kill.length > 0) return { action: 'kill', reasons: kill };

    const windowStart = now - 60_000;
    const recent = m.toolCallTimes.filter((t) => t > windowStart);
    if (recent.length >= l.maxToolCallsPerMinute) {
      const oldest = recent[0] ?? now;
      return {
        action: 'pause',
        reasons: [{ rule: 'rate', message: `${recent.length} tool calls in the last minute` }],
        resumeAfterMs: Math.max(0, oldest + 60_000 - now),
      };
    }
    return { action: 'continue', reasons: [] };
  }

  /** Deterministic rules first, then the optional reviewer (which can only tighten). */
  async check(m: Readonly<RunMetrics>, now: number): Promise<ControlDecision> {
    const base = this.evaluate(m, now);
    if (!this.reviewer || base.action === 'kill') return base;
    const second = await this.reviewer.review(m, base);
    if (SEVERITY[second.action] <= SEVERITY[base.action]) return base;
    return stricter(base, {
      ...second,
      reasons:
        second.reasons.length > 0
          ? second.reasons
          : [{ rule: 'reviewer', message: 'reviewer escalated' }],
    });
  }
}
