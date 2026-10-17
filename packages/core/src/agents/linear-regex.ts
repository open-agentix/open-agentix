import { RE2JS } from 're2js';

/**
 * Linear-time regular expressions for the policy engine (AEP-0002 rule 4 recommends a linear-time
 * engine). Argument constraints (`pattern`, `deny`) and policy-wide `forbiddenArgPatterns` are written
 * by tenants and matched against text chosen by a model or an attacker. The JavaScript engine
 * backtracks, and no syntactic check can rule out every pattern that takes exponential or high
 * polynomial time (`[a-z]*[a-z]*!`, `\d*\d*\d*x`), which would block the shared API process. `re2js`
 * (a pure JavaScript port of RE2, exact version pinned, MIT, no install scripts, no native code)
 * matches in time linear in the input.
 *
 * RE2 syntax is a subset of ECMA-262: no backreferences and no lookaround, which AEP-0002 forbids
 * anyway. A pattern is searched for anywhere in the text (unanchored), like `RegExp.prototype.test`.
 */

/** Largest single repeat bound (`{n,m}`, `m`) and largest sum of repeat bounds in one pattern. */
export const MAX_REPEAT = 200;
export const MAX_REPEAT_SUM = 400;
/** Largest compiled program (instructions of the matcher's NFA). */
export const MAX_PROGRAM_SIZE = 512;
/** Total instructions of all cached programs; the cache is dropped when it would grow beyond this. */
const CACHE_PROGRAM_BUDGET = 8192;

export interface LinearRegex {
  test(text: string): boolean;
  /**
   * Instructions of the compiled program. Matching costs about `text.length * size` steps; the
   * policy engine charges its work budget in these steps, so the time of one decision is bounded.
   */
  size: number;
}

const BRACE = /^\{(\d+)(?:(,)(\d*))?\}/;

/**
 * Cheap check before compiling: the engine is linear in input times program size, and the program
 * grows with every repeat bound (`.{0,999}` is about 2000 instructions, ten of them 20 000), so a
 * pattern with large or many bounded repeats is refused without being compiled (compiling a
 * 1000-character pattern alone takes 350 ms and megabytes).
 */
export function repeatBoundsIssue(source: string): string | null {
  let sum = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === '\\') i++;
    else if (c === '[') {
      while (i + 1 < source.length && source[i + 1] !== ']') i += source[i + 1] === '\\' ? 2 : 1;
      i++;
    } else if (c === '{') {
      const m = BRACE.exec(source.slice(i, i + 32));
      if (!m) continue;
      const n = Number(m[1]);
      const max = m[2] === ',' && m[3] !== '' ? Number(m[3]) : n;
      if (max > MAX_REPEAT || n > MAX_REPEAT)
        return `a repeat bound is limited to ${MAX_REPEAT} ("{n,m}" with n or m above it)`;
      sum += Math.max(n, max);
      if (sum > MAX_REPEAT_SUM)
        return `the repeat bounds of one pattern add up to at most ${MAX_REPEAT_SUM}`;
      i += m[0].length - 1;
    }
  }
  return null;
}

const cache = new Map<string, LinearRegex | null>();
let cachedProgram = 0;

/**
 * Compiles `source`; `null` when the linear-time engine cannot take it, or when it is too large
 * (repeat bounds, program size) or its size cannot be determined (fail closed). Runtime callers
 * cache the result (bounded by total program size); validation passes `useCache: false`.
 */
export function compileLinear(
  source: string,
  ignoreCase = false,
  useCache = true,
): LinearRegex | null {
  const key = `${ignoreCase ? 'i' : 's'}:${source}`;
  if (useCache && cache.has(key)) return cache.get(key) ?? null;
  let compiled: LinearRegex | null = null;
  if (repeatBoundsIssue(source) === null) {
    try {
      const re = RE2JS.compile(source, ignoreCase ? RE2JS.CASE_INSENSITIVE : 0);
      // `re2Input.prog.inst` is internal to re2js (pinned): if it is not there after an upgrade,
      // nothing compiles and everything denies, which a test notices.
      const size = (re as unknown as { re2Input?: { prog?: { inst?: unknown[] } } }).re2Input?.prog
        ?.inst?.length;
      if (typeof size === 'number' && size > 0 && size <= MAX_PROGRAM_SIZE)
        compiled = { test: (text) => re.matcher(text).find(), size };
    } catch {
      compiled = null;
    }
  }
  if (useCache) {
    const add = compiled?.size ?? 1;
    if (cachedProgram + add > CACHE_PROGRAM_BUDGET || cache.size >= 512) {
      cache.clear();
      cachedProgram = 0;
    }
    cache.set(key, compiled);
    cachedProgram += add;
  }
  return compiled;
}
