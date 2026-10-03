import { describe, expect, it } from 'vitest';
import { OllamaProvider } from '../src/index.js';
import { fakeFetch, json } from './helpers.js';

describe('OllamaProvider', () => {
  it('maps chat with tools', async () => {
    const { fetch, calls } = fakeFetch([
      json({
        model: 'llama3.2',
        message: {
          content: '',
          tool_calls: [{ function: { name: 'cve__lookup', arguments: { id: 'CVE-1' } } }],
        },
        done_reason: 'stop',
        prompt_eval_count: 7,
        eval_count: 3,
      }),
    ]);
    const p = new OllamaProvider({ name: 'ollama', fetchImpl: fetch });
    const res = await p.complete({
      model: 'llama3.2',
      system: 's',
      messages: [
        { role: 'user', content: 'u' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'x', name: 'cve__lookup', args: { id: 'CVE-0' } }],
        },
        { role: 'tool', toolCallId: 'x', name: 'cve__lookup', content: 'r' },
        { role: 'assistant', content: 'a' },
      ],
      tools: [{ name: 'cve__lookup', description: 'd', inputSchema: {} }],
      temperature: 0.2,
      maxTokens: 50,
    });
    expect(res).toEqual({
      text: '',
      toolCalls: [{ id: 'call_0', name: 'cve__lookup', args: { id: 'CVE-1' } }],
      usage: { inputTokens: 7, outputTokens: 3 },
      stopReason: 'tool_use',
      model: 'llama3.2',
    });
    expect(calls[0]?.url).toBe('http://localhost:11434/api/chat');
    expect(calls[0]?.body).toMatchObject({
      stream: false,
      options: { temperature: 0.2, num_predict: 50 },
      messages: [
        { role: 'system', content: 's' },
        { role: 'user', content: 'u' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'cve__lookup', arguments: { id: 'CVE-0' } } }],
        },
        { role: 'tool', content: 'r', tool_name: 'cve__lookup' },
        { role: 'assistant', content: 'a' },
      ],
    });
    expect(p.clearance).toBe('restricted');
  });

  it('maps stop reasons and missing fields', async () => {
    const { fetch, calls } = fakeFetch([
      json({ message: {}, done_reason: 'length' }),
      json({ message: { content: 'ok' } }),
    ]);
    const p = new OllamaProvider({
      name: 'o',
      baseUrl: 'http://gpu:11434/',
      clearance: 'internal',
      fetchImpl: fetch,
    });
    expect((await p.complete({ model: 'm', messages: [] })).stopReason).toBe('max_tokens');
    const r = await p.complete({ model: 'm', messages: [] });
    expect(r).toMatchObject({
      text: 'ok',
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(calls[0]?.body).toEqual({ model: 'm', messages: [], stream: false });
  });
});
