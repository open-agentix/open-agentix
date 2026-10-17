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

export interface LinearRegex {
  test(text: string): boolean;
}

const cache = new Map<string, LinearRegex | null>();

/** Compiles `source` (cached); `null` when the linear-time engine cannot take it. */
export function compileLinear(source: string, ignoreCase = false): LinearRegex | null {
  const key = `${ignoreCase ? 'i' : 's'}:${source}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  let compiled: LinearRegex | null;
  try {
    const re = RE2JS.compile(source, ignoreCase ? RE2JS.CASE_INSENSITIVE : 0);
    compiled = { test: (text) => re.matcher(text).find() };
  } catch {
    compiled = null;
  }
  if (cache.size >= 512) cache.clear();
  cache.set(key, compiled);
  return compiled;
}
