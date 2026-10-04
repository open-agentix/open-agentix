import { MODEL_PROXY_LIMITS } from '@openagentix/providers';

/** Raised for a body the model proxy refuses to parse; the message never contains body content. */
export class StrictJsonError extends Error {
  constructor(
    readonly reason: 'syntax' | 'duplicate_key' | 'forbidden_key' | 'too_deep',
    message: string,
  ) {
    super(message);
  }
}

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Strict JSON parser for bodies from untrusted run nodes (ADR 0009 section 6.1): refuses duplicate
 * keys (two readers could otherwise see different values), prototype-polluting keys and nesting
 * deeper than `maxDepth`. Objects are plain; numbers, strings and literals follow RFC 8259.
 * Error messages carry the byte offset only, never any part of the text.
 */
export function parseStrictJson(
  text: string,
  maxDepth: number = MODEL_PROXY_LIMITS.maxJsonDepth,
): unknown {
  let i = 0;
  const fail = (reason: StrictJsonError['reason'], what: string): never => {
    throw new StrictJsonError(reason, `${what} at offset ${i}`);
  };
  const ws = () => {
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
  };
  const string = (): string => {
    // Delegate escapes and control-character rules to JSON.parse on the exact token.
    const start = i;
    i++;
    for (;;) {
      if (i >= text.length) return fail('syntax', 'unterminated string');
      const c = text.charCodeAt(i);
      if (c === 0x22) break;
      if (c === 0x5c) i++;
      i++;
    }
    i++;
    try {
      return JSON.parse(text.slice(start, i)) as string;
    } catch {
      i = start;
      return fail('syntax', 'invalid string');
    }
  };
  const value = (depth: number): unknown => {
    if (depth > maxDepth) return fail('too_deep', 'nesting is too deep');
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const obj: Record<string, unknown> = {};
      const seen = new Set<string>();
      ws();
      if (text[i] === '}') {
        i++;
        return obj;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') return fail('syntax', 'expected a key');
        const key = string();
        if (FORBIDDEN.has(key)) return fail('forbidden_key', 'forbidden key');
        if (seen.has(key)) return fail('duplicate_key', 'duplicate key');
        seen.add(key);
        ws();
        if (text[i] !== ':') return fail('syntax', 'expected ":"');
        i++;
        obj[key] = value(depth + 1);
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return obj;
        }
        return fail('syntax', 'expected "," or "}"');
      }
    }
    if (c === '[') {
      i++;
      const arr: unknown[] = [];
      ws();
      if (text[i] === ']') {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(value(depth + 1));
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return arr;
        }
        return fail('syntax', 'expected "," or "]"');
      }
    }
    if (c === '"') return string();
    const lit = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      text.slice(i, i + 64),
    );
    if (!lit) return fail('syntax', 'unexpected token');
    i += lit[0].length;
    return JSON.parse(lit[0]) as unknown;
  };
  ws();
  const out = value(0);
  ws();
  if (i < text.length) fail('syntax', 'unexpected trailing data');
  return out;
}
