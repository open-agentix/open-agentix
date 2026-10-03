import { classificationRank } from '../classification.js';
import { OaxError, ValidationError, type ValidationIssue } from '../errors.js';
import { compareSemver, isSemver } from '../semver.js';
import { parseAgentDefinition, type AgentDefinition } from './parser.js';
import type { ArgConstraint } from './schema.js';

export interface ValidationResult {
  valid: boolean;
  definition: AgentDefinition | null;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

function checkRegex(pattern: string, path: string, errors: ValidationIssue[]): void {
  try {
    new RegExp(pattern, 'u');
  } catch (e) {
    errors.push({ path, message: `invalid regular expression: ${(e as Error).message}` });
  }
}

function checkConstraint(c: ArgConstraint, path: string, errors: ValidationIssue[]): void {
  if (c.pattern !== undefined) checkRegex(c.pattern, `${path}.pattern`, errors);
  c.deny?.forEach((d, i) => checkRegex(d, `${path}.deny.${i}`, errors));
  const numericOnly = c.minimum !== undefined || c.maximum !== undefined;
  const stringOnly =
    c.pattern !== undefined || c.minLength !== undefined || c.maxLength !== undefined;
  if (numericOnly && c.type && c.type !== 'number' && c.type !== 'integer') {
    errors.push({ path, message: 'minimum/maximum require type number or integer' });
  }
  if (stringOnly && c.type && c.type !== 'string') {
    errors.push({ path, message: 'pattern/minLength/maxLength require type string' });
  }
  if (c.maxItems !== undefined && c.type && c.type !== 'array') {
    errors.push({ path, message: 'maxItems requires type array' });
  }
  if (c.minimum !== undefined && c.maximum !== undefined && c.minimum > c.maximum) {
    errors.push({ path, message: 'minimum is greater than maximum' });
  }
  if (c.minLength !== undefined && c.maxLength !== undefined && c.minLength > c.maxLength) {
    errors.push({ path, message: 'minLength is greater than maxLength' });
  }
}

/** Semantic checks on top of the schema: references, regexes, budgets, classification. */
export function checkDefinition(def: AgentDefinition): {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
} {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  if (!isSemver(def.version)) {
    errors.push({ path: 'version', message: `"${def.version}" is not a SemVer 2.0.0 version` });
  }
  const ids = new Set<string>();
  def.agents.forEach((a, i) => {
    if (ids.has(a.id))
      errors.push({ path: `agents.${i}.id`, message: `duplicate agent id "${a.id}"` });
    ids.add(a.id);
  });
  if (def.kind === 'Agent' && def.agents.length > 1) {
    errors.push({
      path: 'kind',
      message: 'kind "Agent" allows exactly one agent; use "AgentPipeline"',
    });
  }
  const seen = new Set<string>();
  def.pipeline.forEach((id, i) => {
    if (!ids.has(id)) errors.push({ path: `pipeline.${i}`, message: `unknown agent "${id}"` });
    if (seen.has(id))
      errors.push({ path: `pipeline.${i}`, message: `agent "${id}" appears twice` });
    seen.add(id);
  });
  for (const id of ids) {
    if (!seen.has(id))
      warnings.push({ path: 'pipeline', message: `agent "${id}" is never executed` });
  }
  def.agents.forEach((a, i) => {
    const grants = new Set<string>();
    a.tools.forEach((t, j) => {
      const path = `agents.${i}.tools.${j}`;
      const key = `${t.server}/${t.tool}`;
      if (grants.has(key)) errors.push({ path, message: `duplicate tool grant "${key}"` });
      grants.add(key);
      for (const [name, c] of Object.entries(t.args))
        checkConstraint(c, `${path}.args.${name}`, errors);
      if (
        t.classification &&
        classificationRank(t.classification) < classificationRank(def.classification)
      ) {
        warnings.push({
          path: `${path}.classification`,
          message: `tool is cleared for "${t.classification}" but the pipeline handles "${def.classification}" data; calls will be denied`,
        });
      }
      if (t.tool.endsWith('*') && t.approval === 'none' && Object.keys(t.args).length === 0) {
        warnings.push({ path, message: 'wildcard grant without argument constraints or approval' });
      }
    });
    for (const key of Object.keys(a.budget ?? {}) as (keyof NonNullable<typeof a.budget>)[]) {
      const av = a.budget?.[key];
      const pv = def.budget[key];
      if (av !== undefined && pv !== undefined && av > pv) {
        warnings.push({
          path: `agents.${i}.budget.${key}`,
          message: `agent budget exceeds pipeline budget (${av} > ${pv}); the pipeline value applies`,
        });
      }
    }
    a.simulation?.responses.forEach((r, k) =>
      r.toolCalls?.forEach((c, m) => {
        const granted = a.tools.some(
          (t) =>
            t.server === c.server &&
            (t.tool === c.tool || (t.tool.endsWith('*') && c.tool.startsWith(t.tool.slice(0, -1)))),
        );
        if (!granted) {
          warnings.push({
            path: `agents.${i}.simulation.responses.${k}.toolCalls.${m}`,
            message: `simulated call to "${c.server}/${c.tool}" is not granted and will be blocked`,
          });
        }
      }),
    );
  });
  if (Object.keys(def.budget).length === 0) {
    warnings.push({ path: 'budget', message: 'no pipeline budget set; platform defaults apply' });
  }
  return { errors, warnings };
}

/** Parses and validates an `agents.md` source without throwing. */
export function validateAgentSource(source: string): ValidationResult {
  let def: AgentDefinition;
  try {
    def = parseAgentDefinition(source);
  } catch (e) {
    if (e instanceof ValidationError) {
      return { valid: false, definition: null, errors: e.issues, warnings: [] };
    }
    throw e;
  }
  const { errors, warnings } = checkDefinition(def);
  return {
    valid: errors.length === 0,
    definition: errors.length === 0 ? def : null,
    errors,
    warnings,
  };
}

/** Parses + validates, throwing {@link ValidationError} on any error. */
export function loadAgentDefinition(source: string): AgentDefinition {
  const result = validateAgentSource(source);
  if (!result.valid || !result.definition) {
    throw new ValidationError('invalid agents.md', result.errors);
  }
  return result.definition;
}

export interface PublishedVersion {
  version: string;
  digest: string;
}

/**
 * Enforces immutability of published versions: a new version must have a higher SemVer than every
 * published one, and re-publishing an existing version is only allowed with identical content
 * (idempotent retry).
 * @returns `'new'` when the version must be stored, `'unchanged'` for an idempotent retry.
 */
export function checkPublish(
  published: readonly PublishedVersion[],
  next: AgentDefinition,
): 'new' | 'unchanged' {
  const same = published.find((p) => p.version === next.version);
  if (same) {
    if (same.digest === next.digest) return 'unchanged';
    throw new OaxError(
      'version_immutable',
      `version ${next.version} is already published with different content; bump the version`,
    );
  }
  const newer = published.find((p) => compareSemver(p.version, next.version) > 0);
  if (newer) {
    throw new OaxError(
      'version_not_increasing',
      `version ${next.version} must be greater than the published version ${newer.version}`,
    );
  }
  return 'new';
}
