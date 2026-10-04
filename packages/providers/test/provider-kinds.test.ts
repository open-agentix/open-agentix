import { CostModel, StaticSecretResolver } from '@openagentix/core';
import { describe, expect, it } from 'vitest';
import {
  BedrockProvider,
  OpenAICompatibleProvider,
  ProviderRegistry,
  createProvider,
  modelPriceEntries,
  parseProviderConfigs,
  secretRefsOf,
  withName,
  ProviderSettingsSchema,
  type BedrockConverseClient,
  type ProviderConfig,
} from '../src/index.js';
import { fakeFetch, json } from './helpers.js';

const secrets = new StaticSecretResolver({
  'openai-key': 'sk-1',
  'azure-key': 'az-key',
  'router-key': 'or-key',
  'vllm-key': 'vl-key',
  'aws-id': 'AKIA1',
  'aws-secret': 'sec1',
  'aws-token': 'tok1',
  'org-header': 'h1',
});
const reply = () =>
  json({
    model: 'm',
    choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 2 },
  });
const req = { model: 'gpt-5', messages: [{ role: 'user' as const, content: 'hi' }], maxTokens: 50 };

async function make(cfg: unknown, responses = [reply()]) {
  const { fetch, calls } = fakeFetch(responses);
  const parsed = parseProviderConfigs(JSON.stringify([cfg]))[0]!;
  const provider = await createProvider(parsed, { secrets, fetchImpl: fetch });
  return { provider, calls, parsed };
}
const headers = (c: { init: RequestInit | undefined }) =>
  Object.fromEntries(Object.entries((c.init?.headers ?? {}) as Record<string, string>));

describe('OpenAI (GPT)', () => {
  it('uses the public endpoint, bearer auth and max_completion_tokens', async () => {
    const { provider, calls } = await make({
      kind: 'openai',
      name: 'gpt',
      apiKeySecret: 'openai-key',
      organization: 'org-1',
    });
    const res = await provider.complete(req);
    expect(res).toMatchObject({ text: 'ok', usage: { inputTokens: 3, outputTokens: 2 } });
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(headers(calls[0]!)).toMatchObject({
      authorization: 'Bearer sk-1',
      'openai-organization': 'org-1',
    });
    expect(calls[0]?.body).toMatchObject({ max_completion_tokens: 50 });
    expect(calls[0]?.body).not.toHaveProperty('max_tokens');
    expect(provider).toMatchObject({ family: 'openai', catalogProvider: 'openai' });
  });
});

describe('Azure OpenAI', () => {
  it('addresses the deployment named by the model and sends the api-key header', async () => {
    const { provider, calls } = await make({
      kind: 'azure-openai',
      name: 'azure',
      endpoint: 'https://res.openai.azure.com/',
      apiKeySecret: 'azure-key',
    });
    await provider.complete({ ...req, model: 'my gpt deployment' });
    expect(calls[0]?.url).toBe(
      'https://res.openai.azure.com/openai/deployments/my%20gpt%20deployment/chat/completions?api-version=2024-10-21',
    );
    expect(headers(calls[0]!)['api-key']).toBe('az-key');
    expect(headers(calls[0]!)).not.toHaveProperty('authorization');
    expect(provider).toMatchObject({ family: 'azure-openai', catalogProvider: 'azure' });
  });

  it('can pin a deployment and api version', async () => {
    const { provider, calls } = await make({
      kind: 'azure-openai',
      name: 'azure',
      endpoint: 'https://res.openai.azure.com',
      apiKeySecret: 'azure-key',
      deployment: 'prod',
      apiVersion: '2025-01-01',
    });
    await provider.complete(req);
    expect(calls[0]?.url).toBe(
      'https://res.openai.azure.com/openai/deployments/prod/chat/completions?api-version=2025-01-01',
    );
  });
});

describe('OpenRouter, vLLM, LM Studio and generic OpenAI-compatible servers', () => {
  it('sends attribution headers to OpenRouter', async () => {
    const { provider, calls } = await make({
      kind: 'openrouter',
      name: 'router',
      apiKeySecret: 'router-key',
      referer: 'https://example.org/app',
      title: 'Example',
    });
    await provider.complete({ ...req, model: 'anthropic/claude-sonnet-4.5' });
    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(headers(calls[0]!)).toMatchObject({
      authorization: 'Bearer or-key',
      'http-referer': 'https://example.org/app',
      'x-title': 'Example',
    });
    expect(calls[0]?.body).toHaveProperty('max_tokens', 50);
    expect(provider).toMatchObject({ family: 'openrouter', catalogProvider: 'openrouter' });
  });

  it('treats vLLM and LM Studio as restricted-clearance local servers', async () => {
    const vllm = await make({
      kind: 'vllm',
      name: 'vllm',
      baseUrl: 'http://vllm:8000/v1',
      apiKeySecret: 'vllm-key',
    });
    await vllm.provider.complete(req);
    expect(vllm.calls[0]?.url).toBe('http://vllm:8000/v1/chat/completions');
    expect(headers(vllm.calls[0]!).authorization).toBe('Bearer vl-key');
    expect(vllm.provider.clearance).toBe('restricted');
    const lm = await make({ kind: 'lmstudio', name: 'lm' });
    await lm.provider.complete(req);
    expect(lm.calls[0]?.url).toBe('http://localhost:1234/v1/chat/completions');
    expect(lm.provider.clearance).toBe('restricted');
  });

  it('supports any OpenAI-compatible server with header secrets and query', async () => {
    const { provider, calls, parsed } = await make({
      kind: 'openai-compatible',
      name: 'gateway',
      baseUrl: 'https://llm.example.org/v1',
      headers: { 'x-team': 'a' },
      headerSecrets: { 'x-token': 'org-header' },
      query: 'tenant=a',
      clearance: 'confidential',
    });
    await provider.complete(req);
    expect(calls[0]?.url).toBe('https://llm.example.org/v1/chat/completions?tenant=a');
    expect(headers(calls[0]!)).toMatchObject({ 'x-team': 'a', 'x-token': 'h1' });
    expect(provider.clearance).toBe('confidential');
    expect(secretRefsOf(parsed)).toEqual(['org-header']);
  });

  it('refuses requests to other origins than the configured endpoint', async () => {
    const { provider } = await make({
      kind: 'openai-compatible',
      name: 'g',
      baseUrl: 'https://a.example.org/v1',
    });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
  });
});

describe('AWS Bedrock BYOK', () => {
  it('passes explicit credentials resolved from secret references', async () => {
    const seen: unknown[] = [];
    const client: BedrockConverseClient = {
      send: async () => ({ output: {}, usage: {} }) as never,
    };
    const cfg = withName(
      ProviderSettingsSchema.parse({
        kind: 'bedrock',
        region: 'eu-central-1',
        accessKeyIdSecret: 'aws-id',
        secretAccessKeySecret: 'aws-secret',
        sessionTokenSecret: 'aws-token',
      }),
      'aws',
    );
    const p = await createProvider(cfg, { secrets, bedrockClient: client });
    seen.push(p);
    expect(p).toBeInstanceOf(BedrockProvider);
    expect(p).toMatchObject({ family: 'bedrock', catalogProvider: 'amazon-bedrock' });
    expect(secretRefsOf(cfg).sort()).toEqual(['aws-id', 'aws-secret', 'aws-token']);
  });

  it('needs both halves of the key pair', async () => {
    const cfg = withName(
      ProviderSettingsSchema.parse({ kind: 'bedrock', region: 'r', accessKeyIdSecret: 'aws-id' }),
      'aws',
    );
    await expect(createProvider(cfg, { secrets })).rejects.toThrow(/both/);
  });
});

describe('provider settings', () => {
  it('rejects inline secrets and unknown fields', () => {
    expect(() => ProviderSettingsSchema.parse({ kind: 'openai', apiKey: 'sk-inline' })).toThrow();
    expect(() =>
      ProviderSettingsSchema.parse({ kind: 'azure-openai', endpoint: 'https://x.example.org' }),
    ).toThrow();
  });

  it('refuses pasted API keys where a secret reference belongs', () => {
    for (const bad of ['sk-ant-api03-abcdef', 'AKIAIOSFODNN7EXAMPLE', 'has space', '']) {
      expect(() => ProviderSettingsSchema.parse({ kind: 'openai', apiKeySecret: bad })).toThrow();
    }
    expect(() =>
      ProviderSettingsSchema.parse({
        kind: 'openai',
        headerSecrets: { 'x-key': 'ghp_abcdefghij' },
      }),
    ).toThrow();
    expect(
      ProviderSettingsSchema.parse({ kind: 'openai', apiKeySecret: 'acme.openai-key' }),
    ).toMatchObject({ apiKeySecret: 'acme.openai-key' });
  });

  it('turns models with prices into price entries under the instance name', () => {
    const settings = ProviderSettingsSchema.parse({
      kind: 'azure-openai',
      endpoint: 'https://x.example.org',
      apiKeySecret: 'azure-key',
      models: [
        { id: 'prod-gpt', catalogModel: 'gpt-5', inputPerMTok: 1.25, outputPerMTok: 10 },
        { id: 'no-price' },
      ],
    });
    expect(modelPriceEntries('azure', settings.models)).toEqual([
      {
        provider: 'azure',
        model: 'prod-gpt',
        inputPerMTok: 1.25,
        outputPerMTok: 10,
        perToolCallUsd: 0,
      },
    ]);
    expect(modelPriceEntries('x', undefined)).toEqual([]);
  });

  it('layers providers: the overlay wins', async () => {
    const base = await ProviderRegistry.create(
      parseProviderConfigs('[{"kind":"simulated","name":"a"},{"kind":"simulated","name":"b"}]'),
      { secrets },
    );
    const overlay = await ProviderRegistry.create(
      [
        {
          kind: 'openai-compatible',
          name: 'a',
          baseUrl: 'https://x.example.org/v1',
        } as ProviderConfig,
      ],
      { secrets },
    );
    const merged = base.with(overlay);
    expect(merged.get('a').kind).toBe('openai');
    expect(merged.get('b').kind).toBe('simulated');
  });

  it('prices Bedrock inference profiles like their base model', () => {
    const cost = new CostModel([
      {
        provider: 'amazon-bedrock',
        model: 'anthropic.claude-sonnet-4-5-v1:0',
        inputPerMTok: 3,
        outputPerMTok: 15,
        perToolCallUsd: 0,
      },
    ]);
    expect(
      cost.modelCall('amazon-bedrock', 'eu.anthropic.claude-sonnet-4-5-v1:0', {
        inputTokens: 1000,
        outputTokens: 1000,
      }),
    ).toMatchObject({ priced: true, totalMicros: 18_000 });
    expect(
      cost.modelCall('amazon-bedrock', 'eu.other', { inputTokens: 1, outputTokens: 1 }).priced,
    ).toBe(false);
  });
});
