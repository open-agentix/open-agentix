import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testNode, type TestNode } from './helpers.js';

/**
 * Compile cost is bounded by the source that is written: a policy or guideline holds at most 64
 * patterns of at most 256 characters, 8192 characters in total, whatever the body limit allows.
 * Measured before the limits: 950 patterns of 880 characters took 27.6 s to validate.
 */
let n: TestNode;
beforeAll(async () => {
  n = await testNode();
});
afterAll(async () => n.close());

const slow = (i: number, chars: number): string => {
  const unit = '[\\p{L}\\p{N}\\p{P}\\p{S}]';
  return (
    unit.repeat(Math.max(0, Math.floor((chars - 12) / unit.length))) +
    `u${String(i).padStart(10, '0')}`
  );
};
const patterns = (count: number, chars: number) =>
  Array.from({ length: count }, (_, i) => ({ pattern: slow(i, chars), reason: 'no' }));

describe('policy patterns', () => {
  it('accepts the maximum (64 x 128 characters) in under 1 s, on POST and on PUT', async () => {
    const t0 = performance.now();
    const created = await n.req({
      method: 'POST',
      url: '/v1/policies',
      payload: { name: 'max', bundle: { forbiddenArgPatterns: patterns(64, 128) } },
    });
    expect(created.statusCode, created.body).toBe(201);
    const put = await n.req({
      method: 'PUT',
      url: `/v1/policies/${created.json().id}`,
      payload: { bundle: { forbiddenArgPatterns: patterns(64, 127) } },
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('refuses more patterns, longer patterns and more characters, without compiling', async () => {
    const t0 = performance.now();
    const bad = async (forbiddenArgPatterns: unknown, name: string) =>
      n.req({
        method: 'POST',
        url: '/v1/policies',
        payload: { name, bundle: { forbiddenArgPatterns } },
      });
    expect((await bad(patterns(65, 8), 'count')).statusCode).toBe(400);
    expect((await bad(patterns(1, 880), 'long')).statusCode).toBe(400);
    const chars = await bad(patterns(40, 250), 'chars');
    expect(chars.statusCode).toBe(400);
    expect(chars.json().message).toMatch(/8192/);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('guideline patterns', () => {
  const create = (version: string, forbiddenArgPatterns: unknown) =>
    n.req({
      method: 'POST',
      url: '/v1/guidelines',
      payload: {
        scope: 'global',
        name: 'limits',
        version,
        content: '# R',
        rules: { forbiddenArgPatterns },
      },
    });

  it('accepts the maximum and refuses beyond it, a bad pattern included', async () => {
    const ok = await create('1.0.0', patterns(64, 128));
    expect(ok.statusCode, ok.body).toBe(201);
    expect((await create('1.0.1', patterns(65, 8))).statusCode).toBe(400);
    expect((await create('1.0.2', patterns(1, 880))).statusCode).toBe(400);
    expect((await create('1.0.3', patterns(40, 250))).statusCode).toBe(400);
    const lookahead = await create('1.0.4', [{ pattern: 'a(?=b)', reason: 'no' }]);
    expect(lookahead.statusCode).toBe(400);
    const nested = await create('1.0.5', [{ pattern: '^((a|a))*$', reason: 'no' }]);
    expect(nested.statusCode).toBe(400);
  });
});
