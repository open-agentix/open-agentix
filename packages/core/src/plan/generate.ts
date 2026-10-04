import { stringify } from 'yaml';
import { validateAgentSource } from '../agents/validate.js';
import { API_VERSION } from '../agents/schema.js';
import { OaxError, ValidationError } from '../errors.js';
import type { AgentPlanLint } from './lint.js';
import { oneLine } from './text.js';
import { parseCapability, planDigest, type AgentPlan, type PlanStep } from './schema.js';

export interface GenerateOptions {
  /** Provider name written to every agent (default `simulated`). */
  provider?: string;
  model?: string;
  /** Owner slug of the draft (default `unassigned`). */
  owner?: string;
}

/** Budget of every generated draft; a conservative starting point for the agent engineer. */
export const DRAFT_BUDGET = { maxCostUsd: 1, maxToolCalls: 25, timeoutSeconds: 900 } as const;

const ref = (name: string): { $ref: string } => ({ $ref: `#/schemas/${name}` });

function grantsOf(step: PlanStep): Record<string, unknown>[] {
  const approval = step.approval === 'required' ? { approval: 'required' } : {};
  const grants: Record<string, unknown>[] = [];
  for (const text of step.capabilities) {
    const cap = parseCapability(text);
    if (!cap || cap.kind === 'model') continue;
    grants.push(
      cap.kind === 'profile'
        ? { server: cap.server, profile: cap.profile, ...approval }
        : { server: cap.server, tool: cap.tool, allowAdditionalArgs: true, ...approval },
    );
  }
  return grants;
}

function agentOf(step: PlanStep, provider: string, model: string): Record<string, unknown> {
  return {
    id: step.id,
    provider,
    model,
    access: step.access,
    ...(step.input
      ? {
          input: {
            ...(step.input.from ? { from: step.input.from } : {}),
            ...(step.input.schema ? { schema: ref(step.input.schema) } : {}),
          },
        }
      : {}),
    ...(step.when ? { when: step.when } : {}),
    tools: grantsOf(step),
    ...(step.output
      ? {
          outputs: [{ format: 'json' }],
          output: { schema: ref(step.output.schema), onInvalid: 'fail' },
        }
      : {}),
  };
}

function instructionsOf(step: PlanStep): string {
  return [
    `## Agent: ${step.id}`,
    '',
    // The prefix keeps the line from ever starting with a markdown heading or a fence.
    `Purpose: ${oneLine(step.purpose)}`,
    '',
    'Work only through the granted tools and stay within this purpose.' +
      (step.output ? ' Answer with JSON that matches the output schema.' : ''),
  ].join('\n');
}

/**
 * Deterministic plan -> agents.md draft (no model, no clock). Free text only ever lands in the
 * YAML description (serialised by a YAML writer) and in one-line `Purpose:` paragraphs, so a plan
 * cannot add sections, agents or front matter keys. Throws when the lint has errors, and
 * validates the result with the real agents.md parser (an invalid draft is a bug, not input).
 */
export function generateAgentsMd(
  plan: AgentPlan,
  lint: AgentPlanLint,
  opts: GenerateOptions = {},
): string {
  if (lint.summary.error > 0) {
    throw new OaxError(
      'plan_has_errors',
      'a plan with error findings cannot be turned into a draft',
    );
  }
  if (lint.planDigest !== planDigest(plan)) {
    throw new OaxError('plan_lint_mismatch', 'the lint result does not belong to this plan');
  }
  const provider = opts.provider ?? 'simulated';
  const model = opts.model ?? 'simulated';
  const front: Record<string, unknown> = {
    apiVersion: API_VERSION,
    kind: 'AgentPipeline',
    name: plan.name,
    version: plan.version,
    description: oneLine(plan.description),
    owner: opts.owner ?? 'unassigned',
    classification: 'internal',
    labels: { plan: `${plan.name}@${plan.version}`, 'plan-digest': lint.planDigest },
    triggers: [{ type: 'manual' }],
    budget: { ...DRAFT_BUDGET },
    ...(plan.schemas ? { schemas: plan.schemas } : {}),
    agents: plan.steps.map((s) => agentOf(s, provider, model)),
    pipeline: plan.steps.map((s) => s.id),
  };
  const yaml = stringify(front, { lineWidth: 0, sortMapEntries: false });
  const source = [
    '---',
    yaml.trimEnd(),
    '---',
    '',
    `# ${plan.name}`,
    '',
    'Draft generated from an Agent Plan. Review every step before you publish.',
    '',
    plan.steps.map(instructionsOf).join('\n\n'),
    '',
  ].join('\n');
  const check = validateAgentSource(source);
  if (!check.valid) {
    throw new ValidationError('generated draft is invalid (this is a bug)', check.errors);
  }
  return source;
}
