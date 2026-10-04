import { OaxError } from '../errors.js';
import { WHEN_MAX_LENGTH } from './schema.js';

/**
 * Parser for `agents[].when` conditions (grammar in ADR 0008). It only builds an AST; nothing is
 * evaluated here and there is no `eval`/`Function`. The evaluator (W1-1) walks this AST.
 *
 * ```
 * expr    := or
 * or      := and ( "||" and )*
 * and     := unary ( "&&" unary )*
 * unary   := "!" unary | compare
 * compare := operand ( ( "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" ) operand )?
 * operand := literal | path | list | "exists" "(" path ")" | "(" expr ")"
 * path    := ( "event" | "steps" "." step-id "." "output" ) ( "." name | "[" index "]" )*
 * list    := "[" ( literal ( "," literal )* )? "]"
 * literal := string | number | "true" | "false" | "null"
 * ```
 */

export const WHEN_LIMITS = {
  maxLength: WHEN_MAX_LENGTH,
  maxTokens: 128,
  maxDepth: 16,
  maxPathSegments: 16,
  maxListItems: 32,
  maxStringLength: 256,
  maxIndex: 10_000,
} as const;

export type WhenLiteral = string | number | boolean | null;
export type CompareOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in';

export interface WhenPath {
  type: 'path';
  root: 'event' | 'step';
  /** Step id when `root` is `step` (`steps.<id>.output...`). */
  step?: string;
  /** Segments after `event` or after `steps.<id>.output`. */
  segments: (string | number)[];
}

export type WhenNode =
  | { type: 'literal'; value: WhenLiteral }
  | WhenPath
  | { type: 'list'; items: WhenLiteral[] }
  | { type: 'exists'; path: WhenPath }
  | { type: 'not'; operand: WhenNode }
  | { type: 'and' | 'or'; left: WhenNode; right: WhenNode }
  | { type: 'compare'; op: CompareOp; left: WhenNode; right: WhenNode };

/** Names that could reach object prototypes; refused as path segments. */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'prototype',
  'constructor',
]);

type Token =
  | { t: 'str'; v: string; at: number }
  | { t: 'num'; v: number; at: number }
  | { t: 'name'; v: string; at: number }
  | { t: 'op'; v: string; at: number };

const OPS = ['==', '!=', '<=', '>=', '&&', '||', '<', '>', '!', '(', ')', '[', ']', '.', ','];
const NAME = /[A-Za-z_][A-Za-z0-9_-]*/y;
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const STEP_ID = /^[a-z][a-z0-9-]{0,62}$/;

function fail(message: string, at?: number): never {
  throw new OaxError(
    'when_invalid',
    at === undefined ? message : `${message} (at position ${at + 1})`,
  );
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (tokens.length >= WHEN_LIMITS.maxTokens)
      fail(`too many tokens (max. ${WHEN_LIMITS.maxTokens})`);
    if (c === '"' || c === "'") {
      const start = i;
      let value = '';
      i++;
      for (;;) {
        if (i >= src.length) fail('unterminated string', start);
        const ch = src[i] as string;
        if (ch === c) break;
        if (ch === '\\') {
          const next = src[i + 1];
          if (next !== '\\' && next !== '"' && next !== "'") fail('invalid escape', i);
          value += next;
          i += 2;
          continue;
        }
        value += ch;
        i++;
      }
      i++;
      if (value.length > WHEN_LIMITS.maxStringLength)
        fail(`string longer than ${WHEN_LIMITS.maxStringLength} characters`, start);
      tokens.push({ t: 'str', v: value, at: start });
      continue;
    }
    NUMBER.lastIndex = i;
    const num = /[-\d]/.test(c) ? NUMBER.exec(src) : null;
    if (num) {
      const v = Number(num[0]);
      if (!Number.isFinite(v)) fail('number out of range', i);
      tokens.push({ t: 'num', v, at: i });
      i += num[0].length;
      continue;
    }
    NAME.lastIndex = i;
    const name = NAME.exec(src);
    if (name) {
      tokens.push({ t: 'name', v: name[0], at: i });
      i += name[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) fail(`unexpected character "${c}"`, i);
    tokens.push({ t: 'op', v: op, at: i });
    i += op.length;
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private depth = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): WhenNode {
    if (this.tokens.length === 0) fail('empty condition');
    const node = this.or();
    const rest = this.peek();
    if (rest) fail(`unexpected "${String(rest.v)}"`, rest.at);
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private isOp(v: string): boolean {
    const t = this.peek();
    return t?.t === 'op' && t.v === v;
  }

  private expectOp(v: string): void {
    const t = this.peek();
    if (t?.t !== 'op' || t.v !== v) fail(`expected "${v}"`, t?.at ?? this.tokens.at(-1)?.at ?? 0);
    this.pos++;
  }

  private enter(at: number): void {
    if (++this.depth > WHEN_LIMITS.maxDepth)
      fail(`nesting deeper than ${WHEN_LIMITS.maxDepth}`, at);
  }

  private or(): WhenNode {
    let left = this.and();
    while (this.isOp('||')) {
      this.pos++;
      left = { type: 'or', left, right: this.and() };
    }
    return left;
  }

  private and(): WhenNode {
    let left = this.unary();
    while (this.isOp('&&')) {
      this.pos++;
      left = { type: 'and', left, right: this.unary() };
    }
    return left;
  }

  private unary(): WhenNode {
    const t = this.peek();
    if (t?.t === 'op' && t.v === '!') {
      this.pos++;
      this.enter(t.at);
      const operand = this.unary();
      this.depth--;
      return { type: 'not', operand };
    }
    return this.compare();
  }

  private compare(): WhenNode {
    const left = this.operand();
    const t = this.peek();
    const op =
      t && ((t.t === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.v)) || isName(t, 'in'))
        ? (t.v as CompareOp)
        : null;
    if (!op || !t) return left;
    this.pos++;
    const right = this.operand();
    if (left.type === 'list') fail('a list can only stand on the right of "in"', t.at);
    if (op === 'in') {
      if (right.type !== 'list' && right.type !== 'path')
        fail('"in" needs a list or a path on the right', t.at);
    } else if (right.type === 'list') {
      fail(`"${op}" cannot compare with a list`, t.at);
    }
    const next = this.peek();
    if (
      next &&
      ((next.t === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(next.v)) ||
        isName(next, 'in'))
    ) {
      fail('comparisons cannot be chained; use && or parentheses', next.at);
    }
    return { type: 'compare', op, left, right };
  }

  private operand(): WhenNode {
    const t = this.peek();
    if (!t) fail('unexpected end of condition', this.tokens.at(-1)?.at ?? 0);
    if (t.t === 'str' || t.t === 'num') {
      this.pos++;
      return { type: 'literal', value: t.v };
    }
    if (t.t === 'op' && t.v === '(') {
      this.pos++;
      this.enter(t.at);
      const inner = this.or();
      this.depth--;
      this.expectOp(')');
      return inner;
    }
    if (t.t === 'op' && t.v === '[') return this.list();
    if (t.t === 'name') {
      if (t.v === 'true' || t.v === 'false') {
        this.pos++;
        return { type: 'literal', value: t.v === 'true' };
      }
      if (t.v === 'null') {
        this.pos++;
        return { type: 'literal', value: null };
      }
      if (t.v === 'exists') {
        this.pos++;
        this.expectOp('(');
        const path = this.path();
        this.expectOp(')');
        return { type: 'exists', path };
      }
      return this.path();
    }
    fail(`unexpected "${t.v}"`, t.at);
  }

  private list(): WhenNode {
    const open = this.peek() as Token;
    this.pos++;
    const items: WhenLiteral[] = [];
    if (this.isOp(']')) {
      this.pos++;
      return { type: 'list', items };
    }
    for (;;) {
      const t = this.peek();
      if (t?.t === 'str' || t?.t === 'num') items.push(t.v);
      else if (t && isName(t, 'true')) items.push(true);
      else if (t && isName(t, 'false')) items.push(false);
      else if (t && isName(t, 'null')) items.push(null);
      else fail('lists may only contain literals', t?.at ?? open.at);
      this.pos++;
      if (items.length > WHEN_LIMITS.maxListItems)
        fail(`list longer than ${WHEN_LIMITS.maxListItems} items`, open.at);
      if (this.isOp(',')) {
        this.pos++;
        continue;
      }
      this.expectOp(']');
      return { type: 'list', items };
    }
  }

  private path(): WhenPath {
    const head = this.peek();
    if (head?.t !== 'name') fail('expected a path', head?.at ?? 0);
    this.pos++;
    let node: WhenPath;
    if (head.v === 'event') {
      node = { type: 'path', root: 'event', segments: [] };
    } else if (head.v === 'steps') {
      this.expectOp('.');
      const id = this.peek();
      if (id?.t !== 'name' || !STEP_ID.test(id.v)) fail('expected a step id', id?.at ?? head.at);
      this.pos++;
      this.expectOp('.');
      const out = this.peek();
      if (!out || !isName(out, 'output'))
        fail('only "steps.<id>.output" can be read', out?.at ?? head.at);
      this.pos++;
      node = { type: 'path', root: 'step', step: id.v, segments: [] };
    } else {
      fail(`unknown root "${head.v}" (use "event" or "steps.<id>.output")`, head.at);
    }
    for (;;) {
      if (this.isOp('.')) {
        this.pos++;
        const seg = this.peek();
        if (seg?.t !== 'name') fail('expected a field name', seg?.at ?? head.at);
        if (FORBIDDEN_KEYS.has(seg.v)) fail(`field "${seg.v}" is not allowed`, seg.at);
        node.segments.push(seg.v);
        this.pos++;
      } else if (this.isOp('[')) {
        this.pos++;
        const idx = this.peek();
        if (
          idx?.t !== 'num' ||
          !Number.isInteger(idx.v) ||
          idx.v < 0 ||
          idx.v > WHEN_LIMITS.maxIndex
        ) {
          fail('expected an index (0..10000)', idx?.at ?? head.at);
        }
        node.segments.push(idx.v);
        this.pos++;
        this.expectOp(']');
      } else {
        break;
      }
      if (node.segments.length > WHEN_LIMITS.maxPathSegments)
        fail(`path longer than ${WHEN_LIMITS.maxPathSegments} segments`, head.at);
    }
    return node;
  }
}

function isName(t: Token, v: string): boolean {
  return t.t === 'name' && t.v === v;
}

/** Parses a `when` condition into an AST. Throws `OaxError('when_invalid')`. */
export function parseWhen(source: string): WhenNode {
  if (source.length > WHEN_LIMITS.maxLength)
    fail(`condition longer than ${WHEN_LIMITS.maxLength} characters`);
  return new Parser(tokenize(source)).parse();
}

/** Step ids a condition reads (`steps.<id>.output...`), in order of first use. */
export function whenStepRefs(node: WhenNode): string[] {
  const out = new Set<string>();
  const walk = (n: WhenNode): void => {
    switch (n.type) {
      case 'path':
        if (n.step) out.add(n.step);
        return;
      case 'exists':
        walk(n.path);
        return;
      case 'not':
        walk(n.operand);
        return;
      case 'and':
      case 'or':
      case 'compare':
        walk(n.left);
        walk(n.right);
        return;
      default:
        return;
    }
  };
  walk(node);
  return [...out];
}
