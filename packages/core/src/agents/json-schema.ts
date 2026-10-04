import type { ValidationIssue } from '../errors.js';
import { FORBIDDEN_KEYS } from './when.js';

/**
 * Publish-time check of handover schemas against the JSON Schema 2020-12 subset of ADR 0008.
 * Unknown keywords are refused (fail closed), `$ref` may only point into the file's own
 * `schemas:` map (`#/schemas/<name>`), and size, depth and breadth are bounded so that the runtime
 * validator (W1-1) always works on small, non-recursive schemas.
 */

export const JSON_SCHEMA_LIMITS = {
  /** Nesting depth of subschemas after `$ref` resolution. */
  maxDepth: 12,
  /** Subschemas per schema after `$ref` resolution. */
  maxNodes: 512,
  /** Serialized size of one schema as written (bytes of JSON). */
  maxBytes: 32 * 1024,
  maxProperties: 128,
  maxEnum: 128,
  maxPatternLength: 512,
  maxNamedSchemas: 32,
  /** A `pattern` needs a `maxLength` of at most this value next to it (bounds regex work). */
  maxPatternSubjectLength: 4096,
} as const;

export const SCHEMA_REF_PREFIX = '#/schemas/';

const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null']);
const ANNOTATIONS = new Set(['title', 'description', 'examples', 'default', '$comment']);
const KEYWORDS = new Set([
  'type',
  'enum',
  'const',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'anyOf',
  '$ref',
  '$schema',
  ...ANNOTATIONS,
]);
const SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonNegInt(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

interface Walk {
  named: Readonly<Record<string, unknown>>;
  errors: ValidationIssue[];
  nodes: number;
  /** `$ref` names currently being resolved (cycle detection). */
  stack: string[];
}

function checkNode(schema: unknown, path: string, depth: number, w: Walk): void {
  if (w.errors.length >= 50) return;
  if (++w.nodes > JSON_SCHEMA_LIMITS.maxNodes) {
    if (w.nodes === JSON_SCHEMA_LIMITS.maxNodes + 1)
      w.errors.push({ path, message: `schema has more than ${JSON_SCHEMA_LIMITS.maxNodes} nodes` });
    return;
  }
  if (depth > JSON_SCHEMA_LIMITS.maxDepth) {
    w.errors.push({ path, message: `schema nested deeper than ${JSON_SCHEMA_LIMITS.maxDepth}` });
    return;
  }
  if (typeof schema === 'boolean') return;
  if (!isPlainObject(schema)) {
    w.errors.push({ path, message: 'a schema must be an object or a boolean' });
    return;
  }
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key))
      w.errors.push({ path: `${path}.${key}`, message: `keyword "${key}" is not supported` });
  }
  const s = schema;
  if (s.$schema !== undefined && s.$schema !== SCHEMA_DIALECT) {
    w.errors.push({ path: `${path}.$schema`, message: `only "${SCHEMA_DIALECT}" is supported` });
  }
  if (s.$ref !== undefined) {
    checkRef(s.$ref, `${path}.$ref`, depth, w);
    const siblings = Object.keys(s).filter((k) => k !== '$ref' && !ANNOTATIONS.has(k));
    if (siblings.length > 0)
      w.errors.push({ path, message: '"$ref" cannot be combined with other keywords' });
    return;
  }
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (types.length === 0 || types.some((t) => typeof t !== 'string' || !TYPES.has(t)))
      w.errors.push({ path: `${path}.type`, message: 'invalid type' });
  }
  if (s.enum !== undefined) {
    if (!Array.isArray(s.enum) || s.enum.length === 0 || s.enum.length > JSON_SCHEMA_LIMITS.maxEnum)
      w.errors.push({
        path: `${path}.enum`,
        message: `enum must be a list of 1..${JSON_SCHEMA_LIMITS.maxEnum} values`,
      });
  }
  for (const k of ['minLength', 'maxLength', 'minItems', 'maxItems'] as const) {
    if (s[k] !== undefined && !isNonNegInt(s[k]))
      w.errors.push({ path: `${path}.${k}`, message: `${k} must be a non-negative integer` });
  }
  for (const k of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'] as const) {
    if (s[k] !== undefined && (typeof s[k] !== 'number' || !Number.isFinite(s[k])))
      w.errors.push({ path: `${path}.${k}`, message: `${k} must be a number` });
  }
  if (s.uniqueItems !== undefined && typeof s.uniqueItems !== 'boolean')
    w.errors.push({ path: `${path}.uniqueItems`, message: 'uniqueItems must be a boolean' });
  if (s.pattern !== undefined) {
    if (typeof s.pattern !== 'string' || s.pattern.length > JSON_SCHEMA_LIMITS.maxPatternLength) {
      w.errors.push({
        path: `${path}.pattern`,
        message: `pattern must be a string of at most ${JSON_SCHEMA_LIMITS.maxPatternLength} characters`,
      });
    } else {
      try {
        new RegExp(s.pattern, 'u');
        const unsafe = unsafeRegexReason(s.pattern);
        if (unsafe) w.errors.push({ path: `${path}.pattern`, message: unsafe });
      } catch (e) {
        w.errors.push({
          path: `${path}.pattern`,
          message: `invalid regular expression: ${(e as Error).message}`,
        });
      }
    }
    const max = s.maxLength;
    if (typeof max !== 'number' || max > JSON_SCHEMA_LIMITS.maxPatternSubjectLength)
      w.errors.push({
        path: `${path}.pattern`,
        message: `pattern needs maxLength <= ${JSON_SCHEMA_LIMITS.maxPatternSubjectLength} in the same schema`,
      });
  }
  if (s.required !== undefined) {
    if (!Array.isArray(s.required) || s.required.some((r) => typeof r !== 'string')) {
      w.errors.push({ path: `${path}.required`, message: 'required must be a list of names' });
    } else {
      for (const r of s.required as string[])
        if (FORBIDDEN_KEYS.has(r))
          w.errors.push({ path: `${path}.required`, message: `property "${r}" is not allowed` });
    }
  }
  if (s.properties !== undefined) {
    if (!isPlainObject(s.properties)) {
      w.errors.push({ path: `${path}.properties`, message: 'properties must be an object' });
    } else {
      const names = Object.keys(s.properties);
      if (names.length > JSON_SCHEMA_LIMITS.maxProperties)
        w.errors.push({
          path: `${path}.properties`,
          message: `more than ${JSON_SCHEMA_LIMITS.maxProperties} properties`,
        });
      for (const name of names) {
        if (FORBIDDEN_KEYS.has(name)) {
          w.errors.push({
            path: `${path}.properties`,
            message: `property "${name}" is not allowed`,
          });
          continue;
        }
        checkNode(s.properties[name], `${path}.properties.${name}`, depth + 1, w);
      }
    }
  }
  if (s.additionalProperties !== undefined)
    checkNode(s.additionalProperties, `${path}.additionalProperties`, depth + 1, w);
  if (s.items !== undefined) checkNode(s.items, `${path}.items`, depth + 1, w);
  if (s.anyOf !== undefined) {
    if (!Array.isArray(s.anyOf) || s.anyOf.length === 0) {
      w.errors.push({ path: `${path}.anyOf`, message: 'anyOf must be a non-empty list' });
    } else {
      s.anyOf.forEach((sub, i) => checkNode(sub, `${path}.anyOf.${i}`, depth + 1, w));
    }
  }
}

/**
 * Conservative static check against catastrophic backtracking: refuses backreferences,
 * lookarounds and quantified groups that contain a quantifier themselves (star height > 1).
 * Returns the reason or `null` when the pattern is in the safe subset.
 */
export function unsafeRegexReason(pattern: string): string | null {
  if (/\\[1-9]|\\k</.test(pattern)) return 'pattern must not use backreferences';
  if (/\(\?<?[=!]/.test(pattern)) return 'pattern must not use lookarounds';
  const groups: boolean[] = [];
  let lastGroupHadQuantifier = false;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      i++;
      lastGroupHadQuantifier = false;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    const isQuantifier = c === '*' || c === '+' || c === '?' || c === '{';
    if (isQuantifier && lastGroupHadQuantifier)
      return 'pattern must not repeat a group that contains a quantifier';
    lastGroupHadQuantifier = false;
    if (c === '[') inClass = true;
    else if (c === '(') {
      groups.push(false);
      // Skip the group modifier of `(?:...)` and `(?<name>...)` so it is not read as a quantifier.
      if (pattern[i + 1] === '?') {
        const end = pattern[i + 2] === '<' ? pattern.indexOf('>', i) : i + 2;
        i = end < 0 ? pattern.length : end;
      }
    } else if (c === ')') lastGroupHadQuantifier = groups.pop() ?? false;
    else if (isQuantifier && groups.length > 0) groups[groups.length - 1] = true;
    if (c === ')' && lastGroupHadQuantifier && groups.length > 0) groups[groups.length - 1] = true;
  }
  return null;
}

function checkRef(ref: unknown, path: string, depth: number, w: Walk): void {
  if (typeof ref !== 'string' || !ref.startsWith(SCHEMA_REF_PREFIX)) {
    w.errors.push({
      path,
      message: `only local references "${SCHEMA_REF_PREFIX}<name>" are allowed`,
    });
    return;
  }
  const name = ref.slice(SCHEMA_REF_PREFIX.length);
  if (!Object.hasOwn(w.named, name)) {
    w.errors.push({ path, message: `unknown schema "${name}"` });
    return;
  }
  if (w.stack.includes(name)) {
    w.errors.push({ path, message: `recursive schema reference "${name}"` });
    return;
  }
  w.stack.push(name);
  checkNode(w.named[name], path, depth, w);
  w.stack.pop();
}

/**
 * Checks one schema (inline or `{ $ref }`) against the subset and limits, resolving references
 * into `named` (the file's `schemas:` map). Returns issues; an empty list means accepted.
 */
export function checkJsonSchemaSubset(
  schema: unknown,
  path: string,
  named: Readonly<Record<string, unknown>> = {},
): ValidationIssue[] {
  const w: Walk = { named, errors: [], nodes: 0, stack: [] };
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(schema) ?? '', 'utf8');
  } catch {
    return [{ path, message: 'schema is not serializable' }];
  }
  if (size > JSON_SCHEMA_LIMITS.maxBytes) {
    return [{ path, message: `schema larger than ${JSON_SCHEMA_LIMITS.maxBytes} bytes` }];
  }
  checkNode(schema, path, 0, w);
  return w.errors;
}
