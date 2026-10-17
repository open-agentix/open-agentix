import {
  parseWhen,
  WhenError,
  type WhenLiteral,
  type WhenNode,
  type WhenPath,
} from '../agents/when.js';

/**
 * Conditions in AWP manifests (AEP-0001, draft: not part of `v1alpha1`, not accepted).
 *
 * `agents.md` conditions read `event` and `steps.<id>.output`; the AEP grammar reads
 * `inputs.<name>`, `steps.<id>.outputs.<name>`, `event` and `execution.environment`. The exporter
 * therefore rewrites the parsed condition (never the text) into the AEP grammar and prints it again;
 * what it cannot map is refused with a reason instead of being written with another meaning.
 *
 * Nothing here evaluates a condition. The product evaluates `agents.md` conditions in
 * `agents/conditions.ts`; this module only translates and checks the manifest form.
 */

export type AwpWhenResult = { ok: true; expression: string } | { ok: false; reason: string };

/** The declared output the exported steps use for their text or JSON result. */
export const EXPORTED_OUTPUT = 'result';
/** The declared input that carries the payload of the triggering event. */
export const EXPORTED_EVENT_INPUT = 'event';

const PREC = { or: 1, and: 2, not: 3, compare: 4, leaf: 5 } as const;

class Unmappable extends Error {}

function printPath(path: WhenPath, hasEvent: boolean): string {
  const tail = (segments: readonly (string | number)[]): string =>
    segments.map((s) => (typeof s === 'number' ? `[${s}]` : `.${s}`)).join('');
  if (path.root === 'step')
    return `steps.${path.step as string}.outputs.${EXPORTED_OUTPUT}${tail(path.segments)}`;
  if (path.root === 'event') {
    // The exported workflow hands over `event.data` as the input `event`; type, source and the other
    // CloudEvent attributes are not available to an AWP step.
    if (!hasEvent)
      throw new Unmappable('the pipeline has no event trigger, so there is no event payload input');
    if (path.segments[0] !== 'data')
      throw new Unmappable('only event.data can be mapped (the payload is the input "event")');
    return `inputs.${EXPORTED_EVENT_INPUT}${tail(path.segments.slice(1))}`;
  }
  throw new Unmappable('unexpected root');
}

const precOf = (n: WhenNode): number =>
  n.type === 'or'
    ? PREC.or
    : n.type === 'and'
      ? PREC.and
      : n.type === 'not'
        ? PREC.not
        : n.type === 'compare'
          ? PREC.compare
          : PREC.leaf;

function literal(v: WhenLiteral): string {
  return JSON.stringify(v);
}

/** Prints the AST in the AEP grammar with the fewest parentheses that keep its shape. */
function print(node: WhenNode, hasEvent: boolean, min: number): string {
  const wrap = (s: string): string => (precOf(node) < min ? `(${s})` : s);
  switch (node.type) {
    case 'literal':
      return literal(node.value);
    case 'path':
      return printPath(node, hasEvent);
    case 'list':
      return `[${node.items.map(literal).join(', ')}]`;
    case 'exists':
      return `exists(${printPath(node.path, hasEvent)})`;
    case 'not':
      return wrap(`!${print(node.operand, hasEvent, PREC.not)}`);
    case 'or':
      return wrap(
        `${print(node.left, hasEvent, PREC.or)} || ${print(node.right, hasEvent, PREC.and)}`,
      );
    case 'and':
      return wrap(
        `${print(node.left, hasEvent, PREC.and)} && ${print(node.right, hasEvent, PREC.not)}`,
      );
    case 'compare':
      return wrap(
        `${print(node.left, hasEvent, PREC.leaf)} ${node.op} ${print(node.right, hasEvent, PREC.leaf)}`,
      );
  }
}

/**
 * Translates an `agents.md` condition into the AEP-0001 grammar. `hasEvent` tells whether the
 * exported workflow declares the input `event` (an event trigger). The result is parsed again with
 * the AEP parser, so a condition that would exceed an AEP limit after the rewrite is refused here.
 */
export function toAwpWhen(source: string, hasEvent: boolean): AwpWhenResult {
  let node: WhenNode;
  try {
    node = parseWhen(source);
  } catch (e) {
    return { ok: false, reason: `the condition does not parse: ${(e as Error).message}` };
  }
  let expression: string;
  try {
    expression = print(node, hasEvent, 0);
  } catch (e) {
    if (e instanceof Unmappable) return { ok: false, reason: e.message };
    throw e;
  }
  try {
    parseWhen(expression, 'awp');
  } catch (e) {
    if (!(e instanceof WhenError)) throw e;
    return { ok: false, reason: `the condition exceeds an AWP limit after mapping: ${e.message}` };
  }
  return { ok: true, expression };
}
