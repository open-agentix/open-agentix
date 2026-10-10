import { describe, expect, it } from 'vitest';
import { JcsError, jcs } from '../src/index.js';

/** The double with the given IEEE 754 bit pattern (hex), as in RFC 8785 Appendix B. */
const double = (hex: string): number => {
  const b = Buffer.from(hex, 'hex');
  return b.readDoubleBE(0);
};

describe('RFC 8785 test vectors', () => {
  // Appendix B, "ES6 number serialization samples".
  it.each([
    ['0000000000000000', '0'],
    ['8000000000000000', '0'],
    ['0000000000000001', '5e-324'],
    ['8000000000000001', '-5e-324'],
    ['7fefffffffffffff', '1.7976931348623157e+308'],
    ['ffefffffffffffff', '-1.7976931348623157e+308'],
    ['4340000000000000', '9007199254740992'],
    ['c340000000000000', '-9007199254740992'],
    ['4430000000000000', '295147905179352830000'],
    ['44b52d02c7e14af5', '9.999999999999997e+22'],
    ['44b52d02c7e14af6', '1e+23'],
    ['44b52d02c7e14af7', '1.0000000000000001e+23'],
    ['444b1ae4d6e2ef4e', '999999999999999700000'],
    ['444b1ae4d6e2ef4f', '999999999999999900000'],
    ['444b1ae4d6e2ef50', '1e+21'],
    ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
    ['3eb0c6f7a0b5ed8d', '0.000001'],
  ])('serializes the number %s as %s', (hex, expected) => {
    expect(jcs(double(hex))).toBe(expected);
  });

  it('matches the example of section 3.2.2 (numbers, string escapes, literals)', () => {
    const input = JSON.parse(
      '{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],' +
        '"string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",' +
        '"literals": [null, true, false]}',
    );
    expect(jcs(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it('sorts members by UTF-16 code units (section 3.2.3)', () => {
    const input = JSON.parse(
      '{"\\u20ac": "Euro Sign", "\\r": "Carriage Return", "\\ufb33": "Hebrew Letter Dalet With Dagesh",' +
        '"1": "One", "\\ud83d\\ude00": "Emoji: Grinning Face", "\\u0080": "Control",' +
        '"\\u00f6": "Latin Small Letter O With Diaeresis"}',
    );
    // The emoji (surrogate pair D83D DE00) sorts before U+FB33, as the RFC requires.
    expect(jcs(input)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis",' +
        '"€":"Euro Sign","\u{1F600}":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
    );
  });
});

describe('strictness', () => {
  it('does not depend on the key order of the input', () => {
    expect(jcs({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(
      jcs({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 }),
    );
  });

  it('keeps array order and does not add whitespace', () => {
    expect(jcs([3, 1, 2])).toBe('[3,1,2]');
    expect(jcs({ a: [], b: {} })).toBe('{"a":[],"b":{}}');
  });

  it.each([
    ['undefined member', { a: undefined }],
    ['undefined', undefined],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['bigint', 1n],
    ['function', () => 1],
    ['symbol', Symbol('x')],
    ['Date', new Date(0)],
    ['Map', new Map()],
    ['class instance', new (class X {})()],
    ['lone high surrogate', '\ud800'],
    ['lone low surrogate in a key', { '\udc00': 1 }],
    ['sparse array', new Array(3)],
  ])('refuses %s instead of dropping it', (_label, value) => {
    expect(() => jcs(value)).toThrow(JcsError);
  });

  it('refuses nesting deeper than 64 levels', () => {
    let v: unknown = 1;
    for (let i = 0; i < 70; i++) v = [v];
    expect(() => jcs(v)).toThrow(JcsError);
  });

  it('keeps an own "__proto__" member of parsed JSON as data', () => {
    const parsed = JSON.parse('{"__proto__": {"x": 1}, "a": 2}');
    expect(jcs(parsed)).toBe('{"__proto__":{"x":1},"a":2}');
  });

  it('escapes control characters in lower-case hex and leaves U+007F alone', () => {
    expect(jcs('\u0001\u001f\u007f')).toBe('"\\u0001\\u001f\u007f"');
  });
});
