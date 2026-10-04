import { parseDocument } from 'yaml';
import { z } from 'zod';
import { API_VERSION, JsonSchemaValueSchema, WHEN_MAX_LENGTH } from '../agents/schema.js';
import { checkJsonSchemaSubset, JSON_SCHEMA_LIMITS } from '../agents/json-schema.js';
import { canonicalJson, sha256Hex } from '../canonical.js';
import { ValidationError, type ValidationIssue } from '../errors.js';
import { isSemver } from '../semver.js';

/** Hard limits of an AgentPlan (ADR 0008 section 4); they also bound the work of the linter. */
export const PLAN_LIMITS = {
  /** Largest accepted plan source (YAML or JSON) in bytes. */
  maxSourceBytes: 64 * 1024,
  maxSteps: 20,
  maxDescription: 4000,
  maxPurpose: 1000,
  maxCapabilitiesPerStep: 32,
} as const;

const slugPattern = /^[a-z][a-z0-9-]{0,62}$/;
const slug = z.string().regex(slugPattern, 'must be a lowercase slug (a-z, 0-9, -), max. 63 chars');
const schemaName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,62}$/, 'invalid schema name');

/**
 * Capability grammar (ADR 0008): `model` (no tools), `<server>:<profile>` (profile grant) or
 * `<server>/<tool>` (single tool, a trailing `*` is allowed but linted by LP008). The separators
 * keep profile and tool names unambiguous.
 */
const CAPABILITY_PATTERN =
  /^(?:model|[a-z][a-z0-9-]{0,62}:[a-z][a-z0-9-]{0,62}|[a-z][a-z0-9-]{0,62}\/(?:[A-Za-z0-9_.-]+\*?|\*))$/;

export const CapabilitySchema = z
  .string()
  .max(160)
  .regex(CAPABILITY_PATTERN, 'use "<server>:<profile>", "<server>/<tool>" or "model"');

export type Capability =
  | { kind: 'model' }
  | { kind: 'profile'; server: string; profile: string }
  | { kind: 'tool'; server: string; tool: string; wildcard: boolean };

/** Parses a capability string; returns `null` when it does not match the grammar. */
export function parseCapability(text: string): Capability | null {
  if (!CAPABILITY_PATTERN.test(text) || text.length > 160) return null;
  if (text === 'model') return { kind: 'model' };
  const colon = text.indexOf(':');
  if (colon > 0) {
    return { kind: 'profile', server: text.slice(0, colon), profile: text.slice(colon + 1) };
  }
  const slash = text.indexOf('/');
  const tool = text.slice(slash + 1);
  return { kind: 'tool', server: text.slice(0, slash), tool, wildcard: tool.endsWith('*') };
}

export const PlanStepSchema = z.strictObject({
  id: slug,
  /** What the step is for, in plain language. Free text: never used by the linter. */
  purpose: z.string().min(1).max(PLAN_LIMITS.maxPurpose),
  capabilities: z.array(CapabilitySchema).max(PLAN_LIMITS.maxCapabilitiesPerStep).default([]),
  access: z.enum(['read-only', 'write']),
  approval: z.enum(['none', 'required']).default('none'),
  input: z
    .strictObject({
      /** `event` or ids of earlier steps. */
      from: z.array(slug).min(1).max(16).optional(),
      schema: schemaName.optional(),
    })
    .optional(),
  output: z.strictObject({ schema: schemaName }).optional(),
  when: z.string().min(1).max(WHEN_MAX_LENGTH).optional(),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const AgentPlanSchema = z.strictObject({
  apiVersion: z.literal(API_VERSION),
  kind: z.literal('AgentPlan'),
  name: slug,
  version: z.string().max(64),
  /** The process in plain language. Free text: never used by the linter. */
  description: z.string().min(1).max(PLAN_LIMITS.maxDescription),
  schemas: z
    .record(schemaName, JsonSchemaValueSchema)
    .refine((s) => Object.keys(s).length <= JSON_SCHEMA_LIMITS.maxNamedSchemas, {
      message: `at most ${JSON_SCHEMA_LIMITS.maxNamedSchemas} named schemas`,
    })
    .optional(),
  steps: z.array(PlanStepSchema).min(1).max(PLAN_LIMITS.maxSteps),
});
export type AgentPlan = z.infer<typeof AgentPlanSchema>;

/** `sha256:<hex of the canonical plan JSON>`; identical for every serialisation of the same plan. */
export function planDigest(plan: AgentPlan): string {
  return `sha256:${sha256Hex(canonicalJson(plan))}`;
}

/** Structural checks the schema cannot express: SemVer, unique ids, schema names and subset. */
export function checkPlanStructure(plan: AgentPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isSemver(plan.version)) {
    issues.push({ path: 'version', message: `"${plan.version}" is not a SemVer 2.0.0 version` });
  }
  const named = plan.schemas ?? {};
  for (const name of Object.keys(named)) {
    issues.push(...checkJsonSchemaSubset(named[name], `schemas.${name}`, named));
  }
  const ids = new Set<string>();
  plan.steps.forEach((step, i) => {
    if (ids.has(step.id))
      issues.push({ path: `steps.${i}.id`, message: `duplicate step id "${step.id}"` });
    ids.add(step.id);
    const seen = new Set<string>();
    step.capabilities.forEach((cap, j) => {
      if (seen.has(cap)) {
        issues.push({
          path: `steps.${i}.capabilities.${j}`,
          message: `duplicate capability "${cap}"`,
        });
      }
      seen.add(cap);
    });
    const refs: [string, string | undefined][] = [
      [`steps.${i}.input.schema`, step.input?.schema],
      [`steps.${i}.output.schema`, step.output?.schema],
    ];
    for (const [path, name] of refs) {
      if (name !== undefined && !(name in named)) {
        issues.push({ path, message: `schema "${name}" is not defined in "schemas"` });
      }
    }
    const from = step.input?.from ?? [];
    if (new Set(from).size !== from.length) {
      issues.push({ path: `steps.${i}.input.from`, message: 'duplicate source' });
    }
  });
  return issues;
}

export interface ParsedPlan {
  plan: AgentPlan | null;
  errors: ValidationIssue[];
}

/**
 * Parses a plan from YAML or JSON text (JSON is YAML). Never throws: size, syntax, schema and
 * structure problems come back as `errors`. The text is data: nothing in it is evaluated.
 */
export function parsePlan(source: string): ParsedPlan {
  if (Buffer.byteLength(source, 'utf8') > PLAN_LIMITS.maxSourceBytes) {
    return {
      plan: null,
      errors: [{ path: '', message: `plan larger than ${PLAN_LIMITS.maxSourceBytes} bytes` }],
    };
  }
  const doc = parseDocument(source, { prettyErrors: false, uniqueKeys: true });
  if (doc.errors.length > 0) {
    return {
      plan: null,
      errors: doc.errors.map((e) => ({ path: '', message: `invalid YAML or JSON: ${e.code}` })),
    };
  }
  let raw: unknown;
  try {
    raw = doc.toJS({ maxAliasCount: 50 });
  } catch {
    return {
      plan: null,
      errors: [{ path: '', message: 'invalid YAML or JSON: too many aliases' }],
    };
  }
  const parsed = AgentPlanSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      plan: null,
      errors: parsed.error.issues.map((i) => ({
        path: i.path.map(String).join('.'),
        message: i.message,
      })),
    };
  }
  const errors = checkPlanStructure(parsed.data);
  return errors.length > 0 ? { plan: null, errors } : { plan: parsed.data, errors: [] };
}

/** Like {@link parsePlan} but throws a {@link ValidationError}. */
export function loadPlan(source: string): AgentPlan {
  const { plan, errors } = parsePlan(source);
  if (!plan) throw new ValidationError('invalid agent plan', errors);
  return plan;
}
