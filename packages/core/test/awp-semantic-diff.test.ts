import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { semanticFindings } from '../src/awp/manifest-semantic.js';
import { pinnedValidator } from '../src/awp/manifest-schema.js';
import { KNOWN_AWP_PROFILES } from '../src/index.js';
import { referenceSemanticCheck } from './awp-pin.js';

/**
 * Differential test: OpenAgentix's implementation of the semantic rules against the vendored
 * reference (`conformance/semantic.mjs`), on the whole conformance suite and on deterministic
 * mutations of it. Both must report the same findings in the same order (code, path, severity,
 * section, message). A rule that drifts, or a pin upgrade that changes one, fails here.
 */
const CONF = fileURLToPath(new URL('../../awp/vendor/awp-v1alpha1/conformance/', import.meta.url));
const EXAMPLES = fileURLToPath(new URL('../../../examples/awp/', import.meta.url));

type Json = unknown;
const structurallyValid = pinnedValidator();

function seeds(): { name: string; doc: Json }[] {
  const out: { name: string; doc: Json }[] = [];
  for (const dir of ['valid', 'invalid'])
    for (const f of readdirSync(`${CONF}${dir}`).sort()) {
      try {
        const docs = readFileSync(`${CONF}${dir}/${f}`, 'utf8').split(/^---$/m);
        for (const [i, text] of docs.entries()) {
          const doc: Json = parse(text, { version: '1.2', logLevel: 'silent' });
          if (doc && typeof doc === 'object') out.push({ name: `${dir}/${f}#${i}`, doc });
        }
      } catch {
        // YAML error cases are covered by the conformance test
      }
    }
  for (const f of readdirSync(EXAMPLES).filter((x) => x.endsWith('.awp.json')))
    out.push({ name: f, doc: JSON.parse(readFileSync(EXAMPLES + f, 'utf8')) });
  return out.filter((s) => structurallyValid(s.doc));
}

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Slot = { parent: Record<string, Json> | Json[]; key: string | number };
function slots(node: Json, out: Slot[] = []): Slot[] {
  if (Array.isArray(node)) {
    node.forEach((v, i) => {
      out.push({ parent: node, key: i });
      slots(v, out);
    });
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, Json>)) {
      if (k.startsWith('x-')) continue;
      out.push({ parent: node as Record<string, Json>, key: k });
      slots(v, out);
    }
  }
  return out;
}
const strings = (node: Json, out: string[] = []): string[] => {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) node.forEach((v) => strings(v, out));
  else if (node && typeof node === 'object') Object.values(node).forEach((v) => strings(v, out));
  return out;
};

function mutate(doc: Json, next: () => number): Json {
  const copy = structuredClone(doc);
  const all = slots(copy);
  const pool = strings(copy).filter((s) => s.length < 80);
  const pick = <T>(a: T[]): T => a[Math.floor(next() * a.length)]!;
  for (let n = 0; n < 1 + Math.floor(next() * 3); n++) {
    if (all.length === 0) break;
    const { parent, key } = pick(all);
    const op = Math.floor(next() * 5);
    const p = parent as Record<string | number, Json>;
    if (op === 0 && !Array.isArray(parent)) delete p[key];
    else if (op === 1 && typeof p[key] === 'string' && pool.length) p[key] = pick(pool);
    else if (op === 2 && Array.isArray(p[key]))
      (p[key] as Json[]).push(structuredClone(pick(p[key] as Json[]) ?? null));
    else if (op === 3 && typeof p[key] === 'number') p[key] = (p[key] as number) + pick([-1, 1, 5]);
    else if (op === 4 && typeof p[key] === 'string')
      p[key] = `${p[key]} \${{ steps.${pick(pool.length ? pool : ['x'])}.outputs.result }}`;
  }
  return copy;
}

const OPTIONS = [
  { profiles: [...KNOWN_AWP_PROFILES], verifyDigest: false },
  { profiles: ['core'], verifyDigest: true },
  { profiles: ['core', 'governance', 'mcp'], verifyDigest: true },
];

function compare(doc: Json, name: string): number {
  let compared = 0;
  for (const o of OPTIONS) {
    const reference = referenceSemanticCheck(structuredClone(doc), o);
    const ours = semanticFindings(structuredClone(doc) as never, {
      profiles: new Set(o.profiles),
      verifyDigest: o.verifyDigest,
    });
    expect(ours, `${name} ${JSON.stringify(o)}`).toEqual(reference);
    compared += 1;
  }
  return compared;
}

describe('semantic rules against the vendored reference', () => {
  const all = seeds();

  it('has seeds', () => expect(all.length).toBeGreaterThan(60));

  it('reports the same findings on every structurally valid conformance document', () => {
    let n = 0;
    for (const s of all) n += compare(s.doc, s.name);
    expect(n).toBeGreaterThan(190);
  });

  it('reports the same findings on deterministic mutations (2000 drawn, structurally valid ones compared)', () => {
    const next = rng(20261017);
    let compared = 0;
    let withFindings = 0;
    for (let i = 0; i < 2000; i++) {
      const seed = all[Math.floor(next() * all.length)]!;
      const mutant = mutate(seed.doc, next);
      if (!structurallyValid(mutant)) continue;
      compared += compare(mutant, `${seed.name} mutant ${i}`);
      if (referenceSemanticCheck(structuredClone(mutant), OPTIONS[0]!).length > 0)
        withFindings += 1;
    }
    expect(compared).toBeGreaterThan(900);
    expect(withFindings).toBeGreaterThan(100);
  });
});
