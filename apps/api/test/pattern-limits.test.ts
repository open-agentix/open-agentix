import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CVE_TRIAGE } from './fixtures.js';
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

  it('accepts the maximum of a global set (half of a policy) and refuses beyond it', async () => {
    const ok = await create('1.0.0', patterns(32, 128));
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

describe('limits that hold for what applies together', () => {
  it('refuses the 33rd enabled policy, and patterns beyond 128 across enabled policies', async () => {
    const t0 = performance.now();
    const make = (name: string, bundle: unknown, enabled = true) =>
      n.req({ method: 'POST', url: '/v1/policies', payload: { name, enabled, bundle } });
    const first = await make('tenant-a', { forbiddenArgPatterns: patterns(30, 8) });
    expect(first.statusCode, first.body).toBe(201);
    const second = await make('tenant-b', { forbiddenArgPatterns: patterns(30, 9) });
    expect(second.statusCode, second.body).toBe(201);
    // 64 (earlier test) + 30 + 30 + 9 > 128 enabled patterns of the tenant
    const third = await make('tenant-c', { forbiddenArgPatterns: patterns(9, 10) });
    expect(third.statusCode).toBe(422);
    expect(third.json().error).toBe('policy_limits_exceeded');
    // disabled policies do not count, and enabling one that would exceed is refused too
    const off = await make('tenant-d', { forbiddenArgPatterns: patterns(9, 11) }, false);
    expect(off.statusCode, off.body).toBe(201);
    const enable = await n.req({
      method: 'PUT',
      url: `/v1/policies/${off.json().id}`,
      payload: { enabled: true },
    });
    expect(enable.statusCode).toBe(422);
    // the number of enabled policies
    for (let i = 0; i < 30; i++) {
      const ok = await make(`small-${i}`, { forbiddenTools: [`x/${i}`] });
      if (i < 28) expect(ok.statusCode, ok.body).toBe(201);
      else if (ok.statusCode === 422) break;
    }
    expect((await make('one-too-many', { forbiddenTools: ['x/last'] })).statusCode).toBe(422);
    expect(performance.now() - t0).toBeLessThan(5000);
  });

  it('refuses globs above the limits when a policy or a guideline is written', async () => {
    const policy = await n.req({
      method: 'POST',
      url: '/v1/policies',
      payload: { name: 'globby', bundle: { forbiddenTools: ['*a*a*a*a*a*a*a*a*a*!'] } },
    });
    expect(policy.statusCode).toBe(400);
    const guideline = await n.req({
      method: 'POST',
      url: '/v1/guidelines',
      payload: {
        scope: 'global',
        name: 'globby',
        version: '1.0.0',
        content: '# R',
        rules: { requireApprovalTools: ['a'.repeat(200)] },
      },
    });
    expect(guideline.statusCode).toBe(400);
  });

  it('refuses a guideline set whose merge with the others exceeds a policy (422)', async () => {
    const g = (scope: string, name: string, version: string, count: number, chars = 8) =>
      n.req({
        method: 'POST',
        url: '/v1/guidelines',
        payload: {
          scope,
          name,
          version,
          content: '# R',
          rules: {
            forbiddenArgPatterns: patterns(count, chars).map((p, i) => ({
              ...p,
              pattern: `${p.pattern}${scope}${name}${version}${i}`.slice(-250),
            })),
          },
        },
      });
    // a global set uses at most half of a policy: the earlier test created 32 patterns already
    const more = await g('global', 'second', '1.0.0', 1);
    expect(more.statusCode).toBe(422);
    expect(more.json().error).toBe('guideline_limits_exceeded');
    // the tenant has room for 64 - 32 patterns, over all its versions
    expect((await g('tenant', 'own', '1.0.0', 30)).statusCode).toBe(201);
    expect((await g('tenant', 'own', '1.0.1', 30)).statusCode).toBe(422);
  });
});

describe('evaluate and dry-run are bounded', () => {
  it('rate-limits the dry-run route like validation', async () => {
    const strict = await testNode({ OAX_RATE_LIMIT_VALIDATE_MAX: '3' });
    try {
      await strict.req({
        method: 'POST',
        url: '/v1/teams',
        payload: { slug: 'team-security', name: 'Security' },
      });
      const id = (
        await strict.req({ method: 'POST', url: '/v1/agents', payload: { source: CVE_TRIAGE } })
      ).json().id;
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++)
        statuses.push(
          (await strict.req({ method: 'POST', url: `/v1/agents/${id}/dry-run`, payload: {} }))
            .statusCode,
        );
      expect(statuses.slice(3)).toEqual([429, 429]);
      expect(statuses.slice(0, 3)).not.toContain(429);
    } finally {
      await strict.close();
    }
  });

  it('rate-limits POST /v1/policies/evaluate like validation', async () => {
    const strict = await testNode({ OAX_RATE_LIMIT_VALIDATE_MAX: '3' });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++)
        statuses.push(
          (
            await strict.req({
              method: 'POST',
              url: '/v1/policies/evaluate',
              payload: { source: 'x', agentId: 'a', call: { server: 's', tool: 't', args: {} } },
            })
          ).statusCode,
        );
      expect(statuses.slice(3)).toEqual([429, 429]);
    } finally {
      await strict.close();
    }
  });
});

describe('tool globs are bounded in number', () => {
  let g: TestNode;
  beforeAll(async () => {
    g = await testNode();
  });
  afterAll(async () => g.close());

  const globs = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => `*${'a'.repeat(84)}${from + i}b`.slice(0, 120));

  it('refuses a policy of thousands of globs (about 1 MB) and more than 64 per policy', async () => {
    const t0 = performance.now();
    const huge = await g.req({
      method: 'POST',
      url: '/v1/policies',
      payload: { name: 'globs-huge', bundle: { forbiddenTools: globs(8000) } },
    });
    expect(huge.statusCode).toBe(400);
    const some = await g.req({
      method: 'POST',
      url: '/v1/policies',
      payload: { name: 'globs-65', bundle: { forbiddenTools: globs(65) } },
    });
    expect(some.statusCode).toBe(400);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('refuses a guideline set with more than 64 tool globs', async () => {
    const res = await g.req({
      method: 'POST',
      url: '/v1/guidelines',
      payload: {
        scope: 'global',
        name: 'many-globs',
        version: '1.0.0',
        content: '# R',
        rules: { forbiddenTools: globs(40), requireApprovalTools: globs(25, 100) },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/at most 64 tool globs/);
  });

  it('limits the enabled globs of a tenant together', async () => {
    const make = (name: string, forbiddenTools: string[]) =>
      g.req({ method: 'POST', url: '/v1/policies', payload: { name, bundle: { forbiddenTools } } });
    expect((await make('g-a', globs(64, 0))).statusCode).toBe(201);
    expect((await make('g-b', globs(64, 100))).statusCode).toBe(201);
    const over = await make('g-c', globs(1, 200));
    expect(over.statusCode).toBe(422);
    expect(over.json().error).toBe('policy_limits_exceeded');
  });
});
