import { z } from 'zod';
import { CLASSIFICATIONS, mayFlow, type Classification } from '../classification.js';
import type { AgentDefinition, AgentSpec } from '../agents/parser.js';
import type { ArgConstraint, ToolGrant } from '../agents/schema.js';

/**
 * The per-agent "audit agent": a deterministic policy engine that checks every tool call BEFORE
 * it is executed. It is pure (no I/O, no clock, no randomness) so decisions are reproducible from
 * the audit trail.
 */

export interface ToolCallRequest {
  server: string;
  tool: string;
  args: Record<string, unknown>;
}

/** Global/team policy bundle managed via the API (`/v1/policies`). */
export const PolicyBundleSchema = z.strictObject({
  /** Globs over `server/tool`, e.g. `*\/delete_*` or `shell/*`. */
  forbiddenTools: z.array(z.string().min(1)).default([]),
  /** Regexes that must not match any string argument value (e.g. `rm\\s+-rf`). */
  forbiddenArgPatterns: z
    .array(
      z.strictObject({
        pattern: z.string().min(1),
        reason: z.string().default('forbidden argument'),
      }),
    )
    .default([]),
  /** Globs over `server/tool` that always need human approval, regardless of the agent file. */
  requireApprovalTools: z.array(z.string().min(1)).default([]),
  /** Highest data classification any agent under this policy may process. */
  maxClassification: z.enum(CLASSIFICATIONS).optional(),
});
export type PolicyBundle = z.infer<typeof PolicyBundleSchema>;

export type PolicyEffect = 'allow' | 'deny' | 'require_approval';

export interface PolicyReason {
  code:
    | 'tool_not_granted'
    | 'tool_forbidden'
    | 'arg_missing'
    | 'arg_unknown'
    | 'arg_type'
    | 'arg_pattern'
    | 'arg_enum'
    | 'arg_const'
    | 'arg_length'
    | 'arg_range'
    | 'arg_items'
    | 'arg_denied'
    | 'arg_forbidden_pattern'
    | 'call_limit'
    | 'classification'
    | 'approval_required';
  message: string;
}

export interface PolicyDecision {
  effect: PolicyEffect;
  reasons: PolicyReason[];
  /** The grant that matched (if any). */
  grant: ToolGrant | null;
}

export interface PolicyContext {
  definition: Pick<AgentDefinition, 'classification'>;
  agent: Pick<AgentSpec, 'id' | 'tools'>;
  bundles?: readonly PolicyBundle[];
  /** Number of calls already made in this run, keyed by `server/tool`. */
  callCounts?: ReadonlyMap<string, number>;
}

/** Glob with `*` (any chars) only; everything else is literal. */
export function globMatch(glob: string, value: string): boolean {
  const re = new RegExp(`^${glob.split('*').map(escapeRegex).join('.*')}$`, 's');
  return re.test(value);
}

function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

export function findGrant(
  tools: readonly ToolGrant[],
  server: string,
  tool: string,
): ToolGrant | null {
  const exact = tools.find((t) => t.server === server && t.tool === tool);
  if (exact) return exact;
  return (
    tools.find(
      (t) => t.server === server && t.tool.endsWith('*') && tool.startsWith(t.tool.slice(0, -1)),
    ) ?? null
  );
}

function typeOf(v: unknown): string {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  if (typeof v === 'number' && Number.isInteger(v)) return 'integer';
  return typeof v;
}

function stringsIn(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 32) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out, depth + 1);
  else if (value && typeof value === 'object')
    for (const v of Object.values(value)) stringsIn(v, out, depth + 1);
  return out;
}

export function checkArg(name: string, value: unknown, c: ArgConstraint): PolicyReason[] {
  const reasons: PolicyReason[] = [];
  const actual = typeOf(value);
  if (c.type) {
    const ok =
      c.type === 'number' ? actual === 'number' || actual === 'integer' : actual === c.type;
    if (!ok) {
      return [{ code: 'arg_type', message: `argument "${name}" must be ${c.type}, got ${actual}` }];
    }
  }
  if (c.const !== undefined && value !== c.const) {
    reasons.push({
      code: 'arg_const',
      message: `argument "${name}" must equal ${JSON.stringify(c.const)}`,
    });
  }
  if (c.enum && !c.enum.some((e) => e === value)) {
    reasons.push({
      code: 'arg_enum',
      message: `argument "${name}" must be one of ${JSON.stringify(c.enum)}`,
    });
  }
  if (typeof value === 'string') {
    if (c.pattern !== undefined && !new RegExp(c.pattern, 'u').test(value)) {
      reasons.push({
        code: 'arg_pattern',
        message: `argument "${name}" does not match ${c.pattern}`,
      });
    }
    if (c.minLength !== undefined && value.length < c.minLength) {
      reasons.push({
        code: 'arg_length',
        message: `argument "${name}" is shorter than ${c.minLength}`,
      });
    }
    if (c.maxLength !== undefined && value.length > c.maxLength) {
      reasons.push({
        code: 'arg_length',
        message: `argument "${name}" is longer than ${c.maxLength}`,
      });
    }
  } else if (c.pattern !== undefined) {
    reasons.push({
      code: 'arg_type',
      message: `argument "${name}" must be a string to match a pattern`,
    });
  }
  if (typeof value === 'number') {
    if (c.minimum !== undefined && value < c.minimum) {
      reasons.push({ code: 'arg_range', message: `argument "${name}" is below ${c.minimum}` });
    }
    if (c.maximum !== undefined && value > c.maximum) {
      reasons.push({ code: 'arg_range', message: `argument "${name}" is above ${c.maximum}` });
    }
  }
  if (Array.isArray(value) && c.maxItems !== undefined && value.length > c.maxItems) {
    reasons.push({
      code: 'arg_items',
      message: `argument "${name}" has more than ${c.maxItems} items`,
    });
  }
  if (c.deny) {
    const strings = stringsIn(value);
    for (const d of c.deny) {
      const re = new RegExp(d, 'u');
      if (strings.some((s) => re.test(s))) {
        reasons.push({
          code: 'arg_denied',
          message: `argument "${name}" matches denied pattern ${d}`,
        });
      }
    }
  }
  return reasons;
}

/**
 * Evaluates one tool call. Order: global forbids -> grant -> arguments -> limits -> classification
 * -> approval. All violations are collected so the audit entry explains every reason.
 */
export function evaluateToolCall(call: ToolCallRequest, ctx: PolicyContext): PolicyDecision {
  const key = `${call.server}/${call.tool}`;
  const bundles = ctx.bundles ?? [];
  const reasons: PolicyReason[] = [];

  for (const b of bundles) {
    for (const glob of b.forbiddenTools) {
      if (globMatch(glob, key)) {
        reasons.push({
          code: 'tool_forbidden',
          message: `tool "${key}" is forbidden by policy (${glob})`,
        });
      }
    }
  }
  const grant = findGrant(ctx.agent.tools, call.server, call.tool);
  if (!grant) {
    reasons.push({
      code: 'tool_not_granted',
      message: `tool "${key}" is not in the allowlist of agent "${ctx.agent.id}"`,
    });
    return { effect: 'deny', reasons, grant: null };
  }

  const args = call.args ?? {};
  for (const [name, c] of Object.entries(grant.args)) {
    if (!(name in args) || args[name] === undefined) {
      if (c.required)
        reasons.push({ code: 'arg_missing', message: `argument "${name}" is required` });
      continue;
    }
    reasons.push(...checkArg(name, args[name], c));
  }
  if (!grant.allowAdditionalArgs) {
    for (const name of Object.keys(args)) {
      if (!(name in grant.args)) {
        reasons.push({ code: 'arg_unknown', message: `argument "${name}" is not allowed` });
      }
    }
  }
  const strings = stringsIn(args);
  for (const b of bundles) {
    for (const f of b.forbiddenArgPatterns) {
      const re = new RegExp(f.pattern, 'iu');
      if (strings.some((s) => re.test(s))) {
        reasons.push({ code: 'arg_forbidden_pattern', message: `${f.reason} (${f.pattern})` });
      }
    }
  }
  const used = ctx.callCounts?.get(key) ?? 0;
  if (grant.maxCallsPerRun !== undefined && used >= grant.maxCallsPerRun) {
    reasons.push({
      code: 'call_limit',
      message: `tool "${key}" may be called at most ${grant.maxCallsPerRun} times per run`,
    });
  }
  const dataLevel: Classification = ctx.definition.classification;
  if (grant.classification && !mayFlow(dataLevel, grant.classification)) {
    reasons.push({
      code: 'classification',
      message: `"${dataLevel}" data must not be sent to tool "${key}" (cleared for "${grant.classification}")`,
    });
  }
  for (const b of bundles) {
    if (b.maxClassification && !mayFlow(dataLevel, b.maxClassification)) {
      reasons.push({
        code: 'classification',
        message: `policy allows at most "${b.maxClassification}" data, pipeline handles "${dataLevel}"`,
      });
    }
  }
  if (reasons.length > 0) return { effect: 'deny', reasons, grant };

  const approvalByBundle = bundles.some((b) =>
    b.requireApprovalTools.some((g) => globMatch(g, key)),
  );
  if (grant.approval === 'required' || approvalByBundle) {
    return {
      effect: 'require_approval',
      reasons: [{ code: 'approval_required', message: `tool "${key}" requires human approval` }],
      grant,
    };
  }
  return { effect: 'allow', reasons: [], grant };
}

/** Merges bundles into one (union of rules, strictest classification). */
export function mergeBundles(bundles: readonly PolicyBundle[]): PolicyBundle {
  const merged: PolicyBundle = {
    forbiddenTools: [],
    forbiddenArgPatterns: [],
    requireApprovalTools: [],
  };
  for (const b of bundles) {
    merged.forbiddenTools.push(...b.forbiddenTools);
    merged.forbiddenArgPatterns.push(...b.forbiddenArgPatterns);
    merged.requireApprovalTools.push(...b.requireApprovalTools);
    if (b.maxClassification) {
      const cur = merged.maxClassification;
      if (!cur || CLASSIFICATIONS.indexOf(b.maxClassification) < CLASSIFICATIONS.indexOf(cur)) {
        merged.maxClassification = b.maxClassification;
      }
    }
  }
  return merged;
}
