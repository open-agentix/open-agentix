import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import { canonicalJson, sha256Hex } from '../canonical.js';
import { OaxError } from '../errors.js';
import { checkJsonSchemaSubset, SCHEMA_REF_PREFIX } from './json-schema.js';

/**
 * Runtime validation of typed handovers (ADR 0008, section 1.1). Schemas are in the JSON Schema
 * subset that `checkJsonSchemaSubset` accepts at publish; it is re-checked here so that a stored
 * definition can never reach the validator with keywords, references or sizes outside the subset.
 * Named schemas are resolved inline (the subset guarantees a finite tree), so ajv never resolves a
 * reference and never loads anything. Violations carry paths and keywords, never values.
 */

export const HANDOVER_LIMITS = {
  /** Instances larger than this (serialized) are refused without being handed to ajv. */
  maxInstanceBytes: 256 * 1024,
  maxInstanceDepth: 32,
  /** Reported violations per check. */
  maxErrors: 20,
  /** Compiled validators kept in memory (by schema digest). */
  maxCompiled: 256,
} as const;

export interface HandoverViolation {
  /** JSON pointer into the instance, e.g. `/severity`. */
  instancePath: string;
  /** Failed keyword (`required`, `enum`, ...) or a guard (`maxSize`, `maxDepth`, `schema`, ...). */
  keyword: string;
  /** JSON pointer into the (resolved) schema. */
  schemaPath: string;
}

export interface HandoverCheck {
  ok: boolean;
  /** SHA-256 of the canonical resolved schema (stable per schema, safe to audit). */
  schemaDigest: string;
  errors: HandoverViolation[];
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Replaces `{ $ref: "#/schemas/<name>" }` by the named schema, recursively. */
function inline(schema: unknown, named: Readonly<Record<string, unknown>>): unknown {
  if (!isObject(schema)) return schema;
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.slice(SCHEMA_REF_PREFIX.length);
    return inline(named[name], named);
  }
  const out: Json = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'properties' && isObject(v)) {
      out[k] = Object.fromEntries(Object.entries(v).map(([p, s]) => [p, inline(s, named)]));
    } else if (k === 'additionalProperties' || k === 'items') {
      out[k] = inline(v, named);
    } else if (k === 'anyOf' && Array.isArray(v)) {
      out[k] = v.map((s) => inline(s, named));
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * The schema with every `#/schemas/<name>` reference inlined, for handing it to a run node that
 * does not know the named schemas. Throws `handover_invalid` when the schema is outside the
 * supported subset (so a cyclic or oversize schema never reaches the recursion).
 */
export function resolveSchema(
  schema: unknown,
  named: Readonly<Record<string, unknown>> | undefined,
): unknown {
  const names = named ?? {};
  if (checkJsonSchemaSubset(schema, 'schema', names).length > 0)
    throw new OaxError(
      'handover_invalid',
      'the schema is outside the supported JSON Schema subset',
    );
  return inline(schema, names);
}

/**
 * One shared ajv instance (building one registers the meta-schemas, which is slow); compiled
 * validators are cached by schema digest and evicted oldest-first together with ajv's own cache.
 */
const ajv = new Ajv2020({
  // Strict: unknown keywords, ignored formats and bad numbers are errors. `strictRequired` and
  // `strictTypes` stay off on purpose: everything `checkJsonSchemaSubset` accepts at publish
  // (e.g. the ADR's own `required: [ticket]` without `properties`, or `minimum` without `type`)
  // must compile at runtime too.
  strict: true,
  strictRequired: false,
  strictTypes: false,
  allErrors: true,
  allowUnionTypes: true,
  validateFormats: false,
  logger: false,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  $data: false,
  // No `loadSchema`: remote references cannot be resolved even if one slipped through.
});
const compiled = new Map<string, { fn: ValidateFunction; schema: object }>();

function compile(schemaDigest: string, resolved: unknown): ValidateFunction {
  const hit = compiled.get(schemaDigest);
  if (hit) return hit.fn;
  const schema = resolved as object;
  const fn = ajv.compile(schema);
  if (compiled.size >= HANDOVER_LIMITS.maxCompiled) {
    const oldest = compiled.keys().next().value;
    if (oldest !== undefined) {
      ajv.removeSchema(compiled.get(oldest)?.schema);
      compiled.delete(oldest);
    }
  }
  compiled.set(schemaDigest, { fn, schema });
  return fn;
}

/** Size, depth and key guards on an instance before it goes anywhere near a schema. */
function guardInstance(instance: unknown): HandoverViolation | null {
  const at = (keyword: string): HandoverViolation => ({
    instancePath: '',
    keyword,
    schemaPath: '#',
  });
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(instance) ?? 'null', 'utf8');
  } catch {
    return at('serialize');
  }
  if (bytes > HANDOVER_LIMITS.maxInstanceBytes) return at('maxSize');
  const walk = (v: unknown, depth: number): string | null => {
    if (typeof v !== 'object' || v === null) return null;
    if (depth > HANDOVER_LIMITS.maxInstanceDepth) return 'maxDepth';
    if (Array.isArray(v)) {
      for (const item of v) {
        const r = walk(item, depth + 1);
        if (r) return r;
      }
      return null;
    }
    for (const [k, child] of Object.entries(v)) {
      if (k === '__proto__') return 'forbiddenKey';
      const r = walk(child, depth + 1);
      if (r) return r;
    }
    return null;
  };
  const reason = walk(instance, 1);
  return reason ? at(reason) : null;
}

const clip = (s: string): string => (s.length > 256 ? `${s.slice(0, 253)}...` : s);

/**
 * Validates `instance` against `schema` (inline or `{ $ref }` into `named`). Never throws for bad
 * input: a bad schema, an oversize instance or a violation all yield `ok: false`.
 */
export function validateHandover(
  schema: unknown,
  named: Readonly<Record<string, unknown>> | undefined,
  rawInstance: unknown,
): HandoverCheck {
  const instance = rawInstance === undefined ? null : rawInstance;
  const names = named ?? {};
  const bad = (keyword: string, digest = ''): HandoverCheck => ({
    ok: false,
    schemaDigest: digest,
    errors: [{ instancePath: '', keyword, schemaPath: '#' }],
  });
  if (checkJsonSchemaSubset(schema, 'schema', names).length > 0) return bad('schema');
  const resolved = inline(schema, names);
  let digest: string;
  try {
    digest = sha256Hex(canonicalJson(resolved));
  } catch {
    return bad('schema');
  }
  const guard = guardInstance(instance);
  if (guard) return { ok: false, schemaDigest: digest, errors: [guard] };
  let fn: ValidateFunction;
  try {
    fn = compile(digest, resolved);
  } catch {
    return bad('schema', digest);
  }
  if (fn(instance)) return { ok: true, schemaDigest: digest, errors: [] };
  const errors = (fn.errors ?? []).slice(0, HANDOVER_LIMITS.maxErrors).map((e) => ({
    instancePath: clip(e.instancePath),
    keyword: clip(e.keyword),
    schemaPath: clip(e.schemaPath),
  }));
  return { ok: false, schemaDigest: digest, errors };
}

/** Text for the single retry turn: where and which rule failed, never the offending values. */
export function describeViolations(errors: readonly HandoverViolation[]): string {
  return errors
    .map((e) => `- ${e.instancePath === '' ? '(root)' : e.instancePath}: failed "${e.keyword}"`)
    .join('\n');
}

export interface StepAuditSource {
  kind: string;
  name: string;
  status: string;
  agentId: string | null;
  output?: unknown;
}

function str(v: unknown, max = 512): string {
  return typeof v === 'string' ? (v.length > max ? `${v.slice(0, max - 3)}...` : v) : '';
}

/**
 * Audit entry for the step kinds `condition` and `handover` (`step.skipped`, `condition.error`,
 * `handover.invalid`, `handover.retry`), or `null` for every other step. The payload is rebuilt
 * from whitelisted, size-bounded fields so that no producer, not even a remote worker, can put
 * data values into the audit log through these entries.
 */
export function stepAuditEntry(
  step: StepAuditSource,
): { action: string; payload: Record<string, unknown> } | null {
  const out = isObject(step.output) ? step.output : {};
  if (step.kind === 'condition' && step.status === 'skipped') {
    return {
      action: 'step.skipped',
      payload: { agentId: step.agentId, when: str(out.when) },
    };
  }
  if (step.kind === 'condition' && step.status === 'error') {
    return {
      action: 'condition.error',
      payload: { agentId: step.agentId, when: str(out.when), reason: str(out.reason) },
    };
  }
  if (step.kind === 'handover') {
    const errors = (Array.isArray(out.errors) ? out.errors : [])
      .slice(0, HANDOVER_LIMITS.maxErrors)
      .map((e: unknown) => {
        const o = isObject(e) ? e : {};
        return {
          instancePath: str(o.instancePath, 256),
          keyword: str(o.keyword, 64),
          schemaPath: str(o.schemaPath, 256),
        };
      });
    return {
      action: step.name === 'retry' ? 'handover.retry' : 'handover.invalid',
      payload: {
        agentId: step.agentId,
        direction: out.direction === 'input' ? 'input' : 'output',
        attempt: typeof out.attempt === 'number' ? out.attempt : 1,
        schemaDigest: str(out.schemaDigest, 64),
        errors,
      },
    };
  }
  return null;
}
