import { z } from 'zod';
import { CLASSIFICATIONS, mayFlow, type Classification } from '../classification.js';
import type { AgentDefinition, AgentSpec } from '../agents/parser.js';
import type { ToolAccess } from '../agents/profiles.js';
import {
  COMPILE_STEPS_PER_CHAR,
  MAX_DEFINITION_PATTERNS,
  MAX_POLICY_PATTERNS,
  compileLinear,
  isCachedLinear,
  patternSetIssue,
  type LinearRegex,
} from '../agents/linear-regex.js';
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
    | 'profile_write_denied'
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
  agent: Pick<AgentSpec, 'id' | 'tools' | 'access'>;
  /**
   * Classification of the tools (`server/tool`) as of publish. For an agent with
   * `access: read-only` only tools classified `read` pass; unknown tools count as `write`.
   */
  toolAccess?: Readonly<Record<string, ToolAccess>> | undefined;
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

/**
 * Bounds of the pattern work of one decision (AEP-0002 rule 4). Matching is linear-time
 * (`compileLinear`), and its cost is bounded three ways, independent of the engine:
 *
 * - a string above {@link REGEX_INPUT_LIMIT} UTF-16 units is denied, never matched;
 * - matching is charged in steps (characters times program size) against {@link REGEX_WORK_BUDGET},
 *   about half a second at 50 ns per step; a decision that needs more is denied (fail closed);
 * - compiling is charged too ({@link COMPILE_STEPS_PER_CHAR} steps per source character of a pattern
 *   that is not in the cache), and the source is limited (one pattern, the patterns of a grant or a
 *   policy in total, their count; see `patternSetIssue`), so cold compiles stay within the budget;
 *   stored data above the limits is denied without being compiled.
 */
export const REGEX_INPUT_LIMIT = 16_384;
/** Matcher steps all expressions of one decision may use together (see above). */
export const REGEX_WORK_BUDGET = 10_000_000;

/** Work left for the expressions of one decision. */
export class RegexWork {
  left = REGEX_WORK_BUDGET;
  take(n: number): boolean {
    this.left -= n;
    return this.left >= 0;
  }

  /** The compiled `source`, or `null` when it cannot be taken or compiling it exceeds the budget. */
  regex(source: string, ignoreCase = false): LinearRegex | null {
    if (!isCachedLinear(source, ignoreCase) && !this.take(source.length * COMPILE_STEPS_PER_CHAR))
      return null;
    return compileLinear(source, ignoreCase);
  }
}

/** Strings and nesting depth `deny` looks at; a value beyond them cannot be checked and is denied. */
const DENY_MAX_STRINGS = 4096;
const DENY_MAX_DEPTH = 32;

/**
 * Every string inside a value, or `null` when the value is too large or too deep to inspect. A
 * `deny` rule that could not look at everything must not let the call through.
 */
function boundedStrings(value: unknown): string[] | null {
  const out: string[] = [];
  const todo: { v: unknown; depth: number }[] = [{ v: value, depth: 0 }];
  while (todo.length > 0) {
    const { v, depth } = todo.pop()!;
    if (typeof v === 'string') {
      if (out.length >= DENY_MAX_STRINGS) return null;
      out.push(v);
    } else if (Array.isArray(v) || (v && typeof v === 'object')) {
      if (depth >= DENY_MAX_DEPTH) return null;
      for (const x of Array.isArray(v) ? v : Object.values(v as object))
        todo.push({ v: x, depth: depth + 1 });
      if (todo.length > DENY_MAX_STRINGS * 4) return null;
    }
  }
  return out;
}

/** Length in Unicode code points (AEP-0002 section 7.5.5), not UTF-16 code units. */
function codePoints(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

export function checkArg(
  name: string,
  value: unknown,
  c: ArgConstraint,
  work: RegexWork = new RegexWork(),
): PolicyReason[] {
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
  // A bound that does not fit the value's type cannot be checked, so it denies: a constraint must
  // never pass because the value has another type than the one it was written for (fail closed).
  const mismatch = (need: string): void => {
    reasons.push({
      code: 'arg_type',
      message: `argument "${name}" must be ${need} to be checked against its constraints`,
    });
  };
  const wantsString =
    c.pattern !== undefined || c.minLength !== undefined || c.maxLength !== undefined;
  if (typeof value === 'string') {
    const length = codePoints(value);
    let tooLong = false;
    if (c.minLength !== undefined && length < c.minLength) {
      reasons.push({
        code: 'arg_length',
        message: `argument "${name}" is shorter than ${c.minLength}`,
      });
    }
    if (c.maxLength !== undefined && length > c.maxLength) {
      tooLong = true;
      reasons.push({
        code: 'arg_length',
        message: `argument "${name}" is longer than ${c.maxLength}`,
      });
    }
    if (c.pattern !== undefined && !tooLong) {
      if (value.length > REGEX_INPUT_LIMIT)
        reasons.push({
          code: 'arg_length',
          message: `argument "${name}" is longer than ${REGEX_INPUT_LIMIT} and cannot be matched`,
        });
      else {
        const re = work.regex(c.pattern);
        if (re === null || !work.take(value.length * re.size))
          reasons.push({
            code: 'arg_pattern',
            message: `argument "${name}" cannot be checked against its pattern`,
          });
        else if (!re.test(value))
          reasons.push({
            code: 'arg_pattern',
            message: `argument "${name}" does not match its pattern`,
          });
      }
    }
  } else if (wantsString) {
    mismatch('a string');
  }
  if (c.minimum !== undefined || c.maximum !== undefined) {
    if (typeof value !== 'number') mismatch('a number');
    else {
      if (c.minimum !== undefined && value < c.minimum) {
        reasons.push({ code: 'arg_range', message: `argument "${name}" is below ${c.minimum}` });
      }
      if (c.maximum !== undefined && value > c.maximum) {
        reasons.push({ code: 'arg_range', message: `argument "${name}" is above ${c.maximum}` });
      }
    }
  }
  if (c.maxItems !== undefined) {
    if (!Array.isArray(value)) mismatch('an array');
    else if (value.length > c.maxItems)
      reasons.push({
        code: 'arg_items',
        message: `argument "${name}" has more than ${c.maxItems} items`,
      });
  }
  if (c.deny && c.deny.length > 0) {
    const strings = boundedStrings(value);
    if (strings === null || strings.some((s) => s.length > REGEX_INPUT_LIMIT)) {
      reasons.push({
        code: 'arg_denied',
        message: `argument "${name}" is too large or too deeply nested to check against its deny patterns`,
      });
    } else {
      for (const d of c.deny) {
        const re = work.regex(d);
        if (re === null || !work.take(strings.reduce((n, x) => n + x.length, 0) * re.size)) {
          reasons.push({
            code: 'arg_denied',
            message: `argument "${name}" cannot be checked against its deny patterns`,
          });
          break;
        }
        if (strings.some((x) => re.test(x)))
          reasons.push({
            code: 'arg_denied',
            message: `argument "${name}" matches a denied pattern`,
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

  const args: unknown = call.args ?? {};
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    // The arguments of a call are an object; anything else cannot be checked, so it is denied.
    reasons.push({ code: 'arg_type', message: 'the arguments of a tool call must be an object' });
    return { effect: 'deny', reasons, grant };
  }
  // Stored data above the pattern limits is refused without compiling anything (the limits are what
  // bounds the compile cost); the reason is audited like every other.
  const grantIssue = patternSetIssue(
    Object.values(grant.args).flatMap((c) => [
      ...(c.pattern !== undefined ? [c.pattern] : []),
      ...(c.deny ?? []),
    ]),
    MAX_DEFINITION_PATTERNS,
  );
  if (grantIssue) {
    reasons.push({
      code: 'arg_pattern',
      message: `the pattern limits of this grant are exceeded: ${grantIssue}`,
    });
    return { effect: 'deny', reasons, grant };
  }
  const work = new RegexWork();
  for (const [name, c] of Object.entries(grant.args)) {
    // Own properties only: `toString` or `__proto__` is not an argument somebody declared.
    if (!Object.hasOwn(args, name) || (args as Record<string, unknown>)[name] === undefined) {
      if (c.required)
        reasons.push({ code: 'arg_missing', message: `argument "${name}" is required` });
      continue;
    }
    reasons.push(...checkArg(name, (args as Record<string, unknown>)[name], c, work));
  }
  if (!grant.allowAdditionalArgs) {
    for (const name of Object.keys(args)) {
      if (!Object.hasOwn(grant.args, name)) {
        // The name is chosen by the caller and ends up in audit reasons: it is not repeated.
        reasons.push({
          code: 'arg_unknown',
          message: 'an argument that the grant does not declare is not allowed',
        });
      }
    }
  }
  if (bundles.some((b) => b.forbiddenArgPatterns.length > 0)) {
    // Policy-wide patterns see every string of the call, so they get the same bounds as `deny`: a
    // value that cannot be inspected completely is denied, never let through.
    const strings = boundedStrings(args);
    for (const b of bundles) {
      const issue = patternSetIssue(
        b.forbiddenArgPatterns.map((f) => f.pattern),
        MAX_POLICY_PATTERNS,
      );
      if (issue) {
        reasons.push({
          code: 'arg_forbidden_pattern',
          message: `the pattern limits of a policy are exceeded: ${issue}`,
        });
        continue;
      }
      for (const f of b.forbiddenArgPatterns) {
        const re = work.regex(f.pattern, true);
        if (
          strings === null ||
          re === null ||
          strings.some((x) => x.length > REGEX_INPUT_LIMIT) ||
          !work.take(strings.reduce((n, x) => n + x.length, 0) * re.size)
        ) {
          reasons.push({
            code: 'arg_forbidden_pattern',
            message: 'the arguments are too large or cannot be checked against a policy pattern',
          });
          break;
        }
        if (strings.some((x) => re.test(x)))
          reasons.push({ code: 'arg_forbidden_pattern', message: f.reason });
      }
    }
  }
  if (ctx.agent.access === 'read-only' && ctx.toolAccess?.[key] !== 'read') {
    reasons.push({
      code: 'profile_write_denied',
      message: `agent "${ctx.agent.id}" is read-only; tool "${key}" is not classified as read`,
    });
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
