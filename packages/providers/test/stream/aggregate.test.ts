import { afterEach, describe, expect, it } from 'vitest';
import { StaticSecretResolver } from '@openagentix/core';
import {
  ChatStreamAggregator,
  createStreamPlan,
  type ProviderConfig,
  type StreamPlan,
  type StreamUsage,
  type UpstreamEvent,
} from '../../src/index.js';
import {
  DONE,
  collect,
  openaiChunk,
  openaiUsage,
  sseHead,
  startServer,
  type FakeServer,
} from './fake-server.js';

const usage: StreamUsage = {
  inputTokens: 5,
  outputTokens: 7,
  cacheReadTokens: 2,
  cacheWriteTokens: 1,
};
const ev = (event: string, data: Record<string, unknown>): UpstreamEvent => ({ event, data });

describe('ChatStreamAggregator (anthropic)', () => {
  it('folds text, tool input and the stop reason', () => {
    const a = new ChatStreamAggregator('anthropic', 'asked-model');
    expect(a.push(ev('message_start', { message: { model: 'served-model' } }))).toBeUndefined();
    expect(
      a.push(ev('content_block_start', { index: 0, content_block: { type: 'text', text: 'Hi ' } })),
    ).toBe('Hi ');
    expect(
      a.push(ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'there' } })),
    ).toBe('there');
    a.push(
      ev('content_block_start', {
        index: 1,
        content_block: { type: 'tool_use', id: 'tu1', name: 'lookup' },
      }),
    );
    a.push(
      ev('content_block_delta', {
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"q":' },
      }),
    );
    a.push(
      ev('content_block_delta', {
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '"x"}' },
      }),
    );
    // Unknown deltas, thinking and stray blocks never produce text.
    expect(
      a.push(
        ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'x' } }),
      ),
    ).toBeUndefined();
    a.push(
      ev('content_block_delta', {
        index: 9,
        delta: { type: 'input_json_delta', partial_json: '{' },
      }),
    );
    a.push(ev('message_delta', { delta: { stop_reason: 'tool_use' } }));
    a.push(ev('ping', {}));
    const res = a.finish(usage);
    expect(res).toMatchObject({
      text: 'Hi there',
      model: 'served-model',
      stopReason: 'tool_use',
      toolCalls: [{ id: 'tu1', name: 'lookup', args: { q: 'x' } }],
      usage: { inputTokens: 5, outputTokens: 7, cacheReadTokens: 2, cacheWriteTokens: 1 },
    });
    expect(a.toolArgBytes).toBe(Buffer.byteLength('{"q":"x"}'));
    expect(a.textBytes).toBe(8);
  });

  it('keeps the requested model, maps unknown stop reasons and bad tool json', () => {
    const a = new ChatStreamAggregator('anthropic', 'asked');
    a.push(ev('content_block_start', { index: 0, content_block: { type: 'tool_use', name: 'n' } }));
    a.push(
      ev('content_block_delta', {
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{bad' },
      }),
    );
    a.push(ev('message_delta', { delta: { stop_reason: 'weird' } }));
    const res = a.finish(usage);
    expect(res.model).toBe('asked');
    expect(res.stopReason).toBe('tool_use');
    const plain = new ChatStreamAggregator('anthropic', 'asked');
    plain.push(ev('message_delta', { delta: { stop_reason: 'weird' } }));
    expect(plain.finish(usage).stopReason).toBe('other');
    expect(res.toolCalls).toEqual([{ id: 'call_0', name: 'n', args: { _raw: '{bad' } }]);
  });
});

describe('ChatStreamAggregator (openai)', () => {
  it('folds content, indexed tool call fragments and finish reasons', () => {
    const a = new ChatStreamAggregator('openai', 'asked');
    expect(
      a.push(ev('chunk', { model: 'served', choices: [{ index: 0, delta: { content: 'Hel' } }] })),
    ).toBe('Hel');
    a.push(ev('chunk', { choices: [{ index: 0, delta: { content: 'lo' } }] }));
    a.push(
      ev('chunk', {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: 'c1', function: { name: 'do', arguments: '{"a"' } }],
            },
          },
        ],
      }),
    );
    a.push(
      ev('chunk', {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } },
        ],
      }),
    );
    // A second choice and a chunk without choices are ignored.
    a.push(ev('chunk', { choices: [{ index: 1, delta: { content: 'ignored' } }] }));
    a.push(ev('chunk', { usage: {} }));
    a.push(ev('chunk', { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
    const res = a.finish(usage);
    expect(res).toMatchObject({
      text: 'Hello',
      model: 'served',
      stopReason: 'tool_use',
      toolCalls: [{ id: 'c1', name: 'do', args: { a: 1 } }],
    });
  });

  it('derives tool_use from tool calls when the finish reason is missing', () => {
    const a = new ChatStreamAggregator('openai', 'm');
    a.push(
      ev('chunk', {
        choices: [{ delta: { tool_calls: [{ function: { name: 'f', arguments: '{}' } }] } }],
      }),
    );
    expect(a.finish(usage).stopReason).toBe('tool_use');
    const b = new ChatStreamAggregator('openai', 'm');
    b.push(ev('chunk', { choices: [{ delta: {}, finish_reason: 'length' }] }));
    expect(b.finish(usage).stopReason).toBe('max_tokens');
  });
});

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const secrets = new StaticSecretResolver({
  'k-openai': 'sk-openai-key-1234567890',
  'k-anthropic': 'sk-ant-key-1234567890',
  'k-hdr': 'hdr-secret-value-123',
  'k-aws': 'AKIAEXAMPLE0000000000',
  'k-aws-secret': 'aws-secret-value-000000',
});
const deps = { secrets };
const req = {
  model: 'm',
  messages: [{ role: 'user' as const, content: 'hi' }],
  maxTokens: 100,
};

describe('createStreamPlan', () => {
  const plan = async (cfg: ProviderConfig, model = 'm'): Promise<StreamPlan> => {
    const p = await createStreamPlan(cfg, { ...deps, fetchImpl: undefined }, { model });
    if (!p) throw new Error('expected a plan');
    return p;
  };

  it('has no plan for simulated providers and non-Anthropic Bedrock models', async () => {
    expect(
      await createStreamPlan({ kind: 'simulated', name: 's' }, deps, { model: 'x' }),
    ).toBeNull();
    expect(
      await createStreamPlan({ kind: 'bedrock', name: 'b', region: 'eu-central-1' }, deps, {
        model: 'amazon.nova-pro-v1:0',
      }),
    ).toBeNull();
  });

  it('builds an Anthropic plan with the body and the resolved secret', async () => {
    const p = await plan({
      kind: 'anthropic',
      name: 'a',
      apiKeySecret: 'k-anthropic',
      defaultMaxTokens: 77,
    });
    expect(p.surface).toBe('anthropic');
    expect(p.secrets).toEqual(['sk-ant-key-1234567890']);
    const body = p.buildBody({ model: 'm', messages: req.messages });
    expect(body).toMatchObject({ model: 'm', max_tokens: 77 });
    expect(p.transport.name).toBe('anthropic');
  });

  it('builds a Bedrock plan for Anthropic model ids only, with and without explicit credentials', async () => {
    const withKeys = await plan(
      {
        kind: 'bedrock',
        name: 'b',
        region: 'eu-central-1',
        accessKeyIdSecret: 'k-aws',
        secretAccessKeySecret: 'k-aws-secret',
      },
      'eu.anthropic.claude-sonnet-4',
    );
    expect(withKeys.secrets).toEqual(['AKIAEXAMPLE0000000000', 'aws-secret-value-000000']);
    expect(withKeys.surface).toBe('anthropic');
    const chain = await plan(
      { kind: 'bedrock', name: 'b', region: 'eu-central-1' },
      'anthropic.claude-3',
    );
    expect(chain.secrets).toEqual([]);
    await expect(
      createStreamPlan(
        { kind: 'bedrock', name: 'b', region: 'r', accessKeyIdSecret: 'k-aws' },
        deps,
        { model: 'anthropic.x' },
      ),
    ).rejects.toThrow(/both accessKeyIdSecret/);
  });

  it('builds OpenAI-family plans for every kind with the right parameter and headers', async () => {
    const body = (p: StreamPlan) => p.buildBody(req);
    const openai = await plan({
      kind: 'openai',
      name: 'o',
      baseUrl: 'https://api.openai.com/v1',
      apiKeySecret: 'k-openai',
      organization: 'org-1',
      headerSecrets: { 'x-extra': 'k-hdr' },
    });
    expect(body(openai)).toHaveProperty('max_completion_tokens', 100);
    expect(openai.secrets).toContain('sk-openai-key-1234567890');
    expect(openai.secrets).toContain('hdr-secret-value-123');
    const compat = await plan({
      kind: 'openai-compatible',
      name: 'c',
      baseUrl: 'http://x.example/v1',
      headers: { 'x-a': 'b' },
    });
    expect(body(compat)).toHaveProperty('max_tokens', 100);
    for (const cfg of [
      { kind: 'vllm', name: 'v', baseUrl: 'http://v.example/v1', apiKeySecret: 'k-openai' },
      { kind: 'lmstudio', name: 'l' },
      {
        kind: 'openrouter',
        name: 'r',
        apiKeySecret: 'k-openai',
        referer: 'https://a.example',
        title: 'T',
      },
      { kind: 'ollama', name: 'ol', baseUrl: 'http://ollama.example:11434/' },
      { kind: 'ollama', name: 'ol2' },
    ] as ProviderConfig[]) {
      const p = await plan(cfg);
      expect(p.surface).toBe('openai');
      expect(body(p)).toHaveProperty('max_tokens', 100);
    }
    const azure = await plan({
      kind: 'azure-openai',
      name: 'az',
      endpoint: 'https://r.openai.azure.com',
      apiVersion: '2024-10-21',
      apiKeySecret: 'k-openai',
      deployment: 'dep',
    });
    expect(body(azure)).toHaveProperty('max_completion_tokens', 100);
    expect(azure.secrets).toContain('sk-openai-key-1234567890');
  });

  it('streams end to end against a fake endpoint and aggregates the result', async () => {
    server = await startServer((_r, res) => {
      sseHead(res);
      res.end(
        openaiChunk({ role: 'assistant', content: '' }) +
          openaiChunk({ content: 'ok' }, 'stop') +
          openaiUsage({ prompt_tokens: 3, completion_tokens: 1 }) +
          DONE,
      );
    });
    const p = await plan({ kind: 'vllm', name: 'v', baseUrl: `${server.url}/v1` });
    const stream = await p.transport.open({ body: p.buildBody(req), model: 'm' });
    const agg = new ChatStreamAggregator(p.surface, 'm');
    for (const e of await collect(stream.events)) agg.push(e);
    expect(agg.finish(stream.result().usage).text).toBe('ok');
    expect(server.requests[0]?.url).toBe('/v1/chat/completions');
  });
});
