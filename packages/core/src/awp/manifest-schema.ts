import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv/dist/2020.js';
import { AWP_SCHEMA } from './generated/awp-schema.js';
import type { ManifestFinding } from './manifest-types.js';

/**
 * Structural validation against the pinned AWP schema (D2: the schema is normative for structure).
 * Same ajv options as the vendored reference checker (`allErrors`, `strict`), same error mapping:
 * code `schema.<keyword>`, JSON Pointer path of the offending node (for a closed object the
 * unknown member is appended). The schema is the generated copy of the vendored file.
 */

const compiled = new WeakMap<object, ValidateFunction>();

/** Compiles (once per schema object) a validator for the root of a schema. */
export function compileSchema(schema: Record<string, unknown>): ValidateFunction {
  const known = compiled.get(schema);
  if (known) return known;
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  const validate = ajv.compile(schema);
  compiled.set(schema, validate);
  return validate;
}

export function pinnedValidator(override?: Record<string, unknown>): ValidateFunction {
  return compileSchema(override ?? AWP_SCHEMA);
}

/** Path of an ajv error as the reference checker reports it. */
export function errorPath(e: ErrorObject): string {
  let p = e.instancePath;
  if (e.keyword === 'additionalProperties')
    p += `/${String(e.params.additionalProperty).replace(/~/g, '~0').replace(/\//g, '~1')}`;
  if (e.keyword === 'propertyNames') p += `/${String(e.params.propertyName)}`;
  return p;
}

/** Findings of the structural layer; empty when the value is structurally valid. */
export function structuralFindings(validate: ValidateFunction, value: unknown): ManifestFinding[] {
  if (validate(value)) return [];
  const out: ManifestFinding[] = [];
  const seen = new Set<string>();
  for (const e of validate.errors ?? []) {
    if (e.keyword === 'if') continue;
    const p = errorPath(e);
    const key = `${e.keyword}|${p}|${e.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const allowed = (e.params as { allowedValues?: unknown[] }).allowedValues;
    out.push({
      severity: 'error',
      code: `schema.${e.keyword}`,
      section: '',
      path: p,
      message: `${e.message}${allowed ? ` (${allowed.join(', ')})` : ''}`,
    });
  }
  return out;
}
