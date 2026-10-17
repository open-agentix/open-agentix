import { unsafeRegexReason } from './json-schema.js';

/**
 * Static safety rules for the regular expressions of argument constraints (AEP-0002 rule 4,
 * docs/agents-md.md). Patterns are ECMA-262 in Unicode mode, evaluated by the JavaScript engine,
 * which backtracks. The rules keep the cost of one match small:
 *
 * - the source is at most {@link MAX_PATTERN_LENGTH} characters and compiles (`'u'` flag);
 * - the rules of handover schemas apply (`unsafeRegexReason`): no backreferences, no lookaround, no
 *   repeated group that contains a repetition (`(a+)+`);
 * - additionally no repeated group with an alternation (`(a|a)*`, `(a|aa)+`), the other classic
 *   exponential shape.
 *
 * A conservative syntactic check, not a proof of linear time. It is always combined with an input
 * bound: `maxLength` for `pattern` (required), the runtime limit `REGEX_INPUT_LIMIT` for `deny`. The
 * scanner is linear in the pattern and never evaluates it.
 */

export type RegexIssueCode = 'too-long' | 'syntax' | 'unsafe' | 'ambiguous-repetition';

export interface RegexIssue {
  code: RegexIssueCode;
  message: string;
}

/** Longest accepted pattern source (characters). */
export const MAX_PATTERN_LENGTH = 1024;

const BRACE_QUANTIFIER = /^\{(\d+)(?:(,)(\d*))?\}/;

/** Whether a group that contains an alternation is followed by a quantifier that can repeat it. */
function repeatedAlternation(source: string): boolean {
  /** Per open group: does it contain a `|` of its own. */
  const stack: boolean[] = [false];
  let closedWithAlternation = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    let repeats = false;
    if (c === '\\') {
      i++;
    } else if (c === '[') {
      while (i + 1 < source.length && source[i + 1] !== ']') i += source[i + 1] === '\\' ? 2 : 1;
      i++;
    } else if (c === '(') {
      stack.push(false);
      closedWithAlternation = false;
      continue;
    } else if (c === ')') {
      closedWithAlternation = stack.pop() ?? false;
      continue;
    } else if (c === '|') {
      stack[stack.length - 1] = true;
    } else if (c === '*' || c === '+') {
      repeats = true;
    } else if (c === '{') {
      const m = BRACE_QUANTIFIER.exec(source.slice(i, i + 32));
      if (m) {
        repeats = m[2] === ',' ? m[3] === '' || Number(m[3]) > 1 : Number(m[1]) > 1;
        i += m[0].length - 1;
      }
    }
    if (repeats && closedWithAlternation) return true;
    closedWithAlternation = false;
  }
  return false;
}

/** Returns the first problem of `source`, or `null` when it passes every rule. */
export function checkRegexSource(source: string): RegexIssue | null {
  if (source.length > MAX_PATTERN_LENGTH)
    return {
      code: 'too-long',
      message: `a pattern is limited to ${MAX_PATTERN_LENGTH} characters`,
    };
  try {
    new RegExp(source, 'u');
  } catch (e) {
    return { code: 'syntax', message: `invalid regular expression: ${(e as Error).message}` };
  }
  const unsafe = unsafeRegexReason(source);
  if (unsafe) return { code: 'unsafe', message: unsafe };
  if (repeatedAlternation(source))
    return {
      code: 'ambiguous-repetition',
      message: 'pattern must not repeat a group that contains an alternation, such as "(a|b)*"',
    };
  return null;
}
