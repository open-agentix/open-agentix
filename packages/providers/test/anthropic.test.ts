import { describe, expect, it } from 'vitest';
import { AnthropicProvider, type AnthropicMessagesClient } from '../src/index.js';
import { fakeFetch, json } from './helpers.js';

function fakeClient(response: unknown) {
  const calls: unknown[] = [];
  const client: AnthropicMessagesClient = {
    messages: {
      create: async (body) => {
        calls.push(body);
        return response as never;
      },
    },
  };
  return { client, calls };
}

describe('AnthropicProvider', () => {
  it('maps messages, merges tool results and parses content blocks', async () => {
    const { client, calls } = fakeClient({
      model: 'claude-opus-5-5',
      content: [
        { type: 'text', text: 'Looking up ' },
        { type: 'tool_use', id: 'tu1', name: 'cve__lookup', input: { id: 'CVE-1' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 12, output_tokens: 4 },
    });
    const p = new AnthropicProvider({ name: 'anthropic', client });
    const res = await p.complete({
      model: 'claude-opus-5-5',
      system: 'sys',
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: 'calling',
          toolCalls: [
            { id: 'a', name: 't', args: {} },
            { id: 'b', name: 't', args: {} },
          ],
        },
        { role: 'tool', toolCallId: 'a', name: 't', content: 'r1' },
        { role: 'tool', toolCallId: 'b', name: 't', content: 'r2', isError: true },
      ],
      tools: [{ name: 't', inputSchema: { properties: {} } }],
      temperature: 0.5,
    });
    expect(res).toEqual({
      text: 'Looking up ',
      toolCalls: [{ id: 'tu1', name: 'cve__lookup', args: { id: 'CVE-1' } }],
      usage: { inputTokens: 12, outputTokens: 4 },
      stopReason: 'tool_use',
      model: 'claude-opus-5-5',
    });
    const body = calls[0] as {
      messages: { role: string; content: unknown }[];
      max_tokens: number;
      system: string;
      tools: unknown[];
      temperature: number;
    };
    expect(body.max_tokens).toBe(16000);
    expect(body.system).toBe('sys');
    expect(body.temperature).toBe(0.5);
    expect(body.tools).toEqual([
      { name: 't', description: '', input_schema: { type: 'object', properties: {} } },
    ]);
    expect(body.messages).toHaveLength(3);
    expect(body.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'r1' },
        { type: 'tool_result', tool_use_id: 'b', content: 'r2', is_error: true },
      ],
    });
  });

  it('maps refusals and unknown stop reasons; omits optional fields', async () => {
    const { client, calls } = fakeClient({
      model: 'm',
      content: [],
      stop_reason: 'refusal',
      usage: { input_tokens: 1, output_tokens: 0 },
    });
    const p = new AnthropicProvider({
      name: 'a',
      client,
      defaultMaxTokens: 99,
      clearance: 'confidential',
    });
    expect(
      (await p.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }] })).stopReason,
    ).toBe('refusal');
    expect(calls[0]).toEqual({
      model: 'm',
      max_tokens: 99,
      messages: [{ role: 'user', content: 'x' }],
    });
    const other = new AnthropicProvider({
      name: 'a',
      client: fakeClient({
        model: 'm',
        content: [{ type: 'thinking' }],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      }).client,
    });
    expect((await other.complete({ model: 'm', messages: [] })).stopReason).toBe('other');
  });

  it('uses the SDK with the guarded fetch (no real network)', async () => {
    const { fetch, calls } = fakeFetch([
      json({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 3, output_tokens: 1 },
      }),
    ]);
    const p = new AnthropicProvider({
      name: 'a',
      apiKey: 'sk-test',
      baseUrl: 'https://anthropic.internal',
      fetchImpl: fetch,
      maxRetries: 0,
    });
    const res = await p.complete({
      model: 'claude-opus-5-5',
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 10,
    });
    expect(res.text).toBe('hi');
    expect(calls[0]?.url).toBe('https://anthropic.internal/v1/messages');
    const headers = new Headers(
      calls[0]?.init?.headers as ConstructorParameters<typeof Headers>[0],
    );
    expect(headers.get('x-api-key')).toBe('sk-test');
    expect(headers.get('anthropic-version')).toBeTruthy();
  });
});
