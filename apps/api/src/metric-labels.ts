import { RUNNER_KINDS, RUN_STATUSES, STEP_KINDS, providerMetricLabel } from '@openagentix/core';

/**
 * Closed value sets of the Prometheus label values (ADR 0015 section 10, slice S5).
 *
 * Every label value that a metric takes goes through one of these normalisers right before it is
 * recorded, so a tenant-chosen text (connection name, event source name, agent name, use case,
 * model name, tool name, error message) can never become a label value, even if a caller passes
 * one by mistake. A value outside the set becomes the fallback of the set.
 */
const set = <T extends string>(...values: readonly T[]): ReadonlySet<string> => new Set(values);

export const TOOL_DECISIONS = set('allow', 'deny', 'require_approval');
export const TOOL_RESULTS = set('ok', 'error', 'not_executed');
export const APPROVAL_OUTCOMES = set('approved', 'rejected', 'timeout', 'cancelled');
export const TOKEN_DIRECTIONS = set('input', 'output', 'cache_read', 'cache_write');
export const TOKEN_VIA = set('in-process', 'proxy');
export const BUDGET_SCOPES = set('run', 'step', 'team', 'use_case', 'tenant');
export const BUDGET_LIMITS = set('tokens', 'usd', 'steps', 'tool_calls', 'timeout');
export const GUARD_SOURCES = set('input', 'tool_result', 'tool_error');
export const GUARD_CLASSES = set('secret', 'invisible');
export const NODE_REPORT_RESULTS = set('accepted', 'refused', 'dropped');
export const EVENT_KINDS = set('webhook', 'mail', 'kafka', 'cron');
export const TRIGGER_KINDS = set('manual', 'webhook', 'mail', 'kafka', 'cron', 'demo');
export const RUN_STATUS_LABELS = set(...RUN_STATUSES);
export const STEP_STATUS_LABELS = set('ok', 'error');
export const RUNNER_LABELS = set(...RUNNER_KINDS);
export const STEP_KIND_LABELS = set(...STEP_KINDS);
export const ERROR_TYPES = set(
  '',
  'budget',
  'timeout',
  'cancelled',
  'approval_timeout',
  'handover_invalid',
  'provider_error',
  'policy_denied',
  'tool_error',
  '_OTHER',
);

/** The value when it belongs to the set, else `fallback` (which itself belongs to the set). */
export function closed(allowed: ReadonlySet<string>, value: unknown, fallback = 'other'): string {
  return typeof value === 'string' && allowed.has(value) ? value : fallback;
}

/**
 * Trigger family of a run from its `triggered_by` ("webhook:<source name>", "cron:<source name>",
 * "manual:<user id>", "demo-scenario:<visitor>"): only the family, only when it is a known one.
 * The part after the colon is tenant-chosen or an id and is never used.
 */
export function triggerLabel(triggeredBy: string): string {
  const head = triggeredBy.split(':')[0] ?? '';
  return closed(TRIGGER_KINDS, head === 'demo-scenario' ? 'demo' : head);
}

/** Provider label for a cost or token line: the closed family set, never an instance name. */
export const providerLabel = providerMetricLabel;

/** Maps a platform error code to the closed `error.type` list of the GenAI metrics. */
export function errorTypeOf(code: string | null | undefined): string {
  if (!code) return '';
  if (code.startsWith('control_budget') || code === 'budget_exceeded') return 'budget';
  if (code === 'control_timeout') return 'timeout';
  if (code === 'cancelled') return 'cancelled';
  if (code === 'approval_timeout') return 'approval_timeout';
  if (code === 'handover_invalid') return 'handover_invalid';
  if (code === 'provider_error') return 'provider_error';
  if (code === 'control_forbidden_action' || code === 'control_policy_denials')
    return 'policy_denied';
  return '_OTHER';
}

/** Budget rule of a control decision -> (scope, limit) of `oax_budget_exhausted_total`. */
export const BUDGET_RULES: Readonly<Record<string, readonly [string, string]>> = {
  budget_tokens: ['run', 'tokens'],
  budget_cost: ['run', 'usd'],
  budget_steps: ['run', 'steps'],
  budget_tool_calls: ['run', 'tool_calls'],
  timeout: ['run', 'timeout'],
  budget_tenant: ['tenant', 'usd'],
  budget_team: ['team', 'usd'],
  budget_use_case: ['use_case', 'usd'],
};
