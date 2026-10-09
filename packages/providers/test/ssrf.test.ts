import { describe, expect, it } from 'vitest';
import {
  ProviderError,
  assertPublicDestination,
  createGuardedFetch,
  isPreSendFailure,
  isPrivateAddress,
  postJson,
  readBounded,
} from '../src/index.js';

describe('isPrivateAddress', () => {
  it('flags loopback, private, link-local, metadata, CGNAT, multicast and mapped addresses', () => {
    for (const a of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.1',
      '192.168.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '192.0.0.1',
      '198.18.0.1',
      '::1',
      '::',
      'fe80::1',
      'fd00::1',
      'fc00::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '[::1]',
      'not-an-ip',
    ])
      expect(isPrivateAddress(a), a).toBe(true);
    for (const a of [
      '8.8.8.8',
      '1.1.1.1',
      '172.32.0.1',
      '100.128.0.1',
      '2606:4700::1111',
      '::ffff:8.8.8.8',
    ])
      expect(isPrivateAddress(a), a).toBe(false);
  });
});

describe('assertPublicDestination', () => {
  const lookup = (map: Record<string, string[]>) => async (h: string) => {
    if (!map[h]) throw new Error('ENOTFOUND');
    return map[h].map((address) => ({ address }));
  };
  const denied = (host: string, opts = {}) =>
    assertPublicDestination(host, opts).then(
      () => false,
      (e: { code?: string }) => e.code === 'egress_denied',
    );

  it('refuses names that resolve to a private address (DNS rebinding style) and literal IPs', async () => {
    const l = lookup({ 'evil.example': ['203.0.113.7', '127.0.0.1'], 'good.example': ['8.8.8.8'] });
    expect(await denied('evil.example', { lookup: l })).toBe(true);
    expect(await denied('good.example', { lookup: l })).toBe(false);
    expect(await denied('127.0.0.1')).toBe(true);
    expect(await denied('[::1]')).toBe(true);
    expect(await denied('169.254.169.254')).toBe(true);
    expect(await denied('8.8.8.8')).toBe(false);
  });

  it('lets an unresolvable name through (nothing can be sent) and honours the operator allowlist', async () => {
    expect(await denied('nx.example', { lookup: lookup({}) })).toBe(false);
    const l = lookup({ 'vllm.internal': ['10.0.0.8'], 'lo.internal': ['127.0.0.1'] });
    expect(await denied('vllm.internal', { lookup: l })).toBe(true);
    expect(await denied('vllm.internal', { lookup: l, allow: ['10.0.0.0/8'] })).toBe(false);
    expect(await denied('vllm.internal', { lookup: l, allow: ['vllm.internal'] })).toBe(false);
    // loopback is not implicitly allowed here: only an explicit entry counts
    expect(await denied('lo.internal', { lookup: l })).toBe(true);
    expect(await denied('lo.internal', { lookup: l, allow: ['127.0.0.1'] })).toBe(false);
    expect(await denied('10.0.0.8', { allow: ['10.0.0.8'] })).toBe(false);
  });
});

describe('guarded fetch and bounded bodies', () => {
  it('never follows redirects and checks the destination before every request', async () => {
    const seen: (RequestInit | undefined)[] = [];
    const f = createGuardedFetch({
      allowedOrigins: ['https://api.example'],
      fetchImpl: async (_u, init) => {
        seen.push(init);
        return new Response('ok');
      },
      blockPrivateDestinations: { lookup: async () => [{ address: '203.0.113.9' }] },
    });
    await f('https://api.example/x', { method: 'POST' });
    expect(seen[0]?.redirect).toBe('error');
    const blocked = createGuardedFetch({
      allowedOrigins: ['https://api.example'],
      fetchImpl: async () => new Response('never'),
      blockPrivateDestinations: { lookup: async () => [{ address: '10.0.0.1' }] },
    });
    await expect(blocked('https://api.example/x')).rejects.toMatchObject({ code: 'egress_denied' });
  });

  it('readBounded throws or truncates beyond the limit', async () => {
    const big = () => new Response('x'.repeat(5000));
    await expect(readBounded(big(), 1000)).rejects.toBeInstanceOf(ProviderError);
    expect((await readBounded(big(), 1000, true)).length).toBeLessThanOrEqual(5000);
    expect(await readBounded(new Response('abc'), 1000)).toBe('abc');
    expect(await readBounded(new Response(null), 10)).toBe('');
  });

  it('postJson refuses an oversized answer and flags pre-send failures', async () => {
    const huge: typeof fetch = async () =>
      new Response(JSON.stringify({ v: 'x'.repeat(5000) }), { status: 200 });
    await expect(
      postJson(huge as never, 'https://a.example/x', {}, { maxResponseBytes: 1000, maxRetries: 0 }),
    ).rejects.toMatchObject({ message: expect.stringContaining('too large') });
    const dns = async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    };
    await expect(
      postJson(dns as never, 'https://a.example/x', {}, { maxRetries: 0 }),
    ).rejects.toMatchObject({ preSend: true });
    const reset = async () => {
      throw new Error('ECONNRESET');
    };
    await expect(
      postJson(reset as never, 'https://a.example/x', {}, { maxRetries: 0 }),
    ).rejects.toMatchObject({ preSend: false });
    expect(isPreSendFailure({ cause: { code: 'ECONNREFUSED' } })).toBe(true);
    expect(isPreSendFailure({ code: 'ETIMEDOUT' })).toBe(false);
    expect(isPreSendFailure(null)).toBe(false);
  });
});
