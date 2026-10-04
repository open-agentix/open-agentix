import { OaxError } from '../errors.js';
import {
  FORBIDDEN_KEYS,
  parseWhen,
  type WhenLiteral,
  type WhenNode,
  type WhenPath,
} from './when.js';

/**
 * Evaluator for `agents[].when` (ADR 0008, section 1.2). It walks the AST built by `parseWhen`;
 * there is no `eval`, no `Function` and no regular expression on data. Evaluation is strictly
 * typed (no truthiness, no coercion) and fail closed: every problem is an {@link OaxError} with
 * code `condition_error`, never a silent `false`. Error reasons name paths and types, never values.
 */

export interface WhenScope {
  /** The triggering CloudEvent (`event.type`, `event.source`, `event.data...`). */
  event: unknown;
  /** Validated outputs of earlier steps by step id; skipped steps are absent. */
  steps: Readonly<Record<string, unknown>>;
}

/** Marker for "path does not resolve" (distinct from a resolved `null`). */
const MISSING = Symbol('missing');
type Value = unknown | typeof MISSING;

function fail(reason: string): never {
  throw new OaxError('condition_error', reason);
}

function describe(path: WhenPath): string {
  const base = path.root === 'event' ? 'event' : `steps.${path.step}.output`;
  return path.segments.reduce<string>(
    (acc, s) => (typeof s === 'number' ? `${acc}[${s}]` : `${acc}.${s}`),
    base,
  );
}

/** Own-property lookup only; arrays by index, objects by name; never prototypes. */
function step(value: unknown, seg: string | number): Value {
  if (typeof seg === 'number') {
    return Array.isArray(value) && seg < value.length ? (value[seg] as unknown) : MISSING;
  }
  if (FORBIDDEN_KEYS.has(seg)) return MISSING;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return MISSING;
  return Object.hasOwn(value, seg) ? (value as Record<string, unknown>)[seg] : MISSING;
}

function resolve(path: WhenPath, scope: WhenScope): Value {
  let value: Value;
  if (path.root === 'event') {
    value = scope.event;
  } else {
    const id = path.step as string;
    if (!Object.hasOwn(scope.steps, id)) return MISSING;
    value = scope.steps[id];
  }
  for (const seg of path.segments) {
    value = step(value, seg);
    if (value === MISSING) return MISSING;
  }
  return value;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function isScalar(v: unknown): v is WhenLiteral {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

function scalarOf(node: WhenNode, scope: WhenScope): WhenLiteral {
  const v = value(node, scope);
  if (!isScalar(v)) fail(`cannot compare a value of type ${typeOf(v)}; compare a scalar field`);
  return v;
}

function value(node: WhenNode, scope: WhenScope): unknown {
  switch (node.type) {
    case 'literal':
      return node.value;
    case 'path': {
      const v = resolve(node, scope);
      if (v === MISSING) fail(`path "${describe(node)}" does not exist (use exists() to test it)`);
      return v;
    }
    case 'list':
      return node.items;
    default:
      return evaluate(node, scope);
  }
}

function evaluate(node: WhenNode, scope: WhenScope): boolean {
  switch (node.type) {
    case 'exists':
      return resolve(node.path, scope) !== MISSING;
    case 'not': {
      const v = evaluate(node.operand, scope);
      return !v;
    }
    case 'and': {
      if (!evaluate(node.left, scope)) return false;
      return evaluate(node.right, scope);
    }
    case 'or': {
      if (evaluate(node.left, scope)) return true;
      return evaluate(node.right, scope);
    }
    case 'compare':
      return compare(node, scope);
    case 'literal':
    case 'path': {
      const v = value(node, scope);
      if (typeof v !== 'boolean') fail(`expected a boolean but found ${typeOf(v)}`);
      return v;
    }
    case 'list':
      return fail('a list is not a condition');
  }
}

function compare(node: Extract<WhenNode, { type: 'compare' }>, scope: WhenScope): boolean {
  if (node.op === 'in') {
    const left = scalarOf(node.left, scope);
    const right = value(node.right, scope);
    if (!Array.isArray(right)) fail(`"in" needs an array on the right but found ${typeOf(right)}`);
    return right.some((item) => isScalar(item) && item === left);
  }
  const a = scalarOf(node.left, scope);
  const b = scalarOf(node.right, scope);
  if (node.op === '==') return a === b;
  if (node.op === '!=') return a !== b;
  if (typeof a === 'number' && typeof b === 'number') return order(node.op, a, b);
  if (typeof a === 'string' && typeof b === 'string') return order(node.op, a, b);
  return fail(`"${node.op}" needs two numbers or two strings, found ${typeOf(a)} and ${typeOf(b)}`);
}

function order(op: string, a: number | string, b: number | string): boolean {
  switch (op) {
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '>':
      return a > b;
    default:
      return a >= b;
  }
}

/** Evaluates a parsed condition. Throws `OaxError('condition_error')` on any problem. */
export function evaluateWhenNode(node: WhenNode, scope: WhenScope): boolean {
  const result = evaluate(node, scope);
  if (typeof result !== 'boolean') fail('the condition did not produce a boolean');
  return result;
}

/**
 * Parses and evaluates a `when` source string. A parse error is also a `condition_error` (a stored
 * definition that no longer parses must not run unguarded).
 */
export function evaluateWhen(source: string, scope: WhenScope): boolean {
  let node: WhenNode;
  try {
    node = parseWhen(source);
  } catch (e) {
    return fail(`condition does not parse: ${(e as Error).message}`);
  }
  return evaluateWhenNode(node, scope);
}
