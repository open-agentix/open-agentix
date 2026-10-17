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
/**
 * The cache holds the allowed maximum of one tenant's patterns (policies and a definition) so a warm
 * decision never compiles: total source characters and entries. Measured retained memory is about
 * 130 KB for a 230-character unicode-class pattern, so the characters bound is also a memory bound
 * (roughly 40 MB at the limit).
 */
const CACHE_CHARS_BUDGET = 65_536;
const CACHE_ENTRIES = 1024;

/**
 * Limits on the SOURCE of patterns. Compiling costs about 10 ms and megabytes for a 900-character
 * pattern, so the compile cost of a set of patterns is bounded by the characters written, which is
 * what an author controls: one pattern is at most {@link MAX_PATTERN_SOURCE} characters, the patterns
 * of one definition, manifest, policy bundle or guideline set add up to at most
 * {@link MAX_PATTERN_CHARS}, and a policy or guideline holds at most {@link MAX_POLICY_PATTERNS}.
 * The same limits apply when data is written and when it runs (stored data above them is refused
 * without being compiled).
 */
export const MAX_PATTERN_SOURCE = 256;
export const MAX_PATTERN_CHARS = 8192;
export const MAX_POLICY_PATTERNS = 64;
export const MAX_DEFINITION_PATTERNS = 128;
/** Steps charged to the work budget of a decision per source character of a cold compile. */
export const COMPILE_STEPS_PER_CHAR = 1500;
/** Steps charged per instruction of a compiled program (on top of the per-character charge). */
export const COMPILE_STEPS_PER_INSTRUCTION = 100;
/**
 * Limits over everything that applies to one decision: all enabled policy bundles (platform,
 * tenant, guidelines) together, and the enabled policies one tenant (or the platform) may hold.
 */
export const MAX_BUNDLES = 64;
export const MAX_ALL_POLICY_PATTERNS = 256;
export const MAX_ALL_POLICY_CHARS = 32_768;
export const MAX_ENABLED_POLICIES = 32;
export const MAX_ENABLED_POLICY_PATTERNS = 128;
export const MAX_ENABLED_POLICY_CHARS = 16_384;

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
let cachedChars = 0;

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
  if (source.length <= MAX_PATTERN_SOURCE && repeatBoundsIssue(source) === null) {
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
    if (cachedChars + source.length > CACHE_CHARS_BUDGET || cache.size >= CACHE_ENTRIES) {
      cache.clear();
      cachedChars = 0;
    }
    cache.set(key, compiled);
    cachedChars += source.length;
  }
  return compiled;
}

/** Whether `compileLinear` would answer from the cache (no compile work). */
export function isCachedLinear(source: string, ignoreCase = false): boolean {
  return cache.has(`${ignoreCase ? 'i' : 's'}:${source}`);
}

/** Drops the cache (tests). */
export function resetLinearCache(): void {
  cache.clear();
  cachedChars = 0;
}

/**
 * Limits of a list of bundles (all that applies to one decision, or all enabled policies of a
 * tenant): count, patterns and characters in total. Returns the reason or `null`.
 */
export function bundleSetIssue(
  bundles: readonly { forbiddenArgPatterns: readonly { pattern: string }[] }[],
  limits: { bundles: number; patterns: number; chars: number },
): string | null {
  if (bundles.length > limits.bundles)
    return `at most ${limits.bundles} policies may apply together`;
  let patterns = 0;
  let chars = 0;
  for (const b of bundles)
    for (const f of b.forbiddenArgPatterns) {
      patterns++;
      chars += f.pattern.length;
    }
  if (patterns > limits.patterns) return `at most ${limits.patterns} patterns may apply together`;
  if (chars > limits.chars)
    return `the patterns that apply together are limited to ${limits.chars} characters`;
  return null;
}

/**
 * Whether a set of pattern sources is within the limits (count, characters in total, characters each).
 * Returns the reason or `null`.
 */
export function patternSetIssue(sources: readonly string[], maxCount: number): string | null {
  if (sources.length > maxCount) return `at most ${maxCount} patterns are allowed here`;
  let chars = 0;
  for (const source of sources) {
    if (source.length > MAX_PATTERN_SOURCE)
      return `a pattern is limited to ${MAX_PATTERN_SOURCE} characters`;
    chars += source.length;
  }
  if (chars > MAX_PATTERN_CHARS)
    return `the patterns together are limited to ${MAX_PATTERN_CHARS} characters`;
  return null;
}
