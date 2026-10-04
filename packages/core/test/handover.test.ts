import { describe, expect, it } from 'vitest';
import {
  HANDOVER_LIMITS,
  describeViolations,
  stepAuditEntry,
  validateHandover,
} from '../src/index.js';

const named = {
  Finding: {
    type: 'object',
    required: ['severity'],
    additionalProperties: false,
    properties: {
      severity: { enum: ['low', 'high'] },
      tags: { type: 'array', items: { type: 'string' }, maxItems: 3 },
    },
  },
};
const ref = { $ref: '#/schemas/Finding' };

describe('validateHandover', () => {
  it('accepts a valid instance and returns a stable digest', () => {
    const a = validateHandover(ref, named, { severity: 'low' });
    const b = validateHandover(named.Finding, undefined, { severity: 'high' });
    expect(a.ok).toBe(true);
    expect(a.errors).toEqual([]);
    expect(a.schemaDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(b.schemaDigest).toBe(a.schemaDigest);
  });

  it('reports paths and keywords but never values', () => {
    const r = validateHandover(ref, named, {
      severity: 'SECRET-VALUE',
      tags: ['x', 'y', 'z', 'w'],
      extra: 'LEAK',
    });
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.keyword).sort()).toEqual(
      ['additionalProperties', 'enum', 'maxItems'].sort(),
    );
    expect(JSON.stringify(r)).not.toMatch(/SECRET-VALUE|LEAK/);
    expect(describeViolations(r.errors)).toMatch(/\/severity: failed "enum"/);
    expect(describeViolations(r.errors)).not.toMatch(/SECRET-VALUE/);
    expect(describeViolations([{ instancePath: '', keyword: 'type', schemaPath: '#' }])).toBe(
      '- (root): failed "type"',
    );
  });

  it('caps the number of reported errors', () => {
    const schema = { type: 'array', items: { type: 'string' } };
    const r = validateHandover(
      schema,
      {},
      Array.from({ length: 100 }, (_, i) => i),
    );
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(HANDOVER_LIMITS.maxErrors);
  });

  it('is strict about types (no coercion, no defaults)', () => {
    expect(validateHandover({ type: 'number' }, {}, '5').ok).toBe(false);
    expect(validateHandover({ type: 'integer' }, {}, 5.5).ok).toBe(false);
    const d = { type: 'object', properties: { a: { default: 1 } } };
    const inst = {};
    expect(validateHandover(d, {}, inst).ok).toBe(true);
    expect(inst).toEqual({});
  });

  it('supports the documented keywords', () => {
    const s = {
      type: 'object',
      required: ['a'],
      properties: {
        a: { anyOf: [{ type: 'string', minLength: 2, maxLength: 4 }, { const: 7 }] },
        n: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 10 },
        u: { type: 'array', uniqueItems: true, minItems: 1 },
        p: { type: 'string', pattern: '^[a-z]+$', maxLength: 10 },
        t: { type: ['string', 'null'] },
      },
    };
    expect(validateHandover(s, {}, { a: 'abc', n: 5, u: [1, 2], p: 'abc', t: null }).ok).toBe(true);
    expect(validateHandover(s, {}, { a: 7 }).ok).toBe(true);
    expect(validateHandover(s, {}, { a: 'a' }).ok).toBe(false);
    expect(validateHandover(s, {}, { a: 'abc', n: 10 }).ok).toBe(false);
    expect(validateHandover(s, {}, { a: 'abc', u: [1, 1] }).ok).toBe(false);
    expect(validateHandover(s, {}, { a: 'abc', p: 'ABC' }).ok).toBe(false);
  });

  it('compiles every schema shape the publish check accepts (no strictRequired/strictTypes surprises)', () => {
    for (const [schema, good, bad] of [
      [{ type: 'object', required: ['ticket'] }, { ticket: 1 }, {}],
      [{ minimum: 3 }, 5, 1],
      [{ properties: { a: { type: 'string' } } }, { a: 'x' }, { a: 1 }],
      [{ enum: ['a', 1, null] }, 1, 'b'],
      [{ type: ['string', 'null'], maxLength: 2 }, null, 'abc'],
      [{ items: { type: 'number' }, maxItems: 2 }, [1], [1, 2, 3]],
    ] as [unknown, unknown, unknown][]) {
      expect(validateHandover(schema, {}, good).ok, JSON.stringify(schema)).toBe(true);
      expect(validateHandover(schema, {}, bad).ok, JSON.stringify(schema)).toBe(false);
      expect(validateHandover(schema, {}, bad).errors[0]?.keyword).not.toBe('schema');
    }
  });

  it('fails closed on schemas outside the subset (no ajv compile, no remote refs)', () => {
    for (const schema of [
      { $ref: 'https://example.com/schema.json' },
      { $ref: '#/schemas/Missing' },
      { $id: 'x', type: 'string' },
      { if: { type: 'string' }, then: { minLength: 1 } },
      { type: 'string', format: 'email' },
      { patternProperties: { '^a': {} } },
      { type: 'string', pattern: '^(a+)+$', maxLength: 10 },
      { type: 'string', pattern: '^a+$' },
      JSON.parse('{"properties":{"__proto__":{}}}'),
      { type: 'object', required: ['constructor'] },
      { $dynamicRef: '#x' },
    ]) {
      const r = validateHandover(schema, named, 'x');
      expect(r.ok, JSON.stringify(schema)).toBe(false);
      expect(r.errors[0]?.keyword).toBe('schema');
    }
  });

  it('refuses recursive references', () => {
    const rec = { A: { type: 'object', properties: { next: { $ref: '#/schemas/A' } } } };
    expect(validateHandover({ $ref: '#/schemas/A' }, rec, {}).errors[0]?.keyword).toBe('schema');
  });

  it('stops a reference bomb at the node limit', () => {
    const bomb: Record<string, unknown> = { s0: { type: 'string' } };
    for (let i = 1; i < 12; i++) {
      const prev = { $ref: `#/schemas/s${i - 1}` };
      bomb[`s${i}`] = { type: 'array', items: { anyOf: [prev, prev, prev, prev] } };
    }
    const r = validateHandover({ $ref: '#/schemas/s11' }, bomb, []);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.keyword).toBe('schema');
  });

  it('refuses oversize instances without validating them', () => {
    const big = 'x'.repeat(HANDOVER_LIMITS.maxInstanceBytes + 1);
    const r = validateHandover({ type: 'string' }, {}, big);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.keyword).toBe('maxSize');
  });

  it('refuses too deep instances', () => {
    let v: unknown = 1;
    for (let i = 0; i < HANDOVER_LIMITS.maxInstanceDepth + 5; i++) v = { a: v };
    const r = validateHandover({ type: 'object' }, {}, v);
    expect(r.errors[0]?.keyword).toBe('maxDepth');
    let ok: unknown = 1;
    for (let i = 0; i < HANDOVER_LIMITS.maxInstanceDepth - 1; i++) ok = [ok];
    expect(validateHandover({ type: 'array' }, {}, ok).ok).toBe(true);
    let arr: unknown = 1;
    for (let i = 0; i < HANDOVER_LIMITS.maxInstanceDepth + 5; i++) arr = [arr];
    expect(validateHandover({ type: 'array' }, {}, arr).errors[0]?.keyword).toBe('maxDepth');
  });

  it('refuses instances that carry an own __proto__ key and never pollutes', () => {
    const evil = JSON.parse('{"__proto__": {"polluted": true}, "severity": "low"}') as unknown;
    const r = validateHandover(ref, named, evil);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.keyword).toBe('forbiddenKey');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const nested = JSON.parse('{"a":[{"__proto__":{"x":1}}]}') as unknown;
    expect(validateHandover({ type: 'object' }, {}, nested).errors[0]?.keyword).toBe(
      'forbiddenKey',
    );
  });

  it('refuses instances that cannot be serialized', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(validateHandover({}, {}, cyclic).errors[0]?.keyword).toBe('serialize');
    expect(validateHandover({}, {}, 10n).errors[0]?.keyword).toBe('serialize');
  });

  it('is not slowed down by a pattern within the safe subset on a long subject', () => {
    const s = { type: 'string', pattern: '^[a-z]+-[0-9]+$', maxLength: 4096 };
    const started = Date.now();
    const r = validateHandover(s, {}, `${'a'.repeat(4000)}!`);
    expect(r.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('evicts the oldest compiled validator beyond the cache size', () => {
    for (let i = 0; i < HANDOVER_LIMITS.maxCompiled + 5; i++) {
      expect(validateHandover({ const: i }, {}, i).ok).toBe(true);
    }
    expect(validateHandover({ const: 0 }, {}, 0).ok).toBe(true);
  });

  it('treats undefined instances as null', () => {
    expect(validateHandover({ type: 'null' }, {}, undefined).ok).toBe(true);
  });
});

describe('stepAuditEntry', () => {
  it('maps skipped steps and condition errors', () => {
    expect(
      stepAuditEntry({
        kind: 'condition',
        name: 'when',
        status: 'skipped',
        agentId: 'a',
        output: { when: 'x == 1', extra: 'ignored' },
      }),
    ).toEqual({ action: 'step.skipped', payload: { agentId: 'a', when: 'x == 1' } });
    expect(
      stepAuditEntry({
        kind: 'condition',
        name: 'when',
        status: 'error',
        agentId: 'a',
        output: { when: 'x == 1', reason: 'path does not exist' },
      }),
    ).toEqual({
      action: 'condition.error',
      payload: { agentId: 'a', when: 'x == 1', reason: 'path does not exist' },
    });
  });

  it('rebuilds handover payloads from whitelisted fields only (no values)', () => {
    const e = stepAuditEntry({
      kind: 'handover',
      name: 'output',
      status: 'error',
      agentId: 'a',
      output: {
        direction: 'output',
        attempt: 2,
        schemaDigest: 'abc',
        value: 'LEAK',
        errors: [{ instancePath: '/x', keyword: 'enum', schemaPath: '#/enum', params: 'LEAK' }],
      },
    });
    expect(e).toEqual({
      action: 'handover.invalid',
      payload: {
        agentId: 'a',
        direction: 'output',
        attempt: 2,
        schemaDigest: 'abc',
        errors: [{ instancePath: '/x', keyword: 'enum', schemaPath: '#/enum' }],
      },
    });
    expect(JSON.stringify(e)).not.toContain('LEAK');
  });

  it('maps retries, tolerates garbage and ignores other kinds', () => {
    expect(
      stepAuditEntry({ kind: 'handover', name: 'retry', status: 'pending', agentId: 'a' })?.action,
    ).toBe('handover.retry');
    const g = stepAuditEntry({
      kind: 'handover',
      name: 'input',
      status: 'error',
      agentId: null,
      output: { direction: 'input', errors: [1, null, 'x'], attempt: 'z' },
    });
    expect(g?.payload.direction).toBe('input');
    expect(g?.payload.attempt).toBe(1);
    expect(g?.payload.errors).toHaveLength(3);
    const long = stepAuditEntry({
      kind: 'condition',
      name: 'when',
      status: 'skipped',
      agentId: 'a',
      output: { when: 'x'.repeat(2000) },
    });
    expect(String(long?.payload.when).length).toBeLessThanOrEqual(512);
    expect(stepAuditEntry({ kind: 'output', name: 'json', status: 'ok', agentId: 'a' })).toBeNull();
    expect(
      stepAuditEntry({ kind: 'condition', name: 'when', status: 'ok', agentId: 'a' }),
    ).toBeNull();
  });
});
