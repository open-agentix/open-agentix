import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ProviderError,
  assertPublicDestination,
  createGuardedFetch,
  createPinnedLookup,
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
      // NAT64, 6to4 and IPv4-compatible forms embedding a private IPv4 address
      '64:ff9b::7f00:1',
      '64:ff9b::10.0.0.1',
      '64:ff9b::a9fe:a9fe',
      '64:ff9b:1::1',
      '2002:7f00:1::',
      '2002:a9fe:a9fe::1',
      '2002:c0a8:101::',
      '::127.0.0.1',
      '::10.1.2.3',
      '::7f00:1',
      '2001::1',
      'fec0::1',
    ])
      expect(isPrivateAddress(a), a).toBe(true);
    for (const a of [
      '8.8.8.8',
      '1.1.1.1',
      '172.32.0.1',
      '100.128.0.1',
      '2606:4700::1111',
      '::ffff:8.8.8.8',
      '64:ff9b::808:808',
      '2002:808:808::1',
      '::8.8.8.8',
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

  it('fails closed when the name cannot be resolved (or resolves to nothing)', async () => {
    expect(await denied('nx.example', { lookup: lookup({}) })).toBe(true);
    expect(await denied('empty.example', { lookup: lookup({ 'empty.example': [] }) })).toBe(true);
  });

  it('honours the operator allowlist', async () => {
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

describe('createPinnedLookup (connect-time validation)', () => {
  type Res = { err: Error | null; address: unknown };
  const run = (
    lookup: (h: string) => Promise<{ address: string }[]>,
    host: string,
    o: { all?: boolean; family?: number } = {},
    allow: string[] = [],
  ) =>
    new Promise<Res>((resolve) => {
      createPinnedLookup({ lookup, allow })(host, o, (err: Error | null, address: unknown) =>
        resolve({ err, address }),
      );
    });

  it('hands the validated address to the socket', async () => {
    const r = await run(async () => [{ address: '8.8.8.8' }], 'a.example');
    expect(r).toEqual({ err: null, address: '8.8.8.8' });
    const all = await run(
      async () => [{ address: '8.8.8.8' }, { address: '1.1.1.1' }],
      'a.example',
      {
        all: true,
      },
    );
    expect(all.address).toEqual([
      { address: '8.8.8.8', family: 4 },
      { address: '1.1.1.1', family: 4 },
    ]);
  });

  it('rejects a rebound answer, a failed lookup and an empty answer', async () => {
    // the first (pre-request) resolution was public, the connect-time one is not
    let calls = 0;
    const rebinding = async () => [{ address: calls++ === 0 ? '8.8.8.8' : '169.254.169.254' }];
    await assertPublicDestination('r.example', { lookup: rebinding });
    expect((await run(rebinding, 'r.example')).err).toMatchObject({ code: 'egress_denied' });
    const mixed = await run(
      async () => [{ address: '8.8.8.8' }, { address: '10.0.0.1' }],
      'm.example',
      { all: true },
    );
    expect(mixed.err).toMatchObject({ code: 'egress_denied' });
    const failed = await run(async () => Promise.reject(new Error('ENOTFOUND')), 'x.example');
    expect(failed.err).toBeTruthy();
    expect((await run(async () => [], 'e.example')).err).toMatchObject({ code: 'egress_denied' });
  });

  it('keeps the operator exception', async () => {
    const l = async () => [{ address: '10.0.0.8' }];
    expect((await run(l, 'vllm.internal')).err).toBeTruthy();
    expect(await run(l, 'vllm.internal', {}, ['10.0.0.0/8'])).toEqual({
      err: null,
      address: '10.0.0.8',
    });
    expect((await run(l, 'vllm.internal', {}, ['vllm.internal'])).err).toBeNull();
  });
});

describe('guarded fetch pins the address at connect time', () => {
  let server: Server;
  let port: number;
  let hits = 0;
  beforeAll(async () => {
    server = createServer((_q, r) => {
      hits++;
      r.end('pinned-ok');
    });
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise((res) => server.close(res));
  });

  it('rejects a name that was public at the check and private at the connection (rebinding)', async () => {
    let calls = 0;
    const f = createGuardedFetch({
      allowedOrigins: [`http://rebind.example:${port}`],
      blockPrivateDestinations: {
        lookup: async () => [{ address: calls++ === 0 ? '8.8.8.8' : '127.0.0.1' }],
      },
    });
    hits = 0;
    await expect(f(`http://rebind.example:${port}/x`)).rejects.toBeTruthy();
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(hits).toBe(0);
  });

  it('connects to the validated address and keeps the operator exception', async () => {
    const f = createGuardedFetch({
      allowedOrigins: [`http://vllm.internal:${port}`],
      blockPrivateDestinations: {
        allow: ['127.0.0.1'],
        lookup: async () => [{ address: '127.0.0.1' }],
      },
    });
    const res = await f(`http://vllm.internal:${port}/x`);
    expect(await res.text()).toBe('pinned-ok');
    const denied = createGuardedFetch({
      allowedOrigins: [`http://vllm.internal:${port}`],
      blockPrivateDestinations: { lookup: async () => [{ address: '127.0.0.1' }] },
    });
    await expect(denied(`http://vllm.internal:${port}/x`)).rejects.toMatchObject({
      code: 'egress_denied',
    });
  });
});
