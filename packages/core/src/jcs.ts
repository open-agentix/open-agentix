/**
 * JSON Canonicalization Scheme (RFC 8785).
 *
 * Unlike `canonicalJson` (which audit hashes depend on and which must never change), this
 * serializer follows the RFC to the letter and is strict about its input, because the digest of an
 * MCP tool definition (ADR 0016 section 5) is compared against a value computed by another process
 * and must mean the same thing everywhere:
 *
 * - object members are sorted by the UTF-16 code units of their names (what `<` on strings does),
 * - numbers use the ECMAScript number-to-string conversion (`-0` is `0`), non-finite numbers throw,
 * - strings use the JSON escapes of `JSON.stringify` (lower-case `\u00xx`, no escaping beyond what
 *   the RFC requires); a string with a lone surrogate is not I-JSON and throws,
 * - only the JSON data model is accepted: plain objects, arrays, strings, finite numbers, booleans
 *   and `null`. `undefined`, functions, symbols, bigints, dates and class instances throw instead of
 *   being dropped silently (a dropped member would let two different values share a digest).
 */
export class JcsError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'JcsError';
  }
}

/** Deepest nesting accepted (an untrusted tool schema must not exhaust the stack). */
const MAX_DEPTH = 64;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function checkString(s: string): string {
  // A lone surrogate cannot be encoded as UTF-8 and is rejected by I-JSON (RFC 8785 section 3.2.2.2).
  if (LONE_SURROGATE.test(s)) throw new JcsError('string contains a lone surrogate');
  return JSON.stringify(s);
}

function write(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) throw new JcsError('nesting is too deep');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return checkString(value);
    case 'number':
      if (!Number.isFinite(value)) throw new JcsError('non-finite numbers cannot be canonicalized');
      // ECMAScript Number::toString, as the RFC requires; -0 prints as "0".
      return Object.is(value, -0) ? '0' : String(value);
    case 'object': {
      if (Array.isArray(value)) {
        const items: string[] = [];
        for (let i = 0; i < value.length; i++) {
          if (!(i in value)) throw new JcsError('sparse arrays cannot be canonicalized');
          items.push(write(value[i], depth + 1));
        }
        return `[${items.join(',')}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null)
        throw new JcsError('only plain objects can be canonicalized');
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${keys.map((k) => `${checkString(k)}:${write(obj[k], depth + 1)}`).join(',')}}`;
    }
    default:
      throw new JcsError(`a ${typeof value} cannot be canonicalized`);
  }
}

/** The RFC 8785 canonical form of a JSON value. */
export function jcs(value: unknown): string {
  return write(value, 0);
}
