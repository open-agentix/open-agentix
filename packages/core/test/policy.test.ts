import { describe, expect, it } from 'vitest';
import {
  PolicyBundleSchema,
  ToolGrantSchema,
  checkArg,
  evaluateToolCall,
  findGrant,
  globMatch,
  mergeBundles,
  type PolicyContext,
} from '../src/index.js';

const grant = (g: unknown) => ToolGrantSchema.parse(g);

const ctx = (tools: unknown[], extra: Partial<PolicyContext> = {}): PolicyContext => ({
  definition: { classification: 'internal' },
  agent: { id: 'triage', tools: tools.map(grant) },
  ...extra,
});

const lookup = {
  server: 'cve-db',
  tool: 'lookup_cve',
  args: { cveId: { type: 'string', required: true, pattern: '^CVE-\\d{4}-\\d{4,}$' } },
};

describe('globMatch / findGrant', () => {
  it('matches globs literally except *', () => {
    expect(globMatch('*/delete_*', 'tickets/delete_ticket')).toBe(true);
    expect(globMatch('a.b/c', 'aXb/c')).toBe(false);
    expect(globMatch('shell/*', 'shell/exec')).toBe(true);
  });
  it('prefers exact grants over wildcard grants', () => {
    const tools = [
      grant({ server: 's', tool: 'read_*' }),
      grant({ server: 's', tool: 'read_file', approval: 'required' }),
    ];
    expect(findGrant(tools, 's', 'read_file')?.approval).toBe('required');
    expect(findGrant(tools, 's', 'read_dir')?.tool).toBe('read_*');
    expect(findGrant(tools, 's', 'write')).toBeNull();
    expect(findGrant([grant({ server: 's', tool: '*' })], 's', 'anything')).not.toBeNull();
  });
});

describe('evaluateToolCall', () => {
  it('allows a call matching the allowlist and constraints', () => {
    const d = evaluateToolCall(
      { server: 'cve-db', tool: 'lookup_cve', args: { cveId: 'CVE-2024-12345' } },
      ctx([lookup]),
    );
    expect(d).toEqual({
      effect: 'allow',
      reasons: [],
      grant: expect.objectContaining({ tool: 'lookup_cve' }),
    });
  });

  it('denies tools that are not granted', () => {
    const d = evaluateToolCall({ server: 'shell', tool: 'exec', args: {} }, ctx([lookup]));
    expect(d.effect).toBe('deny');
    expect(d.reasons[0]?.code).toBe('tool_not_granted');
    expect(d.grant).toBeNull();
  });

  it('collects argument violations', () => {
    const d = evaluateToolCall(
      { server: 'cve-db', tool: 'lookup_cve', args: { cveId: 'rm -rf /', extra: 1 } },
      ctx([lookup]),
    );
    expect(d.effect).toBe('deny');
    expect(d.reasons.map((r) => r.code).sort()).toEqual(['arg_pattern', 'arg_unknown']);
  });

  it('requires mandatory arguments', () => {
    const d = evaluateToolCall({ server: 'cve-db', tool: 'lookup_cve', args: {} }, ctx([lookup]));
    expect(d.reasons.map((r) => r.code)).toEqual(['arg_missing']);
    const optional = evaluateToolCall(
      { server: 's', tool: 't', args: {} },
      ctx([{ server: 's', tool: 't', args: { a: { type: 'string' } } }]),
    );
    expect(optional.effect).toBe('allow');
  });

  it('allows additional args when configured', () => {
    const d = evaluateToolCall(
      { server: 's', tool: 't', args: { anything: true } },
      ctx([{ server: 's', tool: 't', allowAdditionalArgs: true }]),
    );
    expect(d.effect).toBe('allow');
  });

  it('applies global forbidden tools and argument patterns', () => {
    const bundle = PolicyBundleSchema.parse({
      forbiddenTools: ['*/delete_*'],
      forbiddenArgPatterns: [{ pattern: 'drop\\s+table', reason: 'SQL destruction' }],
    });
    const tools = [{ server: 'db', tool: '*', allowAdditionalArgs: true }];
    const del = evaluateToolCall(
      { server: 'db', tool: 'delete_row', args: {} },
      ctx(tools, { bundles: [bundle] }),
    );
    expect(del.reasons.map((r) => r.code)).toEqual(['tool_forbidden']);
    const sql = evaluateToolCall(
      { server: 'db', tool: 'query', args: { q: { nested: ['DROP  TABLE users'] } } },
      ctx(tools, { bundles: [bundle] }),
    );
    expect(sql.reasons[0]).toEqual({
      code: 'arg_forbidden_pattern',
      message: 'SQL destruction (drop\\s+table)',
    });
    const notGranted = evaluateToolCall(
      { server: 'x', tool: 'delete_all', args: {} },
      ctx([], { bundles: [bundle] }),
    );
    expect(notGranted.reasons.map((r) => r.code)).toEqual(['tool_forbidden', 'tool_not_granted']);
  });

  it('enforces per-run call limits', () => {
    const tools = [{ server: 's', tool: 't', maxCallsPerRun: 2 }];
    const ok = evaluateToolCall(
      { server: 's', tool: 't', args: {} },
      ctx(tools, { callCounts: new Map([['s/t', 1]]) }),
    );
    expect(ok.effect).toBe('allow');
    const over = evaluateToolCall(
      { server: 's', tool: 't', args: {} },
      ctx(tools, { callCounts: new Map([['s/t', 2]]) }),
    );
    expect(over.reasons[0]?.code).toBe('call_limit');
  });

  it('enforces data classification of tools and bundles', () => {
    const c = ctx([{ server: 's', tool: 't', classification: 'public' }], {
      definition: { classification: 'confidential' },
      bundles: [PolicyBundleSchema.parse({ maxClassification: 'internal' })],
    });
    const d = evaluateToolCall({ server: 's', tool: 't', args: {} }, c);
    expect(d.reasons.map((r) => r.code)).toEqual(['classification', 'classification']);
  });

  it('requires approval from the grant or a bundle', () => {
    const byGrant = evaluateToolCall(
      { server: 's', tool: 't', args: {} },
      ctx([{ server: 's', tool: 't', approval: 'required' }]),
    );
    expect(byGrant.effect).toBe('require_approval');
    const byBundle = evaluateToolCall(
      { server: 's', tool: 't', args: {} },
      ctx([{ server: 's', tool: 't' }], {
        bundles: [PolicyBundleSchema.parse({ requireApprovalTools: ['s/*'] })],
      }),
    );
    expect(byBundle.effect).toBe('require_approval');
  });

  it('is deterministic', () => {
    const call = { server: 'cve-db', tool: 'lookup_cve', args: { cveId: 'bad' } };
    expect(evaluateToolCall(call, ctx([lookup]))).toEqual(evaluateToolCall(call, ctx([lookup])));
  });

  it('treats a missing args object as empty', () => {
    const d = evaluateToolCall(
      { server: 's', tool: 't', args: undefined as unknown as Record<string, unknown> },
      ctx([{ server: 's', tool: 't' }]),
    );
    expect(d.effect).toBe('allow');
  });
});

describe('checkArg', () => {
  const codes = (v: unknown, c: object) =>
    checkArg('x', v, { required: false, ...c }).map((r) => r.code);

  it('checks types', () => {
    expect(codes(1, { type: 'number' })).toEqual([]);
    expect(codes(1.5, { type: 'integer' })).toEqual(['arg_type']);
    expect(codes([1], { type: 'array' })).toEqual([]);
    expect(codes(null, { type: 'object' })).toEqual(['arg_type']);
    expect(codes(true, { type: 'boolean' })).toEqual([]);
  });
  it('checks enum, const, length, range, items, deny', () => {
    expect(codes('B', { enum: ['A'] })).toEqual(['arg_enum']);
    expect(codes('A', { const: 'B' })).toEqual(['arg_const']);
    expect(codes('abc', { minLength: 4 })).toEqual(['arg_length']);
    expect(codes('abc', { maxLength: 2 })).toEqual(['arg_length']);
    expect(codes(5, { minimum: 6 })).toEqual(['arg_range']);
    expect(codes(5, { maximum: 4 })).toEqual(['arg_range']);
    expect(codes([1, 2, 3], { maxItems: 2 })).toEqual(['arg_items']);
    expect(codes({ a: ['secret'] }, { deny: ['secr'] })).toEqual(['arg_denied']);
    expect(codes(5, { pattern: '\\d' })).toEqual(['arg_type']);
  });
  it('stops recursing into very deep values', () => {
    let deep: unknown = 'secret';
    for (let i = 0; i < 40; i++) deep = [deep];
    expect(codes(deep, { deny: ['secret'] })).toEqual([]);
  });
});

describe('mergeBundles', () => {
  it('unions rules and keeps the strictest classification', () => {
    const m = mergeBundles([
      PolicyBundleSchema.parse({ forbiddenTools: ['a/*'], maxClassification: 'confidential' }),
      PolicyBundleSchema.parse({ requireApprovalTools: ['b/*'], maxClassification: 'internal' }),
      PolicyBundleSchema.parse({
        forbiddenArgPatterns: [{ pattern: 'x' }],
        maxClassification: 'restricted',
      }),
    ]);
    expect(m.forbiddenTools).toEqual(['a/*']);
    expect(m.requireApprovalTools).toEqual(['b/*']);
    expect(m.forbiddenArgPatterns).toEqual([{ pattern: 'x', reason: 'forbidden argument' }]);
    expect(m.maxClassification).toBe('internal');
  });
});
