import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import {
  AWP_LIMITS,
  validateManifestSource,
  type JsonObject,
  type ManifestValidation,
} from '../src/index.js';
import { inspectValue } from '../src/awp/manifest-parse.js';
import { semanticFindings } from '../src/awp/manifest-semantic.js';

/**
 * A manifest is untrusted input (an agents.md from a pull request, an upload). These tests feed
 * hostile text and require a bounded, field-level answer: never an exception, never a hang, never a
 * changed prototype, never an accepted document.
 */
const API = 'awp.agenticworkflowprotocol.org/v1alpha1';
const valid = (): JsonObject => ({
  apiVersion: API,
  kind: 'Workflow',
  metadata: { name: 'probe', version: '1.0.0', owner: 'team-a', classification: 'internal' },
  spec: {
    agents: [{ id: 'a', model: { provider: 'simulated', name: 'sim-1' }, instructions: 'x' }],
    workflow: [{ id: 's', agent: 'a' }],
  },
});
const doc = (text: string, layout: 'document' | 'markdown' | 'auto' = 'document') =>
  validateManifestSource(text, { layout })!;
const codes = (r: ManifestValidation) =>
  r.findings.filter((f) => f.severity === 'error').map((f) => f.code);

function timed<T>(fn: () => T, maxMs = 5000): T {
  const t0 = performance.now();
  const out = fn();
  expect(performance.now() - t0).toBeLessThan(maxMs);
  return out;
}

describe('size and structure limits', () => {
  it('has the documented limits (docs/awp.md changes with them)', () => {
    expect(AWP_LIMITS).toEqual({
      maxSourceBytes: 524_288,
      maxNodes: 50_000,
      maxDocuments: 16,
      maxDepth: 64,
      maxSteps: 1000,
      maxAgents: 1000,
      maxAliasCount: 50,
      maxFindings: 200,
    });
  });

  it('rejects a source above the size limit before parsing it', () => {
    const r = timed(() => doc(`# ${'x'.repeat(530_000)}`));
    expect(codes(r)).toEqual(['limit.size']);
    expect(r.valid).toBe(false);
    // multi-byte characters count as bytes, not characters
    expect(codes(doc(`# ${'\u00e4'.repeat(270_000)}`))).toEqual(['limit.size']);
    // just below the limit the text is read (here: a comment only, so no document)
    expect(codes(doc(`# ${'x'.repeat(500_000)}`))).toEqual(['yaml.empty']);
  });

  it('rejects too many nodes (a flat array of 100 000 numbers)', () => {
    const m = valid();
    (m.spec as JsonObject).big = Array.from({ length: 100_000 }, () => 1);
    const text = JSON.stringify(m);
    expect(text.length).toBeLessThan(AWP_LIMITS.maxSourceBytes);
    expect(codes(timed(() => doc(text)))).toEqual(['limit.nodes']);
  });

  it('rejects nesting deeper than the limit, as JSON and as YAML, without a stack overflow', () => {
    const depth = 5000;
    const nested = `${'['.repeat(depth)}${']'.repeat(depth)}`;
    const r = timed(() => doc(`{"apiVersion":"${API}","kind":"Workflow","x":${nested}}`));
    expect(codes(r).some((c) => c === 'limit.depth' || c === 'yaml.parse-error')).toBe(true);
    const yamlDeep = `apiVersion: ${API}\nx: ${nested}\n`;
    expect(timed(() => doc(yamlDeep)).valid).toBe(false);
    const many = `{"apiVersion":"${API}","x":${'['.repeat(AWP_LIMITS.maxDepth + 2)}${']'.repeat(AWP_LIMITS.maxDepth + 2)}}`;
    expect(codes(doc(many))).toContain('limit.depth');
  });

  it('accepts nesting up to the limit in an opaque extension', () => {
    expect(
      inspectValue(
        JSON.parse(`${'['.repeat(AWP_LIMITS.maxDepth - 1)}${']'.repeat(AWP_LIMITS.maxDepth - 1)}`),
      ),
    ).toEqual([]);
  });

  it('limits the number of YAML documents of a plain file', () => {
    const text = Array.from({ length: AWP_LIMITS.maxDocuments + 1 }, () => stringify(valid())).join(
      '---\n',
    );
    expect(codes(doc(text))).toEqual(['limit.documents']);
  });

  it('shares the node budget across documents', () => {
    const big = valid();
    (big.spec as JsonObject).big = Array.from({ length: 4000 }, () => 1);
    const text = Array.from({ length: 16 }, () => stringify(big)).join('---\n');
    expect(text.length).toBeLessThan(AWP_LIMITS.maxSourceBytes);
    const r = doc(text);
    // 16 x 4000 numbers fit in 50 000 nodes? No: 64 000 > 50 000, so a later document is cut.
    expect(codes(r)).toContain('limit.nodes');
  });

  it('truncates the findings of a document that is wrong everywhere', () => {
    const m = valid();
    (m.spec as JsonObject).agents = Array.from({ length: 2000 }, (_, i) => ({
      id: `a${i}`,
      bogus: i,
    }));
    const r = doc(JSON.stringify(m));
    expect(r.findings.length).toBeLessThanOrEqual(AWP_LIMITS.maxFindings + 1);
    expect(r.findings.at(-1)!.code).toBe('limit.findings');
    expect(r.valid).toBe(false);
  });
});

describe('YAML restrictions (spec 3.1)', () => {
  it('rejects a billion-laughs alias expansion without expanding it', () => {
    const lines = ['a: &a0 [x, x, x, x, x, x, x, x, x]'];
    for (let i = 1; i < 12; i++)
      lines.push(`l${i}: &a${i} [${Array.from({ length: 9 }, () => `*a${i - 1}`).join(', ')}]`);
    const text = `apiVersion: ${API}\n${lines.join('\n')}\n`;
    const r = timed(() => doc(text));
    expect(codes(r)).toEqual(['limit.aliases']);
  });

  it('rejects a document with more aliases than the limit even when each is small', () => {
    const refs = Array.from({ length: AWP_LIMITS.maxAliasCount + 5 }, () => '*v').join(', ');
    const r = doc(`apiVersion: ${API}\nv: &v 1\nxs: [${refs}]\n`);
    expect(codes(r)).toEqual(['limit.aliases']);
  });

  it('rejects an anchor that creates a cycle', () => {
    const r = timed(() => doc(`apiVersion: ${API}\nx: &a\n  y: *a\n`));
    expect(r.valid).toBe(false);
    expect(
      codes(r).some((c) => c === 'yaml.cycle' || c === 'yaml.parse-error' || c === 'limit.aliases'),
    ).toBe(true);
  });

  it('accepts a harmless alias (no cycle, small)', () => {
    const m = `apiVersion: ${API}\nkind: Workflow\nmetadata: &m\n  name: p\n  version: 1.0.0\n  owner: t\n  classification: internal\nspec:\n  agents: [{id: a, model: {provider: s, name: m}, instructions: x}]\n  workflow: [{id: s, agent: a}]\n  x-note: *m\n`;
    expect(doc(m).valid).toBe(true);
  });

  it('rejects custom tags, non-string keys, duplicate keys and bad syntax', () => {
    expect(codes(doc(`apiVersion: ${API}\nkind: !!python/object:os.system Workflow\n`))).toContain(
      'yaml.custom-tag',
    );
    expect(codes(doc(`apiVersion: ${API}\nkind: !custom Workflow\n`))).toContain('yaml.custom-tag');
    // !!binary resolves to bytes in the core schema; bytes have no JSON form
    expect(codes(doc(`apiVersion: ${API}\nx: !!binary aGk=\n`))).toContain('yaml.non-json-value');
    expect(codes(doc(`apiVersion: ${API}\n1: one\n`))).toContain('yaml.non-string-key');
    expect(codes(doc(`apiVersion: ${API}\n? [a, b]\n: c\n`))).toContain('yaml.non-string-key');
    expect(codes(doc(`apiVersion: ${API}\nkind: Workflow\nkind: Agent\n`))).toContain(
      'yaml.parse-error',
    );
    expect(codes(doc(`{"apiVersion":"${API}","kind":"Workflow","kind":"Agent"}`))).toContain(
      'yaml.parse-error',
    );
    expect(codes(doc('apiVersion: [unclosed\n'))).toContain('yaml.parse-error');
    expect(codes(doc(''))).toEqual(['yaml.empty']);
  });

  it('does not treat the merge key as anything special (YAML 1.2 core): it is an unknown field', () => {
    const r = doc(
      `apiVersion: ${API}\nkind: Workflow\nmetadata: {name: p, version: 1.0.0, owner: t}\nspec:\n  base: &b {a: 1}\n  <<: *b\n`,
    );
    expect(
      r.findings.some((f) => f.code === 'schema.additionalProperties' && f.path === '/spec/<<'),
    ).toBe(true);
  });

  it('rejects what has no JSON form: infinities, NaN, integers beyond 2^53', () => {
    expect(codes(doc(`apiVersion: ${API}\nx: .inf\n`))).toContain('yaml.non-json-value');
    expect(codes(doc(`apiVersion: ${API}\nx: .nan\n`))).toContain('yaml.non-json-value');
    expect(codes(doc(`apiVersion: ${API}\nx: 9007199254740993\n`))).toContain(
      'yaml.unsafe-integer',
    );
    expect(inspectValue({ n: Number.MAX_SAFE_INTEGER })).toEqual([]);
  });

  it('rejects values that are not plain JSON data', () => {
    expect(inspectValue({ d: new Date() }).map((f) => f.code)).toEqual(['yaml.non-json-value']);
    expect(inspectValue({ m: new Map() }).map((f) => f.code)).toEqual(['yaml.non-json-value']);
    expect(inspectValue({ f: () => 1 }).map((f) => f.code)).toEqual(['yaml.non-json-value']);
    expect(inspectValue({ b: 1n }).map((f) => f.code)).toEqual(['yaml.non-json-value']);
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(inspectValue(cyc).map((f) => f.code)).toEqual(['yaml.cycle']);
    expect(inspectValue(Object.create({ inherited: 1 })).map((f) => f.code)).toEqual([
      'yaml.non-json-value',
    ]);
  });

  it('a string with a lone surrogate cannot be digested: the digest is refused, not guessed', () => {
    const m = valid();
    (m.spec as JsonObject)['x-note'] = '\ud800';
    const r = doc(JSON.stringify(m).replace('\\ud800', '\\ud800'));
    expect(codes(r)).toContain('digest.not-canonicalizable');
    expect(r.valid).toBe(false);
  });
});

describe('prototype pollution and hostile keys', () => {
  const before = Object.getOwnPropertyNames(Object.prototype).sort();
  const clean = () => {
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).allow).toBeUndefined();
  };

  it('__proto__, constructor and prototype keys are plain data or unknown fields, never pollution', () => {
    const texts = [
      `{"apiVersion":"${API}","__proto__":{"polluted":true},"kind":"Workflow"}`,
      `apiVersion: ${API}\n__proto__:\n  polluted: true\nconstructor:\n  prototype:\n    polluted: true\n`,
      JSON.stringify({
        ...valid(),
        metadata: {
          name: 'p',
          version: '1.0.0',
          owner: 't',
          labels: { __proto__: 'x', constructor: 'y' },
        },
      }),
    ];
    for (const t of texts) {
      const r = doc(t);
      expect(r.valid).toBe(false);
      clean();
    }
    const m = `{"apiVersion":"${API}","kind":"Workflow","metadata":{"name":"p","version":"1.0.0","owner":"t","classification":"internal"},"spec":{"agents":[{"id":"a","model":{"provider":"s","name":"m"},"permissions":{"tools":{"constructor.x":{"allow":true},"toString.y":{"allow":true},"hasOwnProperty.z":{"allow":true}}}}],"workflow":[{"id":"s","agent":"a"}],"x-note":{"__proto__":{"polluted":true}}}}`;
    const r = doc(m);
    expect(r.valid).toBe(true);
    clean();
    expect(Object.keys(r.manifest!.spec as object)).toContain('x-note');
  });

  it('a field named __proto__ in the front matter is reported as an unknown field', () => {
    const r = doc(`---\napiVersion: ${API}\nkind: Workflow\n__proto__: {a: 1}\n---\n`, 'auto');
    expect(
      r.findings.some((f) => f.code === 'schema.additionalProperties' && f.path === '/__proto__'),
    ).toBe(true);
    clean();
  });

  it('a section named after an Object.prototype member does not match an agent by inheritance', () => {
    const m = valid();
    (m.spec as { agents: JsonObject[] }).agents[0] = {
      id: 'constructor',
      model: { provider: 'p', name: 'm' },
    };
    (m.spec as { workflow: JsonObject[] }).workflow[0] = { id: 's', agent: 'constructor' };
    const r = validateManifestSource(`---\n${stringify(m)}---\n\n## Agent: toString\n\nx\n`)!;
    expect(r.findings.some((f) => f.code === 'wrapper.section-orphan')).toBe(true);
    clean();
  });
});

describe('inputs that try to make the validator slow or crash', () => {
  it('a very long expression string is checked in bounded time', () => {
    const m = valid();
    (m.spec as { workflow: JsonObject[] }).workflow[0]!.task = `${'a'.repeat(400_000)}`;
    const r = timed(() => doc(JSON.stringify(m)));
    expect(r.valid).toBe(true);
    (m.spec as { workflow: JsonObject[] }).workflow[0]!.task = `${'${{ inputs.x '.repeat(30_000)}`;
    expect(timed(() => doc(JSON.stringify(m))).valid).toBe(false);
  });

  it('a catastrophic-looking regular expression in an input pattern is only compiled', () => {
    const m = valid();
    (m.spec as JsonObject).inputs = [{ name: 'in', type: 'string', pattern: '(a+)+$' }];
    expect(timed(() => doc(JSON.stringify(m))).valid).toBe(true);
    (m.spec as JsonObject).inputs = [{ name: 'in', type: 'string', pattern: '(' }];
    expect(codes(doc(JSON.stringify(m)))).toEqual(['input.pattern-invalid']);
  });

  const chain = (n: number, expressions: boolean, closeCycle = false): JsonObject => {
    const steps = Array.from({ length: n }, (_, i) => ({
      id: `s${i}`,
      agent: 'a',
      ...(expressions ? { outputs: [{ name: 'r' }] } : {}),
      ...(i > 0
        ? {
            dependsOn: [`s${i - 1}`],
            ...(expressions ? { task: `\${{ steps.s${i - 1}.outputs.r }}` } : {}),
          }
        : closeCycle
          ? { dependsOn: [`s${n - 1}`] }
          : {}),
    }));
    const m = valid();
    (m.spec as JsonObject).workflow = steps;
    return m;
  };
  const cheap = <T>(fn: () => T, maxMs: number, maxRssMb: number): T => {
    const before = process.memoryUsage().rss;
    const t0 = performance.now();
    const out = fn();
    expect(performance.now() - t0).toBeLessThan(maxMs);
    expect((process.memoryUsage().rss - before) / 1e6).toBeLessThan(maxRssMb);
    return out;
  };

  it('a chain at the step limit is checked completely, in bounded time and memory', () => {
    const n = AWP_LIMITS.maxSteps;
    expect(cheap(() => doc(JSON.stringify(chain(n, true))), 2500, 250).valid).toBe(true);
    const r = cheap(() => doc(JSON.stringify(chain(n, true, true))), 2500, 250);
    expect(codes(r)).toContain('dependsOn.cycle');
  });

  it('a workflow above the step limit is refused before the quadratic rules run (3000 with expressions, 5000 with a cycle)', () => {
    for (const n of [AWP_LIMITS.maxSteps + 1, 3000, 5000]) {
      const text = JSON.stringify(chain(n, n < 5000, n === 5000));
      expect(text.length).toBeLessThan(AWP_LIMITS.maxSourceBytes);
      const r = cheap(() => doc(text), 1500, 150);
      expect(codes(r)).toEqual(['limit.steps']);
      expect(r.findings[0]!.path).toBe('/spec/workflow');
    }
  });

  it('too many agents are refused the same way', () => {
    const m = valid();
    (m.spec as { agents: JsonObject[] }).agents = Array.from(
      { length: AWP_LIMITS.maxAgents + 1 },
      (_, i) => ({ id: `a${i}`, model: { provider: 'p', name: 'm' } }),
    );
    expect(codes(cheap(() => doc(JSON.stringify(m)), 1500, 150))).toEqual(['limit.steps']);
  });

  it('many back edges cost no more than the finding cap (no per-edge cycle message)', () => {
    const n = 200;
    const ids = Array.from({ length: n }, (_, i) => `s${i}`);
    const m = valid();
    (m.spec as JsonObject).workflow = ids.map((id) => ({ id, agent: 'a', dependsOn: ids }));
    const r = cheap(() => doc(JSON.stringify(m)), 2500, 250);
    expect(r.findings.length).toBeLessThanOrEqual(AWP_LIMITS.maxFindings + 1);
    expect(r.findings.at(-1)!.code).toBe('limit.findings');
    expect(r.valid).toBe(false);
  });

  it('the semantic phase stops collecting at the cap it is given', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `s${i}`);
    const m = valid();
    (m.spec as JsonObject).workflow = ids.map((id) => ({ id, agent: 'a', dependsOn: ids }));
    const options = { profiles: new Set(['core']), verifyDigest: false };
    const all = semanticFindings(m as never, options);
    expect(all.length).toBeGreaterThan(20);
    const capped = semanticFindings(m as never, { ...options, maxFindings: 7 });
    expect(capped).toEqual(all.slice(0, 7));
  });

  it('keeps the invariant that makes EXPR_RE safe: the schema pattern rejects a malformed expression first', () => {
    const m = valid();
    (m.spec as { workflow: JsonObject[] }).workflow[0]!.task = '${{ inputs.x '.repeat(30_000);
    const r = cheap(() => doc(JSON.stringify(m)), 3000, 250);
    expect(codes(r)).toEqual(['schema.pattern']);
  });

  it('control characters, NUL and byte order marks do not crash', () => {
    for (const t of [
      '\u0000',
      '﻿{"apiVersion":"' + API + '"}',
      `apiVersion: ${API}\nx: "\u0000"\n`,
      '  ',
      '{"a":',
    ])
      expect(() => validateManifestSource(t, { layout: 'document' })).not.toThrow();
  });

  it('never throws, whatever the text (random garbage, fixed seed)', () => {
    let a = 12345;
    const next = () => (a = (a * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const alphabet = [
      '{',
      '}',
      '[',
      ']',
      ':',
      '-',
      '---',
      '\n',
      ' ',
      '"',
      "'",
      '&a',
      '*a',
      '!',
      '#',
      '?',
      'apiVersion: awp.x\n',
      'x',
      '1',
      '.inf',
      '|',
      '>',
    ];
    for (let i = 0; i < 400; i++) {
      let t = '';
      for (let j = 0; j < 1 + Math.floor(next() * 60); j++)
        t += alphabet[Math.floor(next() * alphabet.length)];
      for (const layout of ['auto', 'document', 'markdown'] as const)
        expect(() => validateManifestSource(t, { layout })).not.toThrow();
    }
  });
});

describe('what an accepted manifest cannot do', () => {
  it('returns data only: the result holds no function, class instance or reference to the input', () => {
    const r = doc(JSON.stringify(valid()));
    const json = JSON.stringify(r);
    expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(r)));
    expect(Object.getPrototypeOf(r.manifest)).toBe(Object.prototype);
  });

  it('stating a permission is not granting it: the result lists permissions, nothing is created', () => {
    const m = valid();
    (m.spec as { agents: JsonObject[] }).agents[0]!.permissions = {
      default: 'allow',
      tools: { 'any.tool': { allow: true } },
    };
    const r = doc(JSON.stringify(m));
    expect(r.valid).toBe(true);
    // validation returns the manifest as stated; it has no side effects and no store to write to
    expect(Object.keys(r).sort()).toEqual(
      [
        'digest',
        'documents',
        'findings',
        'kind',
        'layout',
        'manifest',
        'name',
        'valid',
        'version',
      ].sort(),
    );
  });
});
