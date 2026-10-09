import { describe, expect, it } from 'vitest';
import {
  PassthroughRequestError,
  parseAnthropicRequest,
  parseOpenAIRequest,
  protocolError,
  renderAnthropicMessage,
  renderOpenAICompletion,
  sanitizeAnthropicEvent,
  sanitizeEvent,
  sanitizeOpenAIChunk,
  synthesizeEvents,
  type ChatResponse,
  type WorkerModelResponse,
} from '../src/index.js';

const A = (extra: Record<string, unknown> = {}) => ({
  model: 'm',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
});
const O = (extra: Record<string, unknown> = {}) => ({
  model: 'm',
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
});

const refusal = (fn: () => unknown): PassthroughRequestError => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PassthroughRequestError);
    return e as PassthroughRequestError;
  }
  throw new Error('expected a refusal');
};

describe('parseAnthropicRequest', () => {
  it('flattens blocks for estimation and rebuilds the upstream body from validated fields', () => {
    const png = { type: 'base64', media_type: 'image/png', data: 'AAAA' };
    const req = parseAnthropicRequest(
      A({
        stream: true,
        system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look' },
              { type: 'image', source: png },
            ],
          },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'hmm', signature: 'sig' },
              { type: 'redacted_thinking', data: 'zzz' },
              { type: 'text', text: 'ok' },
              { type: 'tool_use', id: 't1', name: 'get', input: { a: 1 } },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 't1',
                is_error: true,
                content: [
                  { type: 'text', text: 'boom' },
                  { type: 'image', source: png },
                ],
              },
              { type: 'tool_result', tool_use_id: 't2', content: 'plain' },
              { type: 'tool_result', tool_use_id: 't3' },
            ],
          },
          { role: 'assistant', content: 'done' },
        ],
        tools: [
          { name: 'get', input_schema: { properties: {} }, cache_control: { type: 'ephemeral' } },
        ],
        tool_choice: { type: 'tool', name: 'get', disable_parallel_tool_use: true },
        temperature: 0.5,
        top_p: 0.9,
        top_k: 5,
        stop_sequences: ['END'],
        thinking: { type: 'enabled', budget_tokens: 5000 },
        metadata: { user_id: 'u' },
      }),
    );
    expect(req).toMatchObject({ surface: 'anthropic', model: 'm', stream: true, images: 2 });
    expect(req.requestedMaxTokens).toBe(100);
    expect(req.chat.system).toBe('sys');
    expect(req.chat.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'tool',
      'assistant',
    ]);
    expect(req.chat.messages[2]).toMatchObject({ name: 'get', isError: true, content: 'boom' });
    expect(req.chat.messages[3]).toMatchObject({ name: 'tool' });
    const body = req.build(8000);
    expect(body).toMatchObject({
      model: 'm',
      max_tokens: 8000,
      temperature: 0.5,
      top_p: 0.9,
      top_k: 5,
      stop_sequences: ['END'],
      tool_choice: { type: 'tool', name: 'get' },
      thinking: { type: 'enabled', budget_tokens: 5000 },
      tools: [{ name: 'get', description: '', input_schema: { type: 'object', properties: {} } }],
    });
    expect(body).not.toHaveProperty('metadata');
    expect(body).not.toHaveProperty('stream');
    // the thinking budget stays below the clamped output bound
    expect((req.build(2000).thinking as { budget_tokens: number }).budget_tokens).toBe(1999);
    expect(req.extraBytes).toBeGreaterThan(0);
  });

  it('keeps a disabled thinking setting and a plain string system prompt', () => {
    const req = parseAnthropicRequest(A({ system: 'plain', thinking: { type: 'disabled' } }));
    expect(req.build(10)).toMatchObject({ system: 'plain', thinking: { type: 'disabled' } });
    expect(req.stream).toBe(false);
  });

  it.each([
    ['a typed tool', A({ tools: [{ type: 'bash_20250124', name: 'bash' }] })],
    [
      'a server_tool_use block',
      A({ messages: [{ role: 'user', content: [{ type: 'server_tool_use' }] }] }),
    ],
    [
      'a nested document',
      A({
        messages: [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'document' }] }],
          },
        ],
      }),
    ],
    [
      'a non-base64 image',
      A({
        messages: [
          { role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'http://x' } }] },
        ],
      }),
    ],
    ['unknown top-level keys', A({ mcp_servers: [] })],
    ['unknown nested keys', A({ messages: [{ role: 'user', content: 'x', extra: 1 }] })],
    ['thinking without stream', A({ thinking: { type: 'enabled', budget_tokens: 2000 } })],
    ['a document system block', A({ system: [{ type: 'document' }] })],
  ])('refuses %s as a parameter refusal', (_n, body) => {
    expect(refusal(() => parseAnthropicRequest(body)).code).toBe('model_parameter_refused');
  });

  it.each([
    ['a non-object', 'x'],
    ['a missing max_tokens', { model: 'm', messages: [{ role: 'user', content: 'x' }] }],
    ['a bad role', A({ messages: [{ role: 'system', content: 'x' }] })],
    ['an out-of-range temperature', A({ temperature: 5 })],
    ['a bad tool name', A({ tools: [{ name: 'a b', input_schema: {} }] })],
    [
      'a prototype key in a tool schema',
      A({ tools: [{ name: 'a', input_schema: JSON.parse('{"__proto__":{"x":1}}') }] }),
    ],
  ])('refuses %s as an invalid request', (_n, body) => {
    const e = refusal(() => parseAnthropicRequest(body));
    expect(e.code).toBe('model_request_invalid');
    expect(e.message).not.toContain('evil');
  });

  it('refuses more than 20 images', () => {
    const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } };
    const e = refusal(() =>
      parseAnthropicRequest(
        A({ messages: [{ role: 'user', content: Array.from({ length: 21 }, () => img) }] }),
      ),
    );
    expect(e.code).toBe('model_parameter_refused');
  });

  it('never echoes parameter values and cuts parameter names', () => {
    const e = refusal(() => parseAnthropicRequest(A({ 'evil-key<script>': 'secret-value' })));
    expect(e.message).not.toContain('secret-value');
    expect(e.message).not.toContain('<');
  });
});

describe('parseOpenAIRequest', () => {
  it('flattens roles and rebuilds the upstream body', () => {
    const uri = 'data:image/png;base64,AAAA';
    const req = parseOpenAIRequest(
      O({
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: 50,
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'developer', content: [{ type: 'text', text: 'dev' }] },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look' },
              { type: 'image_url', image_url: { url: uri, detail: 'low' } },
            ],
          },
          {
            role: 'assistant',
            content: null,
            refusal: 'no',
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'get', arguments: '{"a":1}' } },
              { id: 'c2', type: 'function', function: { name: 'get', arguments: 'not json' } },
            ],
          },
          { role: 'tool', tool_call_id: 'c1', content: 'r1' },
          { role: 'tool', tool_call_id: 'zz', content: [{ type: 'text', text: 'r2' }] },
          { role: 'assistant', content: 'fin' },
          { role: 'user', content: 'again' },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get',
              description: 'd',
              parameters: { type: 'object' },
              strict: true,
            },
          },
          { type: 'function', function: { name: 'bare' } },
        ],
        tool_choice: { type: 'function', function: { name: 'get' } },
        parallel_tool_calls: false,
        temperature: 1,
        top_p: 0.5,
        stop: ['x'],
        seed: 7,
        n: 1,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'o', schema: { type: 'object' } },
        },
        reasoning_effort: 'low',
        user: 'u',
      }),
    );
    expect(req).toMatchObject({ surface: 'openai', stream: true, includeUsage: true, images: 1 });
    expect(req.requestedMaxTokens).toBe(50);
    expect(req.chat.system).toBe('be brief\ndev');
    expect(req.chat.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'no',
      toolCalls: [
        { id: 'c1', args: { a: 1 } },
        { id: 'c2', args: { _raw: 'not json' } },
      ],
    });
    expect(req.chat.messages[2]).toMatchObject({ role: 'tool', name: 'get' });
    expect(req.chat.messages[3]).toMatchObject({ role: 'tool', name: 'tool', content: 'r2' });
    const body = req.build(77, { maxTokensParam: 'max_completion_tokens' });
    expect(body).toMatchObject({
      model: 'm',
      max_completion_tokens: 77,
      parallel_tool_calls: false,
      temperature: 1,
      top_p: 0.5,
      stop: ['x'],
      seed: 7,
      reasoning_effort: 'low',
      tool_choice: { type: 'function' },
    });
    expect(body).not.toHaveProperty('user');
    expect(body).not.toHaveProperty('n');
    expect(body).not.toHaveProperty('stream_options');
    expect(body).not.toHaveProperty('max_tokens');
    const msgs = body.messages as { role: string }[];
    expect(msgs.slice(0, 2).map((m) => m.role)).toEqual(['system', 'system']);
    expect(req.build(5).max_tokens).toBe(5);
  });

  it('reads max_tokens when max_completion_tokens is absent and a plain stop string', () => {
    const req = parseOpenAIRequest(O({ max_tokens: 9, stop: 'x', tool_choice: 'required' }));
    expect(req.requestedMaxTokens).toBe(9);
    expect(req.stream).toBe(false);
    expect(req.includeUsage).toBe(false);
    expect(req.build(9)).toMatchObject({ stop: 'x', tool_choice: 'required' });
  });

  it.each([
    ['n above 1', O({ n: 2 })],
    ['a non-function tool', O({ tools: [{ type: 'web_search' }] })],
    [
      'an http image',
      O({
        messages: [
          { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }] },
        ],
      }),
    ],
    ['a file part', O({ messages: [{ role: 'user', content: [{ type: 'file' }] }] })],
    ['unknown keys', O({ logprobs: true })],
    [
      'an oversized response_format',
      O({
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'o', schema: { d: 'x'.repeat(40_000) } },
        },
      }),
    ],
  ])('refuses %s as a parameter refusal', (_n, body) => {
    expect(refusal(() => parseOpenAIRequest(body)).code).toBe('model_parameter_refused');
  });

  it.each([
    ['a non-object', 5],
    ['no messages', O({ messages: [] })],
    [
      'a bad data URI',
      O({
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'data:text/html;base64,AA' } }],
          },
        ],
      }),
    ],
  ])('refuses %s as an invalid request', (_n, body) => {
    expect(refusal(() => parseOpenAIRequest(body)).code).toBe('model_request_invalid');
  });

  it('refuses more than 20 images', () => {
    const img = { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } };
    expect(
      refusal(() =>
        parseOpenAIRequest(
          O({ messages: [{ role: 'user', content: Array.from({ length: 21 }, () => img) }] }),
        ),
      ).code,
    ).toBe('model_parameter_refused');
  });
});

describe('sanitizeAnthropicEvent', () => {
  const ev = (event: string, data: Record<string, unknown>) => ({ event, data });
  it('rebuilds each event type from allowlisted fields', () => {
    expect(
      sanitizeAnthropicEvent(
        ev('message_start', {
          message: { id: 'm', model: 'x', evil: 1, usage: { input_tokens: 3, evil: 1 } },
          evil: 1,
        }),
      ),
    ).toEqual({
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'm',
          type: 'message',
          role: 'assistant',
          model: 'x',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 3 },
        },
      },
    });
    expect(sanitizeAnthropicEvent(ev('message_start', {}))?.data).toMatchObject({
      message: { id: 'msg_proxy', usage: { input_tokens: 0, output_tokens: 0 } },
    });
    const start = (block: Record<string, unknown>) =>
      sanitizeAnthropicEvent(ev('content_block_start', { index: 2, content_block: block, evil: 1 }))
        ?.data.content_block;
    expect(start({ type: 'text', text: 'a', evil: 1 })).toEqual({ type: 'text', text: 'a' });
    expect(start({ type: 'thinking', thinking: 't' })).toEqual({ type: 'thinking', thinking: 't' });
    expect(start({ type: 'redacted_thinking', data: 'd' })).toEqual({
      type: 'redacted_thinking',
      data: 'd',
    });
    expect(start({ type: 'tool_use', id: 'i', name: 'n', input: { evil: 1 } })).toEqual({
      type: 'tool_use',
      id: 'i',
      name: 'n',
      input: {},
    });
    expect(start({ type: 'server_tool_use' })).toBeUndefined();
    const delta = (d: Record<string, unknown>) =>
      sanitizeAnthropicEvent(ev('content_block_delta', { index: 99999, delta: d }))?.data;
    expect(delta({ type: 'text_delta', text: 'x', evil: 1 })).toEqual({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'x' },
    });
    expect(delta({ type: 'thinking_delta', thinking: 't' })?.delta).toEqual({
      type: 'thinking_delta',
      thinking: 't',
    });
    expect(delta({ type: 'input_json_delta', partial_json: '{' })?.delta).toEqual({
      type: 'input_json_delta',
      partial_json: '{',
    });
    expect(delta({ type: 'signature_delta', signature: 's' })?.delta).toEqual({
      type: 'signature_delta',
      signature: 's',
    });
    expect(delta({ type: 'citations_delta' })).toBeUndefined();
    expect(sanitizeAnthropicEvent(ev('content_block_stop', { index: 1, x: 1 }))?.data).toEqual({
      type: 'content_block_stop',
      index: 1,
    });
    expect(
      sanitizeAnthropicEvent(
        ev('message_delta', {
          delta: { stop_reason: 'end_turn', evil: 1 },
          usage: { output_tokens: 4, evil: 1 },
        }),
      )?.data,
    ).toEqual({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 4 },
    });
    expect(sanitizeAnthropicEvent(ev('message_delta', {}))?.data).toMatchObject({
      usage: { output_tokens: 0 },
    });
    expect(sanitizeAnthropicEvent(ev('message_stop', { evil: 1 }))?.data).toEqual({
      type: 'message_stop',
    });
    expect(sanitizeAnthropicEvent(ev('ping', {}))).toBeNull();
    expect(sanitizeEvent('anthropic', ev('x_evil', {}), { includeUsage: false })).toBeNull();
  });
});

describe('sanitizeOpenAIChunk', () => {
  const chunk = (data: Record<string, unknown>) => ({ event: 'chunk', data });
  it('rebuilds choices, drops extras and gates the usage chunk', () => {
    const out = sanitizeOpenAIChunk(
      chunk({
        id: 'c',
        created: 5,
        model: 'm',
        system_fingerprint: 'LEAK',
        choices: [
          {
            index: 0,
            finish_reason: 'weird',
            logprobs: 'LEAK',
            delta: {
              role: 'assistant',
              content: 'hi',
              reasoning_content: 'r',
              refusal: 'no',
              hidden: 'LEAK',
              tool_calls: [
                { index: 0, id: 'c1', function: { name: 'f', arguments: '{', evil: 1 }, evil: 1 },
                { index: 0, function: { arguments: '}' } },
                'junk',
              ],
            },
          },
          { index: 1, delta: { content: 'second choice' } },
          'junk',
        ],
      }),
      { includeUsage: false },
    );
    expect(out).toEqual({
      event: 'chunk',
      data: {
        id: 'c',
        object: 'chat.completion.chunk',
        created: 5,
        model: 'm',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            delta: {
              role: 'assistant',
              content: 'hi',
              reasoning_content: 'r',
              refusal: 'no',
              tool_calls: [
                { index: 0, id: 'c1', type: 'function', function: { name: 'f', arguments: '{' } },
                { index: 0, function: { arguments: '}' } },
              ],
            },
          },
        ],
      },
    });
    const usage = chunk({
      id: 'c',
      choices: [],
      usage: {
        prompt_tokens: 3,
        completion_tokens: 4,
        prompt_tokens_details: { cached_tokens: 1, evil: 1 },
      },
    });
    expect(sanitizeOpenAIChunk(usage, { includeUsage: false })).toBeNull();
    expect(sanitizeOpenAIChunk(usage, { includeUsage: true })?.data.usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 4,
      total_tokens: 7,
      prompt_tokens_details: { cached_tokens: 1 },
    });
    expect(
      sanitizeOpenAIChunk(chunk({ choices: [], usage: { evil: 1 } }), { includeUsage: true }),
    ).toBeNull();
    expect(sanitizeOpenAIChunk({ event: 'other', data: {} }, { includeUsage: true })).toBeNull();
    expect(
      sanitizeOpenAIChunk(
        chunk({ choices: [{ index: 0, delta: { content: null }, finish_reason: 'length' }] }),
        { includeUsage: false },
      )?.data.choices,
    ).toEqual([{ index: 0, delta: { content: null }, finish_reason: 'length' }]);
    expect(
      sanitizeEvent('openai', chunk({ choices: [{ delta: {} }] }), { includeUsage: false }),
    ).not.toBeNull();
  });
});

describe('protocol errors, rendering and synthesis', () => {
  it('shapes errors per protocol with the platform code', () => {
    expect(protocolError('anthropic', 'model_rate_limited', 'slow down')).toEqual({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: 'model_rate_limited: slow down',
        code: 'model_rate_limited',
      },
    });
    expect(protocolError('openai', 'provider_error', 'x')).toEqual({
      error: { message: 'provider_error: x', type: 'server_error', code: 'provider_error' },
    });
    expect(protocolError('openai', 'model_token_already_issued', 'x')).toMatchObject({
      error: { type: 'invalid_request_error' },
    });
  });

  const out = (over: Partial<WorkerModelResponse['response']> = {}): WorkerModelResponse => ({
    callId: 'abc-123',
    response: {
      text: 'hi',
      toolCalls: [{ id: 't1', name: 'f', args: { a: 1 } }],
      usage: { inputTokens: 1, outputTokens: 2 },
      stopReason: 'tool_use',
      model: 'm',
      ...over,
    },
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      source: 'provider',
    },
    costMicros: 1,
    priced: true,
    remaining: {},
  });

  it('renders both JSON shapes from the settled usage', () => {
    expect(renderAnthropicMessage(out())).toMatchObject({
      id: 'msg_abc123',
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'tool_use', input: { a: 1 } },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 2,
      },
    });
    expect(
      renderAnthropicMessage(out({ text: '', toolCalls: [], stopReason: 'other' })),
    ).toMatchObject({
      content: [],
      stop_reason: 'end_turn',
    });
    expect(renderOpenAICompletion(out())).toMatchObject({
      id: 'chatcmpl-abc123',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: { content: 'hi', tool_calls: [{ function: { arguments: '{"a":1}' } }] },
        },
      ],
      usage: {
        prompt_tokens: 15,
        completion_tokens: 5,
        total_tokens: 20,
        prompt_tokens_details: { cached_tokens: 3 },
      },
    });
    expect(
      renderOpenAICompletion(out({ text: '', toolCalls: [], stopReason: 'end_turn' })),
    ).toMatchObject({
      choices: [{ message: { content: '' }, finish_reason: 'stop' }],
    });
    expect(renderOpenAICompletion(out({ text: '', stopReason: 'max_tokens' }))).toMatchObject({
      choices: [{ message: { content: null }, finish_reason: 'length' }],
    });
  });

  const res: ChatResponse = {
    text: 'hello',
    toolCalls: [{ id: 't1', name: 'f', args: { a: 1 } }],
    usage: { inputTokens: 4, outputTokens: 6 },
    stopReason: 'tool_use',
    model: 'sim',
  };

  it('synthesises sanitizable events for a response without a stream', () => {
    const a = synthesizeEvents('anthropic', res, 'c1');
    const sa = a.map((e) => sanitizeAnthropicEvent(e));
    expect(sa.every((e) => e !== null)).toBe(true);
    expect(sa.map((e) => e!.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect(synthesizeEvents('anthropic', { ...res, text: '', toolCalls: [] }, 'c').length).toBe(3);
    const o = synthesizeEvents('openai', res, 'c1').map((e) =>
      sanitizeOpenAIChunk(e, { includeUsage: true }),
    );
    expect(o.every((e) => e !== null)).toBe(true);
    expect(o.at(-1)!.data.usage).toMatchObject({ prompt_tokens: 4, completion_tokens: 6 });
    expect(synthesizeEvents('openai', { ...res, text: '', toolCalls: [] }, 'c').length).toBe(3);
  });
});
