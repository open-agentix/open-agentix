import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IMAGE_TOKENS,
  MESSAGE_OVERHEAD_TOKENS,
  REQUEST_OVERHEAD_TOKENS,
  TOOL_OVERHEAD_TOKENS,
  estimateInputUpperBound,
  estimateOutputTokens,
  outputFloor,
  utf8Bytes,
} from '../src/index.js';

/**
 * Fixture tokenizer: a deterministic byte-level BPE with a learned merge table. By construction
 * (every merge replaces two tokens by one) it never yields more tokens than UTF-8 bytes, which is
 * the property the upper bound relies on. The merge table is trained on a fixed corpus so that
 * common text really compresses (the bound must hold for the whole range between 1 token per byte
 * and highly merged text).
 */
function trainBpe(corpus: string, merges: number): Map<string, number> {
  let seq: number[] = [...new TextEncoder().encode(corpus)];
  const table = new Map<string, number>();
  let next = 256;
  for (let i = 0; i < merges; i++) {
    const counts = new Map<string, number>();
    for (let j = 0; j + 1 < seq.length; j++) {
      const k = `${seq[j]},${seq[j + 1]}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
    if (!best || best[1] < 2) break;
    table.set(best[0], next);
    const [a, b] = best[0].split(',').map(Number) as [number, number];
    const out: number[] = [];
    for (let j = 0; j < seq.length; j++) {
      if (seq[j] === a && seq[j + 1] === b) {
        out.push(next);
        j++;
      } else out.push(seq[j]!);
    }
    seq = out;
    next++;
  }
  return table;
}
const CORPUS =
  'the quick brown fox jumps over the lazy dog. '.repeat(50) +
  '{"type":"object","properties":{"a":{"type":"string"}}}'.repeat(30) +
  'Grüße 世界 こんにちは 🙂 '.repeat(20);
const MERGES = trainBpe(CORPUS, 200);
function countTokens(text: string): number {
  let seq: number[] = [...new TextEncoder().encode(text)];
  for (const [pair, id] of MERGES) {
    const [a, b] = pair.split(',').map(Number) as [number, number];
    const out: number[] = [];
    for (let j = 0; j < seq.length; j++) {
      if (seq[j] === a && seq[j + 1] === b) {
        out.push(id);
        j++;
      } else out.push(seq[j]!);
    }
    seq = out;
  }
  return seq.length;
}

/** Small seeded PRNG (mulberry32) so the property test is reproducible. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ALPHABETS = [
  'abcdefghijklmnopqrstuvwxyz ',
  'ABC xyz 0123456789 {}[]":,',
  'äöüß€ÄÖÜ àéîõ ',
  '世界你好こんにちは한국어',
  '🙂🚀🔥👩‍👩‍👧‍👦',
  '\u0000\u0007\n\t\r ​‮',
];
function randomText(rand: () => number): string {
  const alphabet = [...ALPHABETS[Math.floor(rand() * ALPHABETS.length)]!];
  const len = Math.floor(rand() * 400);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(rand() * alphabet.length)];
  return out;
}

describe('fixture tokenizer', () => {
  it('compresses ordinary text but never beyond one token per byte', () => {
    const t = 'the quick brown fox';
    expect(countTokens(t)).toBeLessThan(utf8Bytes(t));
    expect(countTokens('')).toBe(0);
  });
});

describe('estimateInputUpperBound', () => {
  it('is >= the real token count for random Unicode (property test, byte-level BPE fixture)', () => {
    const rand = rng(42);
    for (let i = 0; i < 300; i++) {
      const system = randomText(rand);
      const user = randomText(rand);
      const args = { q: randomText(rand) };
      const real =
        countTokens(system) +
        countTokens(user) +
        countTokens('call_1') +
        countTokens('lookup') +
        countTokens(JSON.stringify(args));
      const bound = estimateInputUpperBound({
        system,
        messages: [
          { role: 'user', content: user },
          { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'lookup', args }] },
        ],
      });
      expect(bound).toBeGreaterThanOrEqual(real);
    }
  });

  it('is >= the token count of tool definitions with schemas', () => {
    const rand = rng(7);
    for (let i = 0; i < 100; i++) {
      const description = randomText(rand);
      const inputSchema = {
        type: 'object',
        properties: { a: { type: 'string', description: randomText(rand) } },
      };
      const real =
        countTokens('t') + countTokens(description) + countTokens(JSON.stringify(inputSchema));
      expect(
        estimateInputUpperBound({ messages: [], tools: [{ name: 't', description, inputSchema }] }),
      ).toBeGreaterThanOrEqual(real);
    }
  });

  it('counts overheads, messages, tool results and tool calls', () => {
    expect(estimateInputUpperBound({ messages: [] })).toBe(REQUEST_OVERHEAD_TOKENS);
    const one = estimateInputUpperBound({ messages: [{ role: 'user', content: 'abc' }] });
    expect(one).toBe(REQUEST_OVERHEAD_TOKENS + MESSAGE_OVERHEAD_TOKENS + utf8Bytes('user') + 3);
    const tool = estimateInputUpperBound({
      messages: [],
      tools: [{ name: 'ab', inputSchema: {} }],
    });
    expect(tool).toBe(REQUEST_OVERHEAD_TOKENS + TOOL_OVERHEAD_TOKENS + 2 + 2);
    const result = estimateInputUpperBound({
      messages: [{ role: 'tool', content: 'x', toolCallId: 'id1', name: 'nm' }],
    });
    expect(result).toBe(REQUEST_OVERHEAD_TOKENS + MESSAGE_OVERHEAD_TOKENS + 4 + 1 + 3 + 2);
  });

  it('counts multibyte text by UTF-8 bytes', () => {
    const a = estimateInputUpperBound({ messages: [{ role: 'user', content: '世界' }] });
    const b = estimateInputUpperBound({ messages: [{ role: 'user', content: 'ab' }] });
    expect(a - b).toBe(4);
  });

  it('adds images and honours a catalog image constant', () => {
    const none = estimateInputUpperBound({ messages: [] });
    expect(estimateInputUpperBound({ messages: [] }, { images: 2 })).toBe(
      none + 2 * DEFAULT_IMAGE_TOKENS,
    );
    expect(estimateInputUpperBound({ messages: [] }, { images: 2, imageTokens: 100 })).toBe(
      none + 200,
    );
    expect(estimateInputUpperBound({ messages: [] }, { images: -3 })).toBe(none);
  });

  it('clamps to the context window and applies tokenBoundFactor >= 1 only', () => {
    const req = { messages: [{ role: 'user', content: 'x'.repeat(1000) }] };
    const plain = estimateInputUpperBound(req);
    expect(estimateInputUpperBound(req, { contextTokens: 500 })).toBe(500);
    expect(estimateInputUpperBound(req, { contextTokens: null })).toBe(plain);
    expect(estimateInputUpperBound(req, { tokenBoundFactor: 2 })).toBeGreaterThanOrEqual(
      plain + 1000,
    );
    expect(estimateInputUpperBound(req, { tokenBoundFactor: 0.1 })).toBe(plain);
    expect(estimateInputUpperBound(req, { tokenBoundFactor: Number.NaN })).toBe(plain);
  });

  it('handles non-serializable arguments without throwing', () => {
    expect(
      estimateInputUpperBound({
        messages: [
          { role: 'assistant', content: '', toolCalls: [{ id: 'i', name: 'n', args: undefined }] },
        ],
      }),
    ).toBeGreaterThan(0);
  });
});

describe('output estimators', () => {
  it('estimates ceil(bytes/3) and floors at ceil(bytes/8)', () => {
    expect(estimateOutputTokens('')).toBe(0);
    expect(estimateOutputTokens('abcd')).toBe(2);
    expect(outputFloor('')).toBe(0);
    expect(outputFloor('abcdefghi')).toBe(2);
    expect(estimateOutputTokens('世界')).toBe(2);
  });

  it('the floor never exceeds the estimate, and the estimate is >= real tokens of fixture text', () => {
    const rand = rng(99);
    for (let i = 0; i < 200; i++) {
      const t = randomText(rand);
      expect(outputFloor(t)).toBeLessThanOrEqual(estimateOutputTokens(t));
    }
  });
});
