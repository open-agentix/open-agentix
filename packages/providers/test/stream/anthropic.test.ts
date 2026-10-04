import { afterEach, describe, expect, it } from 'vitest';
import {
  AnthropicStreamTransport,
  ProviderError,
  StreamAbortedError,
  StreamError,
  type AnthropicStreamOptions,
  type UpstreamStream,
} from '../../src/index.js';
import {
  anthropicText,
  collect,
  frame,
  sseHead,
  startServer,
  waitFor,
  type FakeServer,
  type Handler,
} from './fake-server.js';

const KEY = 'sk-ant-secret-key-1234567890';
let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function open(
  handler: Handler,
  opts: Partial<AnthropicStreamOptions> = {},
  call: Parameters<AnthropicStreamTransport['open']>[1] = {},
): Promise<UpstreamStream> {
  server = await startServer(handler);
  const t = new AnthropicStreamTransport({
    baseUrl: server.url,
    apiKey: KEY,
    backoffMs: 5,
    ...opts,
  });
  return t.open({ body: { model: 'claude-x', max_tokens: 100, messages: [] } }, call);
}

const write =
  (text: string): Handler =>
  (_r, res) => {
    sseHead(res);
    res.end(text);
  };

describe('AnthropicStreamTransport', () => {
  it('streams text, drops ping, and extracts provider usage', async () => {
    const s = await open(
      write(anthropicText({ input_tokens: 25, output_tokens: 1 }, { output_tokens: 15 })),
    );
    const events = await collect(s.events);
    expect(events.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    const r = s.result();
    expect(r).toMatchObject({
      complete: true,
      source: 'provider',
      usageReported: true,
      outputBytes: Buffer.byteLength('Hello wörld'),
      usage: { inputTokens: 25, outputTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(s.status).toBe(200);
  });

  it('sends a configuration-built request: forced stream, key, version, no client headers', async () => {
    const s = await open(
      write(anthropicText()),
      {},
      { anthropicBeta: ['prompt-caching-2024-07-31'] },
    );
    await collect(s.events);
    const req = server!.requests[0]!;
    expect(req.url).toBe('/v1/messages');
    expect(req.headers['x-api-key']).toBe(KEY);
    expect(req.headers['anthropic-version']).toBe('2023-06-01');
    expect(req.headers['anthropic-beta']).toBe('prompt-caching-2024-07-31');
    expect(JSON.parse(req.body)).toMatchObject({ stream: true, model: 'claude-x' });
  });

  it('refuses CRLF or unknown characters in anthropic-beta before any request', async () => {
    server = await startServer(write(anthropicText()));
    const t = new AnthropicStreamTransport({ baseUrl: server.url, apiKey: KEY });
    await expect(
      t.open({ body: {} }, { anthropicBeta: ['x\r\nx-evil: 1'] }),
    ).rejects.toBeInstanceOf(StreamError);
    expect(server.requests).toHaveLength(0);
  });

  it('records cache tokens and tool-input bytes (tool use and thinking)', async () => {
    const body =
      frame('message_start', {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 2000,
            cache_creation_input_tokens: 300,
            output_tokens: 1,
          },
        },
      }) +
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      }) +
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'hmm' },
      }) +
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig' },
      }) +
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      frame('content_block_start', {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 't', name: 'f', input: {} },
      }) +
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"a":' },
      }) +
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '1}' },
      }) +
      frame('content_block_stop', { type: 'content_block_stop', index: 1 }) +
      frame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 40 },
      }) +
      frame('message_stop', { type: 'message_stop' });
    const s = await open(write(body));
    await collect(s.events);
    expect(s.result()).toMatchObject({
      usage: { inputTokens: 10, outputTokens: 40, cacheReadTokens: 2000, cacheWriteTokens: 300 },
      outputBytes: 3 + 5 + 2,
      source: 'provider',
    });
  });

  it('flags missing usage for the estimator fallback', async () => {
    const s = await open(write(anthropicText({}, null)), {}, { inputEstimate: 500 });
    await collect(s.events);
    const r = s.result();
    expect(r.complete).toBe(true);
    expect(r.usageReported).toBe(false);
    expect(r.source).toBe('estimated');
    expect(r.usage.inputTokens).toBe(500);
    expect(r.usage.outputTokens).toBe(Math.ceil(Buffer.byteLength('Hello wörld') / 3));
  });

  it('drops and counts unknown event types and unknown delta types; none are relayed', async () => {
    const body =
      frame('message_start', {
        type: 'message_start',
        message: { usage: { input_tokens: 1, output_tokens: 1 } },
      }) +
      frame('evil_event', { type: 'evil_event', payload: 'x' }) +
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'citations_delta' },
      }) +
      frame('message_delta', { type: 'message_delta', usage: { output_tokens: 1 } }) +
      frame('message_stop', { type: 'message_stop' });
    const s = await open(write(body));
    const events = await collect(s.events);
    expect(events.map((e) => e.event)).toEqual(['message_start', 'message_delta', 'message_stop']);
    expect(s.result().unknownEvents).toBe(2);
  });

  it('refuses frame smuggling: event line and payload type disagree', async () => {
    const body = frame('message_start', { type: 'message_stop' });
    const s = await open(write(body));
    await expect(collect(s.events)).rejects.toMatchObject({ reason: 'invalid_event' });
  });

  it('refuses unknown content block types (server tools) and non-JSON / typeless payloads', async () => {
    for (const [body, reason] of [
      [
        frame('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'server_tool_use' },
        }),
        'invalid_event',
      ],
      [frame('message_start', 'not json'), 'invalid_json'],
      [frame('message_start', '[1,2]'), 'invalid_event'],
      [frame('message_start', { nope: 1 }), 'invalid_event'],
    ] as const) {
      const s = await open(write(body));
      await expect(collect(s.events)).rejects.toMatchObject({ reason });
      await server?.close();
    }
  });

  it('turns an upstream error event into a controlled, scrubbed error', async () => {
    const body =
      frame('message_start', { type: 'message_start', message: { usage: { input_tokens: 3 } } }) +
      frame('error', {
        type: 'error',
        error: { type: 'overloaded_error', message: `Overloaded, key ${KEY}` },
      });
    const s = await open(write(body));
    const err = await collect(s.events).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StreamError);
    expect((err as Error).message).toContain('overloaded_error');
    expect((err as Error).message).not.toContain(KEY);
    expect(s.result().complete).toBe(false);
  });

  it('ends in a controlled error when the stream stops before message_stop', async () => {
    const s = await open(write(anthropicText().split('event: message_stop')[0]!));
    await expect(collect(s.events)).rejects.toMatchObject({ reason: 'truncated' });
    expect(s.result().complete).toBe(false);
  });

  it('ends in a controlled error when the last event has no terminator', async () => {
    const s = await open(write(anthropicText().trimEnd()));
    // message_stop without the final blank line is still pending, so the stream is incomplete
    await expect(collect(s.events)).rejects.toMatchObject({ reason: 'truncated' });
  });

  it('maps upstream HTTP errors with a scrubbed, truncated message and no retry for 4xx', async () => {
    const msg = `invalid x-api-key ${KEY} ` + 'x'.repeat(2000);
    await expect(
      open((_r, res) => {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: msg } }),
        );
      }),
    ).rejects.toSatisfy((e: unknown) => {
      const m = (e as Error).message;
      return (
        e instanceof ProviderError &&
        e.status === 401 &&
        !m.includes(KEY) &&
        m.length < 400 &&
        m.includes('authentication_error')
      );
    });
    expect(server!.requests).toHaveLength(1);
  });

  it('retries 5xx and network errors only before the first byte', async () => {
    const s = await open((r, res, n) => {
      if (n === 1) {
        res.writeHead(503);
        res.end('busy');
      } else if (n === 2) res.socket?.destroy();
      else {
        sseHead(res);
        res.end(anthropicText());
      }
    });
    await collect(s.events);
    expect(server!.requests).toHaveLength(3);
    expect(s.result().complete).toBe(true);
  });

  it('does not retry once streaming started (mid-stream failure surfaces)', async () => {
    const s = await open((_r, res) => {
      sseHead(res);
      res.write(anthropicText().split('event: content_block_start')[0]!);
      setTimeout(() => res.socket?.destroy(), 20);
    });
    await expect(collect(s.events)).rejects.toBeInstanceOf(StreamError);
    expect(server!.requests).toHaveLength(1);
  });

  it('gives up after the retries and reports status without echoing secrets', async () => {
    await expect(
      open(
        (_r, res) => {
          res.writeHead(500);
          res.end(`oops ${KEY}`);
        },
        { maxRetries: 1 },
      ),
    ).rejects.toMatchObject({ status: 500 });
    expect(server!.requests).toHaveLength(2);
  });

  it('refuses a non event-stream answer and redirects', async () => {
    await expect(
      open((_r, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      }),
    ).rejects.toMatchObject({ reason: 'bad_content_type' });
    await server?.close();
    await expect(
      open(
        (_r, res) => {
          res.writeHead(302, { location: 'http://127.0.0.1:1/steal' });
          res.end();
        },
        { maxRetries: 0 },
      ),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(server!.requests).toHaveLength(1);
  });

  it('refuses a network error after retries without leaking the key', async () => {
    const t = new AnthropicStreamTransport({
      baseUrl: 'http://127.0.0.1:1',
      apiKey: KEY,
      maxRetries: 0,
    });
    const err = await t.open({ body: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).not.toContain(KEY);
  });

  it('strictly enforces the configured origin (guarded fetch)', async () => {
    server = await startServer(write(anthropicText()));
    const t = new AnthropicStreamTransport({
      baseUrl: server.url,
      fetchImpl: async () => {
        throw new Error('must not be reached');
      },
    });
    await expect(t.open({ body: {} })).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('Anthropic stream limits and abort', () => {
  it('cuts an over-long SSE line', async () => {
    const s = await open(write(`data: ${'a'.repeat(5000)}\n\n`), {
      limits: { maxLineBytes: 1024 },
    });
    await expect(collect(s.events)).rejects.toMatchObject({ reason: 'line_too_large' });
  });

  it('cuts an event over the event limit (many small lines, no blank line)', async () => {
    const s = await open(write('data: x\n'.repeat(5000)), { limits: { maxEventBytes: 2048 } });
    await expect(collect(s.events)).rejects.toMatchObject({ reason: 'event_too_large' });
  });

  it('cuts an endless stream at the size limit and closes the upstream socket', async () => {
    let timer: NodeJS.Timeout | undefined;
    const s = await open(
      (_r, res) => {
        sseHead(res);
        timer = setInterval(
          () => res.write(frame('ping', { type: 'ping' }).repeat(50) + ': pad\n\n'),
          1,
        );
        res.on('close', () => clearInterval(timer));
      },
      { limits: { maxTotalBytes: 20_000 } },
    );
    await expect(collect(s.events)).rejects.toMatchObject({ reason: 'response_too_large' });
    await waitFor(() => server!.abortedResponses() === 1);
    clearInterval(timer);
  });

  it('times out an upstream that sends nothing (time to first event)', async () => {
    const s = await open(
      (_r, res) => {
        sseHead(res);
        res.write(': hi\n\n');
      },
      { limits: { ttfbMs: 100 } },
    );
    await expect(collect(s.events)).rejects.toMatchObject({
      code: 'provider_timeout',
      reason: 'ttfb_timeout',
    });
    await waitFor(() => server!.abortedResponses() === 1);
  });

  it('times out before response headers arrive', async () => {
    await expect(open(() => undefined, { limits: { ttfbMs: 100 } })).rejects.toMatchObject({
      code: 'provider_timeout',
    });
  });

  it('slow-loris: trickled bytes and comments do not reset the idle timeout', async () => {
    const start = anthropicText().split('event: content_block_start')[0]!;
    let timer: NodeJS.Timeout | undefined;
    const s = await open(
      (_r, res) => {
        sseHead(res);
        res.write(start);
        timer = setInterval(() => res.write(': tick\n'), 20);
        res.on('close', () => clearInterval(timer));
      },
      { limits: { idleMs: 200 } },
    );
    const t0 = Date.now();
    await expect(collect(s.events)).rejects.toMatchObject({
      code: 'provider_timeout',
      reason: 'idle_timeout',
    });
    expect(Date.now() - t0).toBeLessThan(2000);
    await waitFor(() => server!.abortedResponses() === 1);
    clearInterval(timer);
  });

  it('enforces the overall call deadline for a stream that keeps emitting events', async () => {
    let timer: NodeJS.Timeout | undefined;
    const s = await open(
      (_r, res) => {
        sseHead(res);
        res.write(
          frame('message_start', {
            type: 'message_start',
            message: { usage: { input_tokens: 1 } },
          }),
        );
        timer = setInterval(
          () =>
            res.write(
              frame('content_block_delta', {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'a' },
              }),
            ),
          20,
        );
        res.on('close', () => clearInterval(timer));
      },
      { limits: { deadlineMs: 300 } },
    );
    await expect(collect(s.events)).rejects.toMatchObject({
      code: 'provider_timeout',
      reason: 'deadline',
    });
    await waitFor(() => server!.abortedResponses() === 1);
    clearInterval(timer);
  });

  it('abort() mid-stream closes the upstream socket and ends the iteration quietly', async () => {
    let timer: NodeJS.Timeout | undefined;
    const s = await open((_r, res) => {
      sseHead(res);
      res.write(
        frame('message_start', { type: 'message_start', message: { usage: { input_tokens: 9 } } }),
      );
      timer = setInterval(
        () =>
          res.write(
            frame('content_block_delta', {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'abc' },
            }),
          ),
        10,
      );
      res.on('close', () => clearInterval(timer));
    });
    const seen: string[] = [];
    for await (const e of s.events) {
      seen.push(e.event);
      if (seen.length === 3) s.abort('revoked');
    }
    await waitFor(() => server!.abortedResponses() === 1 && server!.openSockets() === 0);
    const r = s.result();
    expect(r).toMatchObject({ complete: false, abortReason: 'revoked', source: 'estimated' });
    expect(r.usage.inputTokens).toBe(9);
    expect(r.usage.outputTokens).toBeGreaterThan(0);
    clearInterval(timer);
  });

  it('aborting the signal while a read is pending closes the socket', async () => {
    const ac = new AbortController();
    const s = await open(
      (_r, res) => {
        sseHead(res);
        res.write(
          frame('message_start', {
            type: 'message_start',
            message: { usage: { input_tokens: 1 } },
          }),
        );
      },
      {},
      { signal: ac.signal },
    );
    const it = s.events[Symbol.asyncIterator]();
    await it.next();
    const pending = it.next();
    setTimeout(() => ac.abort(), 30);
    expect(await pending).toEqual({ done: true, value: undefined });
    await waitFor(() => server!.abortedResponses() === 1 && server!.openSockets() === 0);
    expect(s.result().abortReason).toBe('client_abort');
  });

  it('aborting during connect rejects with StreamAbortedError and no socket stays open', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort('cancelled'), 50);
    const p = open(() => undefined, {}, { signal: ac.signal });
    await expect(p).rejects.toBeInstanceOf(StreamAbortedError);
    await waitFor(() => server!.openSockets() === 0);
  });

  it('an already aborted signal never sends a request', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(open(write(anthropicText()), {}, { signal: ac.signal })).rejects.toBeInstanceOf(
      StreamAbortedError,
    );
    expect(server!.requests).toHaveLength(0);
  });

  it('shouldStop (output beyond the reservation) aborts upstream, nothing past the bound is relayed', async () => {
    let timer: NodeJS.Timeout | undefined;
    const s = await open(
      (_r, res) => {
        sseHead(res);
        res.write(
          frame('message_start', {
            type: 'message_start',
            message: { usage: { input_tokens: 4 } },
          }),
        );
        timer = setInterval(
          () =>
            res.write(
              frame('content_block_delta', {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'x'.repeat(100) },
              }),
            ),
          5,
        );
        res.on('close', () => clearInterval(timer));
      },
      {},
      { shouldStop: (m) => (m.outputBytes > 450 ? 'output_over_reservation' : undefined) },
    );
    const events = await collect(s.events);
    const r = s.result();
    expect(r.abortReason).toBe('output_over_reservation');
    expect(r.outputBytes).toBe(500);
    expect(events).toHaveLength(5); // start + 4 deltas; the 5th delta crossed the bound and is not relayed
    await waitFor(() => server!.abortedResponses() === 1);
    clearInterval(timer);
  });

  it('applies backpressure: an idle consumer stops the upstream read', async () => {
    let written = 0;
    let timer: NodeJS.Timeout | undefined;
    const chunk = frame('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'p'.repeat(8000) },
    });
    const s = await open((_r, res) => {
      sseHead(res);
      res.write(
        frame('message_start', { type: 'message_start', message: { usage: { input_tokens: 1 } } }),
      );
      timer = setInterval(() => {
        if (!res.writableNeedDrain) res.write(chunk);
        written = res.socket?.bytesWritten ?? written;
      }, 1);
      res.on('close', () => clearInterval(timer));
    });
    const it = s.events[Symbol.asyncIterator]();
    await it.next();
    await new Promise((r) => setTimeout(r, 1500)); // kernel and client buffers fill up and stall
    const afterIdle = written;
    await new Promise((r) => setTimeout(r, 500));
    // The kernel and client buffers filled up, so the bytes that left the server stall (and stay small).
    expect(written - afterIdle).toBeLessThan(64 * 1024);
    expect(afterIdle).toBeLessThan(16 * 1024 * 1024);
    s.abort();
    await waitFor(() => server!.abortedResponses() === 1);
    clearInterval(timer);
  });

  it('abort() without iterating closes the connection and a later iteration ends quietly', async () => {
    const s = await open((_r, res) => {
      sseHead(res);
      res.write(': open\n\n');
    });
    s.abort('cancelled');
    s.abort('again');
    await waitFor(() => server!.abortedResponses() === 1);
    expect(await collect(s.events)).toEqual([]);
    expect(s.result().abortReason).toBe('cancelled');
    expect(s.snapshot().outputBytes).toBe(0);
  });

  it('makes no logging of request or response bodies', async () => {
    const logged: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => {
      const orig = console[m];
      console[m] = (...a: unknown[]) => logged.push(a.join(' '));
      return () => (console[m] = orig);
    });
    const s = await open(write(anthropicText()));
    await collect(s.events);
    spies.forEach((restore) => restore());
    expect(logged).toEqual([]);
  });
});
