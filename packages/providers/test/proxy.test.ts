import { describe, expect, it } from 'vitest';
import {
  bypassesProxy,
  createBedrockClient,
  createGuardedFetch,
  createProxyAwareFetch,
  proxyFor,
} from '../src/index.js';

describe('proxyFor / NO_PROXY', () => {
  const env = {
    HTTPS_PROXY: 'http://proxy:3128',
    http_proxy: 'http://plain-proxy:3128',
    NO_PROXY: 'localhost,.internal.example, vpce.amazonaws.com,10.0.0.5:8443',
  };

  it('selects the proxy by scheme', () => {
    expect(proxyFor('https://api.openai.com/v1', env)).toBe('http://proxy:3128');
    expect(proxyFor('http://ollama.example.com:11434', env)).toBe('http://plain-proxy:3128');
    expect(proxyFor('https://x', { HTTP_PROXY: 'http://only-http:1' })).toBe('http://only-http:1');
    expect(proxyFor('https://x', {})).toBeUndefined();
    expect(proxyFor(new URL('https://x'), {}, 'http://explicit:1')).toBe('http://explicit:1');
  });

  it('honours NO_PROXY entries (host, suffix, port, wildcard)', () => {
    expect(proxyFor('http://localhost:8080', env)).toBeUndefined();
    expect(proxyFor('https://mcp.internal.example/mcp', env)).toBeUndefined();
    expect(
      proxyFor('https://vpce-1.bedrock-runtime.eu-central-1.vpce.amazonaws.com', env),
    ).toBeUndefined();
    expect(proxyFor('https://10.0.0.5:8443/x', env)).toBeUndefined();
    expect(proxyFor('https://10.0.0.5/x', env)).toBe('http://proxy:3128');
    expect(
      proxyFor('https://anything', { ...env, NO_PROXY: '*' }, 'http://explicit:1'),
    ).toBeUndefined();
    expect(bypassesProxy(new URL('https://[::1]:443/'), '::1')).toBe(true);
    expect(bypassesProxy(new URL('https://a.b'), ' , ')).toBe(false);
  });
});

describe('createProxyAwareFetch', () => {
  it('routes through a proxy dispatcher only when a proxy applies', async () => {
    const calls: string[] = [];
    const f = createProxyAwareFetch({
      env: { HTTPS_PROXY: 'http://proxy:3128', NO_PROXY: 'internal' },
      directFetch: async (i) => (calls.push(`direct ${String(i)}`), new Response('d')),
      proxiedFetch: async (i, init) => (
        calls.push(`proxied ${String(i)} ${init.dispatcher.constructor.name}`),
        new Response('p')
      ),
    });
    await f('https://api.example.com/x');
    await f('https://api.example.com/y');
    await f('https://internal/x');
    expect(calls).toEqual([
      'proxied https://api.example.com/x ProxyAgent',
      'proxied https://api.example.com/y ProxyAgent',
      'direct https://internal/x',
    ]);
    expect(typeof createProxyAwareFetch()).toBe('function');
  });

  it('is used by the guarded fetch when no fetch is injected', () => {
    expect(
      typeof createGuardedFetch({
        allowedOrigins: ['https://a'],
        env: { HTTPS_PROXY: 'http://p:1' },
      }),
    ).toBe('function');
  });

  it('configures the Bedrock client with the env proxy unless NO_PROXY matches', () => {
    const viaProxy = createBedrockClient(
      { region: 'eu-central-1' },
      { HTTPS_PROXY: 'http://proxy:3128' },
    );
    const direct = createBedrockClient(
      { region: 'eu-central-1', endpoint: 'https://vpce-1.vpce.amazonaws.com' },
      { HTTPS_PROXY: 'http://proxy:3128', NO_PROXY: '.vpce.amazonaws.com' },
    );
    const handlerOf = (c: typeof viaProxy) =>
      (c.config as unknown as { requestHandler?: { constructor: { name: string } } }).requestHandler
        ?.constructor.name;
    expect(handlerOf(viaProxy)).toBe('NodeHttpHandler');
    expect(handlerOf(direct)).not.toBe(undefined);
  });
});
