import { describe, expect, it } from 'vitest';
import { OaxError, WHEN_LIMITS, parseWhen, whenStepRefs } from '../src/index.js';

function errorOf(src: string): string {
  try {
    parseWhen(src);
  } catch (e) {
    expect(e).toBeInstanceOf(OaxError);
    expect((e as OaxError).code).toBe('when_invalid');
    return (e as Error).message;
  }
  throw new Error(`expected "${src}" to be refused`);
}

describe('parseWhen', () => {
  it('builds an AST with precedence ! > compare > && > ||', () => {
    expect(parseWhen('!event.a || event.b == 1 && exists(steps.x.output.c)')).toEqual({
      type: 'or',
      left: { type: 'not', operand: { type: 'path', root: 'event', segments: ['a'] } },
      right: {
        type: 'and',
        left: {
          type: 'compare',
          op: '==',
          left: { type: 'path', root: 'event', segments: ['b'] },
          right: { type: 'literal', value: 1 },
        },
        right: {
          type: 'exists',
          path: { type: 'path', root: 'step', step: 'x', segments: ['c'] },
        },
      },
    });
  });

  it('parses literals, lists, indexes and parentheses', () => {
    expect(
      parseWhen('event.data.items[2].id in ["a", \'b\', 1, -2.5e1, true, false, null]'),
    ).toEqual({
      type: 'compare',
      op: 'in',
      left: { type: 'path', root: 'event', segments: ['data', 'items', 2, 'id'] },
      right: { type: 'list', items: ['a', 'b', 1, -25, true, false, null] },
    });
    expect(parseWhen('(event.a)')).toEqual({ type: 'path', root: 'event', segments: ['a'] });
    expect(parseWhen('event.a in []')).toMatchObject({ right: { type: 'list', items: [] } });
    expect(parseWhen('"x\\"y" != \'it\\\'s\'')).toMatchObject({
      left: { value: 'x"y' },
      right: { value: "it's" },
    });
    expect(parseWhen('event.n >= 1 && event.n < 10 && event.n <= 9 && event.n > 0')).toBeTruthy();
    expect(parseWhen('event.tags in steps.a.output.allowed')).toMatchObject({
      right: { type: 'path', step: 'a' },
    });
    expect(parseWhen('event.data.in == "x"')).toMatchObject({
      left: { segments: ['data', 'in'] },
    });
  });

  it('lists the step ids a condition reads', () => {
    const ast = parseWhen(
      'steps.b.output.x == 1 || !(exists(steps.a.output.y)) && steps.b.output.z in [1]',
    );
    expect(whenStepRefs(ast)).toEqual(['b', 'a']);
    expect(whenStepRefs(parseWhen('true'))).toEqual([]);
  });

  it.each([
    ['', /empty condition/],
    ['event.a = 1', /unexpected character "="/],
    ['event.a ==', /unexpected end/],
    ['event.a == 1 == true', /cannot be chained/],
    ['event.a in "x"', /needs a list or a path/],
    ['event.a < [1]', /cannot compare with a list/],
    ['[1] in event.a', /right of "in"/],
    ['event.a in [event.b]', /only contain literals/],
    ['event.a in [1, 2', /expected "]"/],
    ['process.env.SECRET', /unknown root "process"/],
    ['steps.x.input.a', /only "steps.<id>.output"/],
    ['steps.X.output', /expected a step id/],
    ['event.__proto__.polluted', /"__proto__" is not allowed/],
    ['event.constructor', /"constructor" is not allowed/],
    ['event.a[-1]', /expected an index/],
    ['event.a[1.5]', /expected an index/],
    ['event.a[10001]', /expected an index/],
    ['event.', /expected a field name/],
    ['exists(1)', /expected a path/],
    ['exists(event.a', /expected "\)"/],
    ['(event.a', /expected "\)"/],
    ['event.a)', /unexpected "\)"/],
    ['"abc', /unterminated string/],
    ['"a\\nb"', /invalid escape/],
    ['1e999 == event.a', /number out of range/],
    ['event.a == $x', /unexpected character "\$"/],
    ['eval("x")', /unknown root "eval"/],
    ['== 1', /unexpected "=="/],
  ])('refuses %j', (src, message) => {
    expect(errorOf(src)).toMatch(message);
  });

  it('enforces the limits', () => {
    expect(errorOf('event.a == 1 && '.repeat(40) + 'true')).toMatch(
      /longer than 512|too many tokens/,
    );
    expect(errorOf(Array(70).fill('true').join('&&'))).toMatch(/too many tokens/);
    expect(errorOf('!'.repeat(17) + 'true')).toMatch(/nesting deeper than 16/);
    expect(errorOf('('.repeat(17) + 'true' + ')'.repeat(17))).toMatch(/nesting deeper than 16/);
    expect(errorOf('event' + '.a'.repeat(17))).toMatch(/longer than 16 segments/);
    expect(errorOf(`event.a in [${Array(33).fill('1').join(',')}]`)).toMatch(
      /longer than 32 items/,
    );
    expect(errorOf(`event.a == "${'x'.repeat(257)}"`)).toMatch(/longer than 256 characters/);
    expect(errorOf('x'.repeat(WHEN_LIMITS.maxLength + 1))).toMatch(/longer than 512 characters/);
  });
});
