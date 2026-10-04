import { describe, expect, it } from 'vitest';
import { OaxError, evaluateWhen, evaluateWhenNode, parseWhen } from '../src/index.js';

const scope = {
  event: {
    type: 'ticket.created',
    source: '/jira',
    data: {
      ticket: 'SEC-1',
      n: 3,
      ok: true,
      none: null,
      tags: ['a', 'b'],
      nested: { x: [10, 20] },
    },
  },
  steps: Object.assign(Object.create(null) as Record<string, unknown>, {
    research: { severity: 'high', cvss: 7.5, list: [1, 2, 3] },
    text: 'plain',
  }),
};
const t = (src: string) => evaluateWhen(src, scope);
const err = (src: string): string => {
  try {
    evaluateWhen(src, scope);
  } catch (e) {
    expect(e).toBeInstanceOf(OaxError);
    expect((e as OaxError).code).toBe('condition_error');
    return (e as Error).message;
  }
  throw new Error(`expected a condition_error for: ${src}`);
};

describe('evaluateWhen', () => {
  it('compares scalars by value and type', () => {
    expect(t('event.data.n == 3')).toBe(true);
    expect(t('event.data.n != 4')).toBe(true);
    expect(t('event.data.n == "3"')).toBe(false);
    expect(t('event.data.ticket == "SEC-1"')).toBe(true);
    expect(t("event.data.ticket == 'SEC-1'")).toBe(true);
    expect(t('event.data.ok == true')).toBe(true);
    expect(t('event.data.none == null')).toBe(true);
    expect(t('event.data.ticket == null')).toBe(false);
    expect(t('steps.research.output.severity == "high"')).toBe(true);
  });

  it('orders numbers and strings only', () => {
    expect(t('steps.research.output.cvss >= 7.5')).toBe(true);
    expect(t('steps.research.output.cvss > 7.5')).toBe(false);
    expect(t('steps.research.output.cvss < 8')).toBe(true);
    expect(t('steps.research.output.cvss <= 7')).toBe(false);
    expect(t('"a" < "b"')).toBe(true);
    expect(err('event.data.n < "4"')).toMatch(/two numbers or two strings/);
    expect(err('event.data.ok > false')).toMatch(/two numbers or two strings/);
    expect(err('event.data.none < 1')).toMatch(/two numbers or two strings/);
  });

  it('supports in with list literals and arrays', () => {
    expect(t('steps.research.output.severity in ["high", "critical"]')).toBe(true);
    expect(t('steps.research.output.severity in ["low"]')).toBe(false);
    expect(t('"a" in event.data.tags')).toBe(true);
    expect(t('"z" in event.data.tags')).toBe(false);
    expect(t('2 in steps.research.output.list')).toBe(true);
    expect(t('"2" in steps.research.output.list')).toBe(false);
    expect(t('"x" in []')).toBe(false);
    expect(err('"a" in event.data.ticket')).toMatch(/array on the right/);
    expect(err('event.data.nested in ["a"]')).toMatch(/type object/);
  });

  it('short-circuits && and || and requires booleans', () => {
    expect(t('false && event.data.missing == 1')).toBe(false);
    expect(t('true || event.data.missing == 1')).toBe(true);
    expect(err('true && event.data.missing == 1')).toMatch(/does not exist/);
    expect(err('false || event.data.missing == 1')).toMatch(/does not exist/);
    expect(t('!(event.data.n == 4)')).toBe(true);
    expect(t('event.data.ok')).toBe(true);
    expect(t('!event.data.ok')).toBe(false);
    expect(err('event.data.n && true')).toMatch(/expected a boolean/);
    expect(err('!event.data.n')).toMatch(/expected a boolean/);
    expect(err('event.data.ticket')).toMatch(/expected a boolean but found string/);
    expect(err('true && 1')).toMatch(/expected a boolean/);
  });

  it('has no truthiness or coercion', () => {
    expect(err('1')).toMatch(/expected a boolean but found number/);
    expect(err('"true"')).toMatch(/expected a boolean/);
    expect(err('null')).toMatch(/expected a boolean but found null/);
    expect(err('event.data.none')).toMatch(/found null/);
  });

  it('exists() resolves paths including null and never errors on missing ones', () => {
    expect(t('exists(event.data.ticket)')).toBe(true);
    expect(t('exists(event.data.none)')).toBe(true);
    expect(t('exists(event.data.nope)')).toBe(false);
    expect(t('exists(event.data.ticket.deeper)')).toBe(false);
    expect(t('exists(event.data.tags[1])')).toBe(true);
    expect(t('exists(event.data.tags[2])')).toBe(false);
    expect(t('exists(event.data.nested.x[1])')).toBe(true);
    expect(t('exists(steps.research.output)')).toBe(true);
    expect(t('exists(steps.skipped.output)')).toBe(false);
    expect(t('exists(steps.research.output.nope) || event.data.n == 3')).toBe(true);
    expect(t('!exists(event.data.nope)')).toBe(true);
  });

  it('fails on missing paths and objects/arrays used as operands', () => {
    expect(err('event.data.nope == 1')).toMatch(/path "event\.data\.nope" does not exist/);
    expect(err('steps.skipped.output.x == 1')).toMatch(/steps\.skipped\.output\.x/);
    expect(err('event.data.tags[5] == 1')).toMatch(/does not exist/);
    expect(err('event.data.tags == event.data.tags')).toMatch(/type array/);
    expect(err('event.data.nested == 1')).toMatch(/type object/);
    expect(err('steps.research.output == 1')).toMatch(/type object/);
  });

  it('indexes arrays only with numbers and objects only by name', () => {
    expect(t('event.data.tags[0] == "a"')).toBe(true);
    expect(t('event.data.nested.x[0] == 10')).toBe(true);
    expect(err('event.data.ticket[0] == "S"')).toMatch(/does not exist/);
    expect(err('event.data.tags.length == 2')).toMatch(/does not exist/);
  });

  it('error messages never contain data values', () => {
    const secret = {
      event: { data: { password: 'hunter2-VALUE' } },
      steps: {},
    };
    for (const src of [
      'event.data.password < 1',
      'event.data.password',
      'event.data.password in 3',
    ]) {
      try {
        evaluateWhen(src, secret);
      } catch (e) {
        expect((e as Error).message).not.toContain('hunter2');
      }
    }
  });
});

describe('evaluateWhen is fail closed on hostile input', () => {
  it.each([
    'constructor == 1',
    'process.exit(1)',
    'this.constructor',
    '(() => 1)()',
    'event.data.constructor == 1',
    'event.__proto__.x == 1',
    'event.data.prototype == 1',
    'event["data"] == 1',
    'steps.a.output.__proto__ == 1',
    'steps.a.b == 1',
    'event.data.n == 3 == true',
    '"a" in "abc" in ["x"]',
    '[1] == [1]',
    '1 +',
    '',
    'eval("1")',
    'event.data.ticket.match(/x/)',
    '`x`',
    'a'.repeat(600),
  ])('refuses %s with condition_error', (src) => {
    expect(() => evaluateWhen(src, scope)).toThrow(OaxError);
    try {
      evaluateWhen(src, scope);
    } catch (e) {
      expect((e as OaxError).code).toBe('condition_error');
    }
  });

  it('never reads prototype members even when the data has them', () => {
    const data = JSON.parse('{"__proto__": {"x": 1}, "a": 1}') as unknown;
    const s = { event: { data }, steps: {} };
    expect(evaluateWhen('exists(event.data.a)', s)).toBe(true);
    expect(() => evaluateWhen('event.data.__proto__.x == 1', s)).toThrow(OaxError);
    expect(evaluateWhen('exists(event.data.toString)', s)).toBe(false);
    expect(evaluateWhen('exists(event.data.hasOwnProperty)', s)).toBe(false);
  });

  it('does not see inherited properties of the steps map', () => {
    const s = { event: {}, steps: {} as Record<string, unknown> };
    expect(evaluateWhen('exists(steps.constructor.output)', s)).toBe(false);
    expect(evaluateWhen('exists(steps.valueof.output)', s)).toBe(false);
  });

  it('survives deep nesting within the parser limits and refuses beyond them', () => {
    const ok = `${'('.repeat(10)}true${')'.repeat(10)}`;
    expect(evaluateWhen(ok, scope)).toBe(true);
    const deep = `${'('.repeat(40)}true${')'.repeat(40)}`;
    expect(() => evaluateWhen(deep, scope)).toThrow(OaxError);
    const nots = `${'!'.repeat(40)}true`;
    expect(() => evaluateWhen(nots, scope)).toThrow(OaxError);
  });

  it('evaluates a parsed node directly', () => {
    expect(evaluateWhenNode(parseWhen('event.data.n == 3'), scope)).toBe(true);
  });
});
