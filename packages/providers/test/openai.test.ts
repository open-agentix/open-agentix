import { describe, expect, it } from 'vitest';
import { OpenAICompatibleProvider, type ChatRequest } from '../src/index.js';
import { fakeFetch, json } from './helpers.js';

const req: ChatRequest = {
  model: 'gpt-x',
  system: 'sys',
  messages: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'db__q', args: { a: 1 } }] },
    { role: 'tool', toolCallId: 'c1', name: 'db__q', content: '{"rows":1}' },
    { role: 'assistant', content: 'plain' },
  ],
  tools: [{ name: 'db__q', inputSchema: { type: 'object' } }],
  maxTokens: 100,
  temperature: 0,
};

describe('OpenAICompatibleProvider', () => {
  it('maps requests and responses (tool calls, usage, auth, azure query)', async () => {
    const { fetch, calls } = fakeFetch([
      json({
        model: 'gpt-x-2026',
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: 't1', type: 'function', function: { name: 'db__q', arguments: '{"b":2}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    ]);
    const p = new OpenAICompatibleProvider({
      name: 'openai',
      baseUrl: 'https://api.example.com/v1/',
      apiKey: 'k',
      headers: { 'x-extra': '1' },
      query: 'api-version=1',
      fetchImpl: fetch,
    });
    const res = await p.complete(req);
    expect(res).toEqual({
      text: '',
      toolCalls: [{ id: 't1', name: 'db__q', args: { b: 2 } }],
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: 'tool_use',
      model: 'gpt-x-2026',
    });
    expect(calls[0]?.url).toBe('https://api.example.com/v1/chat/completions?api-version=1');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer k');
    expect(headers['x-extra']).toBe('1');
    const body = calls[0]?.body as {
      messages: unknown[];
      tools: unknown[];
      max_tokens: number;
      temperature: number;
    };
    expect(body.messages).toHaveLength(5);
    expect(body.messages[2]).toMatchObject({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1' }],
    });
    expect(body.messages[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '{"rows":1}' });
    expect(body.messages[4]).toEqual({ role: 'assistant', content: 'plain' });
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: { name: 'db__q', description: '', parameters: { type: 'object' } },
      },
    ]);
    expect(body.max_tokens).toBe(100);
    expect(body.temperature).toBe(0);
    expect(p.clearance).toBe('internal');
    expect(p.kind).toBe('openai');
  });

  it('handles minimal responses', async () => {
    const { fetch, calls } = fakeFetch([
      json({ choices: [{ message: { content: 'done' }, finish_reason: 'weird' }] }),
      json({ choices: [] }),
    ]);
    const p = new OpenAICompatibleProvider({
      name: 'vllm',
      baseUrl: 'http://vllm:8000/v1',
      clearance: 'confidential',
      fetchImpl: fetch,
    });
    const res = await p.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
    expect(res).toMatchObject({
      text: 'done',
      stopReason: 'other',
      usage: { inputTokens: 0, outputTokens: 0 },
      model: 'm',
    });
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBeUndefined();
    expect(calls[0]?.body).toEqual({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
    expect((await p.complete({ model: 'm', messages: [] })).text).toBe('');
  });
});
