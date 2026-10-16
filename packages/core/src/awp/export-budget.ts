import type { Budget } from '../agents/schema.js';
import type { JsonObject } from './types.js';

/** AWP budget (spec 5.7) from an OpenAgentix budget; `undefined` when no limit is set. */
export function exportBudget(budget: Budget | undefined): JsonObject | undefined {
  if (!budget) return undefined;
  const out: JsonObject = {};
  if (budget.maxCostUsd !== undefined) out.maxCostUsd = budget.maxCostUsd;
  if (budget.maxSteps !== undefined) out.maxSteps = budget.maxSteps;
  if (budget.timeoutSeconds !== undefined) out.maxDuration = `${budget.timeoutSeconds}s`;
  const resources: JsonObject = {};
  if (budget.maxTokens !== undefined) resources.maxTokens = budget.maxTokens;
  if (budget.maxToolCalls !== undefined) resources.maxToolCalls = budget.maxToolCalls;
  if (Object.keys(resources).length > 0) out.resources = resources;
  return Object.keys(out).length > 0 ? out : undefined;
}
