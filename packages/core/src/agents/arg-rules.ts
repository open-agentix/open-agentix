import { checkRegexSource } from './regex-safety.js';

/**
 * Static rules for one argument constraint (AEP-0002 section 7.5.5), shared by the `agents.md`
 * validator, the AWP manifest validator (`args` and `x-openagentix-args`) and the exporter, so a
 * constraint is accepted or refused the same way everywhere. The codes are the rule names of the
 * AEP's schema changes.
 */

export type ArgRuleCode =
  | 'args.pattern-invalid'
  | 'args.pattern-unbounded'
  | 'args.type-mismatch'
  | 'args.range'
  | 'args.limit';

export interface ArgRuleIssue {
  code: ArgRuleCode;
  /** Member of the constraint the issue belongs to (`pattern`, `deny.1`, ...); `''` = the constraint. */
  field: string;
  message: string;
}

/** The members a rule looks at (a superset check: unknown members are the schema's business). */
export interface ArgConstraintLike {
  type?: unknown;
  pattern?: unknown;
  deny?: unknown;
  minLength?: unknown;
  maxLength?: unknown;
  minimum?: unknown;
  maximum?: unknown;
  maxItems?: unknown;
}

/** Longest `maxLength` that bounds a `pattern` or `deny` (AEP-0002: the text a pattern sees is bounded). */
export const MAX_PATTERN_SUBJECT_LENGTH = 4096;
/** Most `deny` patterns on one argument. */
export const MAX_DENY_PATTERNS = 64;

/**
 * `.` and `\\s` mean something else in the linear-time matcher (RE2) than in ECMA-262: `.` also
 * matches CR and the Unicode line separators, `\\s` does not match no-break space or vertical tab.
 * A `deny` rule written with them misses variants (`rm\\s+-rf` with a no-break space), so `deny`
 * patterns spell the characters out (`[ \\t\\r\\n\\f\\x0b\\x{a0}]`, `[^\\n]`).
 */
export function usesDotOrSpaceClass(source: string): boolean {
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === '\\') {
      if (source[i + 1] === 's' || source[i + 1] === 'S') return true;
      i++;
    } else if (c === '[') {
      for (i++; i < source.length && source[i] !== ']'; i++)
        if (source[i] === '\\') {
          if (source[i + 1] === 's' || source[i + 1] === 'S') return true;
          i++;
        }
    } else if (c === '.') return true;
  }
  return false;
}

const isNum = (v: unknown): v is number => typeof v === 'number';

export function argConstraintIssues(c: ArgConstraintLike): ArgRuleIssue[] {
  const out: ArgRuleIssue[] = [];
  const regex = (source: unknown, field: string): void => {
    if (typeof source !== 'string') return;
    const issue = checkRegexSource(source);
    if (issue) out.push({ code: 'args.pattern-invalid', field, message: issue.message });
  };
  const bounded = isNum(c.maxLength) && c.maxLength <= MAX_PATTERN_SUBJECT_LENGTH;
  if (c.pattern !== undefined) {
    regex(c.pattern, 'pattern');
    // A pattern runs against attacker-influenced text: the length bound limits the work.
    if (!bounded)
      out.push({
        code: 'args.pattern-unbounded',
        field: 'pattern',
        message: `a pattern requires maxLength of at most ${MAX_PATTERN_SUBJECT_LENGTH} (it bounds the text the pattern is matched against)`,
      });
  }
  if (Array.isArray(c.deny)) {
    if (c.deny.length > MAX_DENY_PATTERNS)
      out.push({
        code: 'args.limit',
        field: 'deny',
        message: `at most ${MAX_DENY_PATTERNS} deny patterns per argument`,
      });
    if (c.deny.length > 0 && !bounded)
      out.push({
        code: 'args.pattern-unbounded',
        field: 'deny',
        message: `deny patterns require maxLength of at most ${MAX_PATTERN_SUBJECT_LENGTH} (they run against the value)`,
      });
    c.deny.slice(0, MAX_DENY_PATTERNS).forEach((d, i) => {
      regex(d, `deny.${i}`);
      if (typeof d === 'string' && usesDotOrSpaceClass(d))
        out.push({
          code: 'args.pattern-invalid',
          field: `deny.${i}`,
          message:
            'deny patterns must not use "." or "\\s" (they match other characters than in ECMA-262): ' +
            'spell them out, for example [^\\n] or [ \\t\\r\\n\\f\\x0b\\x{a0}]',
        });
    });
  }
  const numericOnly = c.minimum !== undefined || c.maximum !== undefined;
  const stringOnly =
    c.pattern !== undefined || c.minLength !== undefined || c.maxLength !== undefined;
  const type = c.type;
  if (numericOnly && type !== undefined && type !== 'number' && type !== 'integer')
    out.push({
      code: 'args.type-mismatch',
      field: '',
      message: 'minimum/maximum require type number or integer',
    });
  if (stringOnly && type !== undefined && type !== 'string')
    out.push({
      code: 'args.type-mismatch',
      field: '',
      message: 'pattern/minLength/maxLength require type string',
    });
  if (c.maxItems !== undefined && type !== undefined && type !== 'array')
    out.push({ code: 'args.type-mismatch', field: '', message: 'maxItems requires type array' });
  if (isNum(c.minimum) && isNum(c.maximum) && c.minimum > c.maximum)
    out.push({ code: 'args.range', field: '', message: 'minimum is greater than maximum' });
  if (isNum(c.minLength) && isNum(c.maxLength) && c.minLength > c.maxLength)
    out.push({ code: 'args.range', field: '', message: 'minLength is greater than maxLength' });
  return out;
}
