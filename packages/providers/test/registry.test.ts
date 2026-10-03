import { StaticSecretResolver } from '@openagentix/core';
import { describe, expect, it } from 'vitest';
import {
  AnthropicProvider,
  BedrockProvider,
  DEFAULT_PROVIDERS,
  OllamaProvider,
  OpenAICompatibleProvider,
  ProviderRegistry,
  SimulatedProvider,
  parseProviderConfigs,
} from '../src/index.js';
import { fakeFetch, json } from './helpers.js';

const secrets = new StaticSecretResolver({
  'openai-key': 'sk-1',
  'azure-key': 'az',
  'anthropic-key': 'ak',
});

describe('provider config', () => {
  it('defaults to the simulated provider', () => {
    expect(parseProviderConfigs(undefined)).toEqual(DEFAULT_PROVIDERS);
  });
  it('validates configs and rejects duplicates', () => {
    expect(() => parseProviderConfigs('[{"kind":"openai","name":"x"}]')).toThrow();
    expect(() =>
      parseProviderConfigs('[{"kind":"simulated","name":"a"},{"kind":"simulated","name":"a"}]'),
    ).toThrow(/duplicate/);
    expect(() =>
      parseProviderConfigs('[{"kind":"simulated","name":"a","apiKey":"inline"}]'),
    ).toThrow();
  });
});

describe('ProviderRegistry', () => {
  it('creates every kind and resolves secrets by reference', async () => {
    const { fetch, calls } = fakeFetch([
      json({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] }),
    ]);
    const configs = parseProviderConfigs(
      JSON.stringify([
        {
          kind: 'openai',
          name: 'azure',
          baseUrl: 'https://res.openai.azure.com/openai/deployments/d',
          headerSecrets: { 'api-key': 'azure-key' },
          query: 'api-version=2024-10-21',
        },
        {
          kind: 'openai',
          name: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKeySecret: 'openai-key',
          clearance: 'internal',
        },
        { kind: 'ollama', name: 'ollama', baseUrl: 'http://ollama:11434' },
        {
          kind: 'anthropic',
          name: 'anthropic',
          apiKeySecret: 'anthropic-key',
          defaultMaxTokens: 1000,
        },
        {
          kind: 'bedrock',
          name: 'bedrock',
          region: 'eu-central-1',
          endpoint: 'https://vpce-1.bedrock-runtime.eu-central-1.vpce.amazonaws.com',
          proxyUrl: 'http://proxy:3128',
          maxRetries: 1,
        },
        { kind: 'bedrock', name: 'bedrock2', region: 'eu-central-1' },
        { kind: 'simulated', name: 'simulated', latencyMs: 0 },
        { kind: 'simulated', name: 'demo', latencyMs: 5 },
      ]),
    );
    const reg = await ProviderRegistry.create(configs, { secrets, fetchImpl: fetch });
    expect(reg.names()).toHaveLength(8);
    expect(reg.get('azure')).toBeInstanceOf(OpenAICompatibleProvider);
    expect(reg.get('ollama')).toBeInstanceOf(OllamaProvider);
    expect(reg.get('anthropic')).toBeInstanceOf(AnthropicProvider);
    expect(reg.get('bedrock')).toBeInstanceOf(BedrockProvider);
    expect(reg.get('simulated')).toBeInstanceOf(SimulatedProvider);
    expect(reg.has('nope')).toBe(false);
    expect(() => reg.get('nope')).toThrow(/not configured/);
    await reg.get('azure').complete({ model: 'd', messages: [] });
    expect((calls[0]?.init?.headers as Record<string, string>)['api-key']).toBe('az');
  });

  it('fails when a referenced secret is missing', async () => {
    const cfg = parseProviderConfigs('[{"kind":"anthropic","name":"a","apiKeySecret":"missing"}]');
    await expect(ProviderRegistry.create(cfg, { secrets })).rejects.toThrow(/not configured/);
  });

  it('wraps existing providers', () => {
    const reg = ProviderRegistry.of([new SimulatedProvider({ name: 'x' })]);
    expect(reg.get('x').kind).toBe('simulated');
  });
});
