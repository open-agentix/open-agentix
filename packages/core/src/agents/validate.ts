import { classificationRank } from '../classification.js';
import { DARK_FACTORY_NOTICE } from '../guidelines.js';
import { OaxError, ValidationError, type ValidationIssue } from '../errors.js';
import { compareSemver, isSemver } from '../semver.js';
import { checkJsonSchemaSubset, JSON_SCHEMA_LIMITS, SCHEMA_REF_PREFIX } from './json-schema.js';
import { parseAgentDefinition, type AgentDefinition, type AgentSpec } from './parser.js';
import {
  CONFIG_PLACEHOLDER,
  HANDOVER_EVENT_SOURCE,
  type ArgConstraint,
  type CredentialRef,
} from './schema.js';
import { parseWhen, whenStepRefs } from './when.js';

/** Publish-time knowledge the core cannot have on its own (filled by the control node). */
export interface DefinitionContext {
  /** Profile names per connection (`server -> profiles`); enables the profile name check. */
  profiles?: Readonly<Record<string, readonly string[]>>;
}

/** Environment variable a step credential is exposed as (explicit `env` or derived from the ref). */
export function credentialEnvName(c: CredentialRef): string {
  if (c.env) return c.env;
  const name = c.secret.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  return /^[0-9]/.test(name) ? `_${name}` : name;
}

/** Runners that may host a harness: the harness child never runs in the worker process. */
const HARNESS_RUNNERS: readonly string[] = ['container', 'kubernetes-job'];

const RESERVED_ENV = new Set([
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'PWD',
  'TMPDIR',
  'LANG',
  'NODE_OPTIONS',
  'NODE_PATH',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
]);
const RESERVED_ENV_PREFIXES = ['OAX_', 'LD_', 'DYLD_'];

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

function checkHandovers(
  def: AgentDefinition,
  context: DefinitionContext,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
): void {
  const named = def.schemas ?? {};
  const names = Object.keys(named);
  if (names.length > JSON_SCHEMA_LIMITS.maxNamedSchemas) {
    errors.push({
      path: 'schemas',
      message: `more than ${JSON_SCHEMA_LIMITS.maxNamedSchemas} named schemas`,
    });
  }
  for (const name of names)
    errors.push(...checkJsonSchemaSubset(named[name], `schemas.${name}`, named));
  const referenced = new Set<string>();
  const collectRefs = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(collectRefs);
    else if (typeof v === 'object' && v !== null) {
      for (const [k, x] of Object.entries(v)) {
        if (k === '$ref' && typeof x === 'string' && x.startsWith(SCHEMA_REF_PREFIX))
          referenced.add(x.slice(SCHEMA_REF_PREFIX.length));
        else collectRefs(x);
      }
    }
  };
  collectRefs(named);
  const order = new Map(def.pipeline.map((id, i) => [id, i]));
  const byId = new Map(def.agents.map((a) => [a.id, a]));
  const checkStepRef = (a: AgentSpec, ref: string, path: string): void => {
    const target = order.get(ref);
    const self = order.get(a.id);
    if (target === undefined) {
      errors.push({ path, message: `"${ref}" is not a step of the pipeline` });
    } else if (self !== undefined && target >= self) {
      errors.push({ path, message: `"${ref}" does not run before "${a.id}"` });
    } else if (!byId.get(ref)?.output) {
      warnings.push({
        path,
        message: `step "${ref}" has no output schema; its output is not validated`,
      });
    }
  };
  def.agents.forEach((a, i) => {
    const base = `agents.${i}`;
    if (a.input?.schema) {
      collectRefs(a.input.schema);
      errors.push(...checkJsonSchemaSubset(a.input.schema, `${base}.input.schema`, named));
    }
    if (a.output) {
      collectRefs(a.output.schema);
      errors.push(...checkJsonSchemaSubset(a.output.schema, `${base}.output.schema`, named));
      if (!a.outputs.some((o) => o.format === 'json'))
        errors.push({
          path: `${base}.output`,
          message: 'output.schema needs an "outputs" entry with format "json"',
        });
    }
    const seenFrom = new Set<string>();
    a.input?.from?.forEach((src, j) => {
      const path = `${base}.input.from.${j}`;
      if (seenFrom.has(src)) errors.push({ path, message: `duplicate source "${src}"` });
      seenFrom.add(src);
      if (src !== HANDOVER_EVENT_SOURCE) checkStepRef(a, src, path);
    });
    if (a.when !== undefined) {
      try {
        for (const ref of whenStepRefs(parseWhen(a.when))) checkStepRef(a, ref, `${base}.when`);
      } catch (e) {
        errors.push({ path: `${base}.when`, message: (e as Error).message });
      }
    }
    checkCredentials(a.credentials ?? [], `${base}.credentials`, errors);
    if (a.runtime?.harness) {
      const runner = a.runtime.runner ?? def.runtime.runner;
      if (!HARNESS_RUNNERS.includes(runner))
        errors.push({
          path: `${base}.runtime.harness`,
          message: `a harness step needs an isolating runner (container or kubernetes-job), not "${runner}"`,
        });
      if (a.instructions && CONFIG_PLACEHOLDER.test(a.instructions))
        errors.push({
          path: `${base}.instructions`,
          message:
            'the instructions of a harness step must not contain "{env:" or "{file:" (the harness would substitute them)',
        });
      if (a.simulation)
        errors.push({
          path: `${base}.simulation`,
          message:
            'a harness step cannot use "simulation": scripted responses never reach a harness',
        });
    }
    a.runtime?.egress?.forEach((host, j) => {
      if (!def.runtime.egress.includes(host))
        errors.push({
          path: `${base}.runtime.egress.${j}`,
          message: `"${host}" is not in the pipeline's runtime.egress; a step can only narrow it`,
        });
    });
    const profileKeys = new Set<string>();
    a.profileGrants?.forEach((p, j) => {
      const path = `${base}.tools (profile ${j + 1})`;
      const key = `${p.server}:${p.profile}`;
      if (profileKeys.has(key)) errors.push({ path, message: `duplicate profile grant "${key}"` });
      profileKeys.add(key);
      if (context.profiles && !context.profiles[p.server]?.includes(p.profile))
        errors.push({ path, message: `connection "${p.server}" has no profile "${p.profile}"` });
    });
  });
  for (const name of names)
    if (!referenced.has(name))
      warnings.push({ path: `schemas.${name}`, message: `schema "${name}" is never used` });
}

function checkCredentials(
  creds: readonly CredentialRef[],
  path: string,
  errors: ValidationIssue[],
): void {
  const secrets = new Set<string>();
  const envs = new Set<string>();
  creds.forEach((c, i) => {
    const env = credentialEnvName(c);
    if (secrets.has(c.secret))
      errors.push({ path: `${path}.${i}`, message: `duplicate secret "${c.secret}"` });
    secrets.add(c.secret);
    if (envs.has(env)) errors.push({ path: `${path}.${i}`, message: `duplicate env "${env}"` });
    envs.add(env);
    if (RESERVED_ENV.has(env) || RESERVED_ENV_PREFIXES.some((p) => env.startsWith(p)))
      errors.push({ path: `${path}.${i}.env`, message: `env "${env}" is reserved` });
  });
}

/** Semantic checks on top of the schema: references, regexes, budgets, classification. */
export function checkDefinition(
  def: AgentDefinition,
  context: DefinitionContext = {},
): {
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
        const granted =
          a.tools.some(
            (t) =>
              t.server === c.server &&
              (t.tool === c.tool ||
                (t.tool.endsWith('*') && c.tool.startsWith(t.tool.slice(0, -1)))),
          ) || (a.profileGrants ?? []).some((p) => p.server === c.server);
        if (!granted) {
          warnings.push({
            path: `agents.${i}.simulation.responses.${k}.toolCalls.${m}`,
            message: `simulated call to "${c.server}/${c.tool}" is not granted and will be blocked`,
          });
        }
      }),
    );
  });
  checkHandovers(def, context, errors, warnings);
  if (def.mode === 'dark-factory') {
    warnings.push({ path: 'mode', message: `dark-factory mode: ${DARK_FACTORY_NOTICE}` });
  }
  if (Object.keys(def.budget).length === 0) {
    warnings.push({ path: 'budget', message: 'no pipeline budget set; platform defaults apply' });
  }
  return { errors, warnings };
}

/** Parses and validates an `agents.md` source without throwing. */
export function validateAgentSource(
  source: string,
  context: DefinitionContext = {},
): ValidationResult {
  let def: AgentDefinition;
  try {
    def = parseAgentDefinition(source);
  } catch (e) {
    if (e instanceof ValidationError) {
      return { valid: false, definition: null, errors: e.issues, warnings: [] };
    }
    throw e;
  }
  const { errors, warnings } = checkDefinition(def, context);
  return {
    valid: errors.length === 0,
    definition: errors.length === 0 ? def : null,
    errors,
    warnings,
  };
}

/** Parses + validates, throwing {@link ValidationError} on any error. */
export function loadAgentDefinition(
  source: string,
  context: DefinitionContext = {},
): AgentDefinition {
  const result = validateAgentSource(source, context);
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
