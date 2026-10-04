import { describe, expect, it } from 'vitest';
import { JSON_SCHEMA_LIMITS, checkJsonSchemaSubset } from '../src/index.js';

const msgs = (schema: unknown, named: Record<string, unknown> = {}) =>
  checkJsonSchemaSubset(schema, 's', named).map((i) => `${i.path}: ${i.message}`);

describe('checkJsonSchemaSubset', () => {
  it('accepts the supported keywords', () => {
    expect(
      msgs(
        {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          title: 'T',
          description: 'D',
          type: ['object', 'null'],
          required: ['a'],
          additionalProperties: false,
          properties: {
            a: { type: 'string', minLength: 1, maxLength: 10, pattern: '^[a-z][a-z0-9-]*$' },
            b: { type: 'number', minimum: 0, maximum: 1, exclusiveMinimum: 0, exclusiveMaximum: 2 },
            c: {
              type: 'array',
              items: { type: 'integer' },
              minItems: 0,
              maxItems: 3,
              uniqueItems: true,
            },
            d: { enum: ['x', 1, null] },
            e: { const: 'k' },
            f: { anyOf: [{ type: 'string' }, { type: 'boolean' }] },
            g: true,
            h: { $ref: '#/schemas/Other', description: 'annotations may sit next to $ref' },
          },
        },
        { Other: { type: 'string' } },
      ),
    ).toEqual([]);
  });

  it.each([
    [{ $id: 'x' }, /keyword "\$id" is not supported/],
    [{ $defs: {} }, /keyword "\$defs" is not supported/],
    [{ if: {}, then: {} }, /keyword "if" is not supported/],
    [{ patternProperties: {} }, /keyword "patternProperties"/],
    [{ $schema: 'http://json-schema.org/draft-07/schema#' }, /only "https:\/\/json-schema.org/],
    [{ $ref: 'https://evil.example/x.json' }, /only local references/],
    [{ $ref: '#/$defs/x' }, /only local references/],
    [{ $ref: 1 }, /only local references/],
    [{ $ref: '#/schemas/missing' }, /unknown schema "missing"/],
    [{ $ref: '#/schemas/A', type: 'string' }, /cannot be combined/],
    [{ type: 'date' }, /invalid type/],
    [{ type: [] }, /invalid type/],
    [{ enum: [] }, /enum must be a list/],
    [{ enum: Array(129).fill(1) }, /enum must be a list/],
    [{ minLength: -1 }, /minLength must be a non-negative integer/],
    [{ maxItems: 1.5 }, /maxItems must be a non-negative integer/],
    [{ minimum: 'a' }, /minimum must be a number/],
    [{ uniqueItems: 'yes' }, /uniqueItems must be a boolean/],
    [{ pattern: '(', maxLength: 5 }, /invalid regular expression/],
    [{ pattern: 'a'.repeat(513), maxLength: 5 }, /at most 512 characters/],
    [{ required: 'a' }, /required must be a list/],
    [{ required: ['__proto__'] }, /"__proto__" is not allowed/],
    [{ properties: [] }, /properties must be an object/],
    [{ properties: { constructor: { type: 'string' } } }, /"constructor" is not allowed/],
    [{ anyOf: [] }, /anyOf must be a non-empty list/],
    [{ items: 'string' }, /must be an object or a boolean/],
    [[], /must be an object or a boolean/],
  ])('refuses %j', (schema, message) => {
    expect(msgs(schema, { A: { type: 'string' } }).join('\n')).toMatch(message);
  });

  it.each([
    ['^(a+)+$', /repeat a group that contains a quantifier/],
    // Conservative: also refused although the separator makes it linear in practice.
    ['^[a-z]+(?:-[a-z0-9]+)*$', /repeat a group that contains a quantifier/],
    ['^((ab)*c)+$', /repeat a group that contains a quantifier/],
    ['^(?<x>a*)*$', /repeat a group that contains a quantifier/],
    ['^(a|b)\\1$', /backreferences/],
    ['^(?<x>a)\\k<x>$', /backreferences/],
    ['^(?=a)a$', /lookarounds/],
    ['^(?<!a)b$', /lookarounds/],
  ])('refuses the unsafe pattern %s', (pattern, message) => {
    expect(msgs({ type: 'string', maxLength: 10, pattern }).join()).toMatch(message);
  });

  it.each([
    '^[a-z][a-z0-9-]*$',
    '^(?:ab|cd){1,3}$',
    '^(ab|cd)+$',
    '^[(+*)]+$',
    '^\\(a+\\)+$',
    '^(?<y>[0-9]{4})-x$',
  ])('accepts the safe pattern %s', (pattern) => {
    expect(msgs({ type: 'string', maxLength: 10, pattern })).toEqual([]);
  });

  it('requires a bounded maxLength next to a pattern', () => {
    expect(msgs({ type: 'string', pattern: '^a$' }).join()).toMatch(/needs maxLength <= 4096/);
    expect(msgs({ type: 'string', maxLength: 5000, pattern: '^a$' }).join()).toMatch(
      /needs maxLength/,
    );
  });

  it('refuses a __proto__ property even when it is an own key', () => {
    const schema = JSON.parse('{"properties":{"__proto__":{"type":"string"}}}') as unknown;
    expect(msgs(schema).join()).toMatch(/"__proto__" is not allowed/);
  });

  it('refuses recursive and mutually recursive references', () => {
    expect(msgs({ $ref: '#/schemas/A' }, { A: { items: { $ref: '#/schemas/A' } } }).join()).toMatch(
      /recursive schema reference "A"/,
    );
    expect(
      msgs(
        { $ref: '#/schemas/A' },
        { A: { items: { $ref: '#/schemas/B' } }, B: { $ref: '#/schemas/A' } },
      ).join(),
    ).toMatch(/recursive/);
    expect(msgs({ $ref: '#/schemas/toString' }, {}).join()).toMatch(/unknown schema "toString"/);
  });

  it('bounds depth, node count, breadth and size', () => {
    let deep: unknown = { type: 'string' };
    for (let i = 0; i < 13; i++) deep = { items: deep };
    expect(msgs(deep).join()).toMatch(/nested deeper than 12/);

    // A reference "bomb": every level references the next one twice.
    const named: Record<string, unknown> = { L10: { type: 'string' } };
    for (let i = 9; i >= 0; i--)
      named[`L${i}`] = {
        anyOf: [{ $ref: `#/schemas/L${i + 1}` }, { $ref: `#/schemas/L${i + 1}` }],
      };
    expect(msgs({ $ref: '#/schemas/L0' }, named).join()).toMatch(/more than 512 nodes/);

    const props = Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`p${i}`, true]));
    expect(msgs({ properties: props }).join()).toMatch(/more than 128 properties/);

    const big = { description: 'x'.repeat(JSON_SCHEMA_LIMITS.maxBytes) };
    expect(msgs(big).join()).toMatch(/larger than 32768 bytes/);
  });

  it('reports unserializable input instead of throwing', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(msgs(cyclic)).toEqual(['s: schema is not serializable']);
  });

  it('caps the number of reported issues', () => {
    const props = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`p${i}`, { x: 1 }]));
    expect(msgs({ properties: props }).length).toBeLessThanOrEqual(51);
  });
});
