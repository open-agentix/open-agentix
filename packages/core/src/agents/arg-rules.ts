import { checkRegexSource } from './regex-safety.js';

/**
 * Static rules for one argument constraint (AEP-0002 section 7.5.5), shared by the `agents.md`
 * validator, the AWP manifest validator (`args` and `x-openagentix-args`) and the exporter, so a
 * constraint is accepted or refused the same way everywhere. The codes are the rule names of the
 * AEP's schema changes.
 */

export type ArgRuleCode =
  'args.pattern-invalid' | 'args.pattern-unbounded' | 'args.type-mismatch' | 'args.range';

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

const isNum = (v: unknown): v is number => typeof v === 'number';

export function argConstraintIssues(c: ArgConstraintLike): ArgRuleIssue[] {
  const out: ArgRuleIssue[] = [];
  const regex = (source: unknown, field: string): void => {
    if (typeof source !== 'string') return;
    const issue = checkRegexSource(source);
    if (issue) out.push({ code: 'args.pattern-invalid', field, message: issue.message });
  };
  if (c.pattern !== undefined) {
    regex(c.pattern, 'pattern');
    // A pattern runs against attacker-influenced text: the length bound is what limits the work.
    if (c.maxLength === undefined)
      out.push({
        code: 'args.pattern-unbounded',
        field: 'pattern',
        message: 'a pattern requires maxLength (it bounds the text the pattern is matched against)',
      });
  }
  if (Array.isArray(c.deny)) c.deny.forEach((d, i) => regex(d, `deny.${i}`));
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
