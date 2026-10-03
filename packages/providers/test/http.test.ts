import { describe, expect, it } from 'vitest';
import {
  ProviderError,
  createGuardedFetch,
  estimateTokens,
  parseToolArgs,
  postJson,
} from '../src/index.js';
import { fakeFetch, json } from './helpers.js';

describe('createGuardedFetch', () => {
  it('only allows configured origins', async () => {
    const { fetch, calls } = fakeFetch([json({ ok: 1 })]);
    const guarded = createGuardedFetch({
      allowedOrigins: ['https://api.example.com/v1'],
      fetchImpl: fetch,
    });
    await expect(guarded('https://evil.example.org/x')).rejects.toThrow(
      /not a configured endpoint/,
    );
    await guarded('https://api.example.com/v1/chat');
    expect(calls).toHaveLength(1);
  });

  it('builds proxy and default fetchers without network', () => {
    expect(
      typeof createGuardedFetch({
        allowedOrigins: ['http://localhost:1'],
        proxyUrl: 'http://proxy:3128',
      }),
    ).toBe('function');
    expect(typeof createGuardedFetch({ allowedOrigins: ['http://localhost:1'] })).toBe('function');
  });
});

describe('postJson', () => {
  it('retries on 429/5xx and network errors, then succeeds', async () => {
    const { fetch, calls } = fakeFetch([
      json({}, 503),
      new Error('ECONNRESET'),
      json({ ok: true }),
    ]);
    const res = await postJson<{ ok: boolean }>(
      fetch,
      'http://x/y',
      { a: 1 },
      { backoffMs: 1, maxRetries: 2 },
    );
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[0]?.body).toEqual({ a: 1 });
  });

  it('does not retry client errors', async () => {
    const { fetch, calls } = fakeFetch([json({ error: 'bad' }, 400)]);
    const err = await postJson(fetch, 'http://x', {}, { backoffMs: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it('gives up after max retries', async () => {
    const { fetch } = fakeFetch([json({}, 500), json({}, 500)]);
    const err = (await postJson(fetch, 'http://x', {}, { backoffMs: 1, maxRetries: 1 }).catch(
      (e: unknown) => e,
    )) as ProviderError;
    expect(err.retryable).toBe(true);
  });

  it('stops when the caller aborts', async () => {
    const ac = new AbortController();
    ac.abort();
    const { fetch } = fakeFetch([new Error('aborted')]);
    await expect(
      postJson(fetch, 'http://x', {}, { signal: ac.signal, backoffMs: 1 }),
    ).rejects.toThrow('aborted');
  });

  it('never retries egress denials', async () => {
    const guarded = createGuardedFetch({
      allowedOrigins: ['http://a'],
      fetchImpl: fakeFetch([]).fetch,
    });
    await expect(postJson(guarded, 'http://b/x', {}, { backoffMs: 1 })).rejects.toThrow(
      /configured endpoint/,
    );
  });
});

describe('helpers', () => {
  it('estimates tokens and parses tool args', () => {
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(parseToolArgs('{"a":1}')).toEqual({ a: 1 });
    expect(parseToolArgs({ b: 2 })).toEqual({ b: 2 });
    expect(parseToolArgs('not json')).toEqual({ _raw: 'not json' });
    expect(parseToolArgs('[1]')).toEqual({});
    expect(parseToolArgs('')).toEqual({});
    expect(parseToolArgs(undefined)).toEqual({});
  });
});
