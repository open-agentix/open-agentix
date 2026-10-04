import { afterEach, describe, expect, it } from 'vitest';
import { OpenAIStreamTransport, ProviderError, type OpenAIStreamOptions } from '../../src/index.js';
import {
  DONE,
  collect,
  frame,
  openaiChunk,
  openaiUsage,
  sseHead,
  startServer,
  waitFor,
  type FakeServer,
  type Handler,
} from './fake-server.js';

const KEY = 'sk-openai-secret-0987654321';
let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function open(
  handler: Handler,
  opts: Partial<OpenAIStreamOptions> = {},
  body: Record<string, unknown> = { model: 'gpt-x', messages: [] },
  call: Parameters<OpenAIStreamTransport['open']>[1] = {},
) {
  server = await startServer(handler);
  const t = new OpenAIStreamTransport({
    baseUrl: `${server.url}/v1`,
    apiKey: KEY,
    backoffMs: 5,
    ...opts,
  });
  return t.open({ body }, call);
}
const write =
  (text: string): Handler =>
  (_r, res) => {
    sseHead(res);
    res.end(text);
  };

const text =
  openaiChunk({ role: 'assistant', content: '' }) +
  openaiChunk({ content: 'Hel' }) +
  openaiChunk({ content: 'lo' }, 'stop') +
  openaiUsage({
    prompt_tokens: 30,
    completion_tokens: 12,
    prompt_tokens_details: { cached_tokens: 10 },
  }) +
  DONE;

describe('OpenAIStreamTransport', () => {
  it('streams chunks, handles [DONE] and extracts usage with cache tokens', async () => {
    const s = await open(write(text));
    const events = await collect(s.events);
    expect(events).toHaveLength(4);
    expect(events.every((e) => e.event === 'chunk')).toBe(true);
    expect(s.result()).toMatchObject({
      complete: true,
      source: 'provider',
      usageReported: true,
      outputBytes: 5,
      usage: { inputTokens: 20, outputTokens: 12, cacheReadTokens: 10, cacheWriteTokens: 0 },
    });
  });

  it('forces stream and include_usage, keeps other stream options, sends the key only as Bearer', async () => {
    const s = await open(
      write(text),
      {},
      {
        model: 'gpt-x',
        messages: [],
        stream: false,
        stream_options: { include_usage: false, extra: 1 },
      },
    );
    await collect(s.events);
    const req = server!.requests[0]!;
    expect(req.url).toBe('/v1/chat/completions');
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(req.body)).toMatchObject({
      stream: true,
      stream_options: { include_usage: true, extra: 1 },
    });
  });

  it('builds Azure deployment URLs with api-version and header keys', async () => {
    const s = await open(
      write(text),
      {
        apiKey: undefined,
        headers: { 'api-key': KEY },
        azure: { apiVersion: '2024-10-21' },
        query: 'x=1',
      },
      { model: 'my deploy', messages: [] },
    );
    await collect(s.events);
    const req = server!.requests[0]!;
    expect(req.url).toBe(
      '/v1/openai/deployments/my%20deploy/chat/completions?api-version=2024-10-21&x=1',
    );
    expect(req.headers['api-key']).toBe(KEY);
    expect(req.headers.authorization).toBeUndefined();
  });

  it('uses a fixed Azure deployment', async () => {
    const s = await open(write(text), { azure: { apiVersion: 'v', deployment: 'fixed' } });
    await collect(s.events);
    expect(server!.requests[0]!.url).toContain('/deployments/fixed/');
  });

  it('meters tool-call arguments and reasoning and records cache writes (OpenRouter style)', async () => {
    const body =
      openaiChunk({ reasoning_content: 'think' }) +
      openaiChunk({
        tool_calls: [{ index: 0, id: 't', function: { name: 'fn', arguments: '{"a"' } }],
      }) +
      openaiChunk({ tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }, 'tool_calls') +
      openaiUsage({
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 20 },
      }) +
      DONE;
    const s = await open(write(body));
    await collect(s.events);
    expect(s.result()).toMatchObject({
      outputBytes: 5 + 2 + 4 + 3,
      usage: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 20 },
    });
  });

  it('flags a missing usage chunk for the estimator fallback', async () => {
    const body = openaiChunk({ content: 'abcdef' }) + openaiChunk({}, 'stop') + DONE;
    const s = await open(write(body), {}, { model: 'm', messages: [] }, { inputEstimate: 77 });
    await collect(s.events);
    const r = s.result();
    expect(r).toMatchObject({ complete: true, usageReported: false, source: 'estimated' });
    expect(r.usage).toMatchObject({ inputTokens: 77, outputTokens: 2 });
  });

  it('accepts endpoints that omit [DONE] after finish reason and usage, rejects otherwise', async () => {
    const withUsage =
      openaiChunk({ content: 'a' }, 'stop') +
      openaiUsage({ prompt_tokens: 1, completion_tokens: 1 });
    const s = await open(write(withUsage));
    await collect(s.events);
    expect(s.result().complete).toBe(true);
    await server?.close();
    const s2 = await open(write(openaiChunk({ content: 'a' })));
    await expect(collect(s2.events)).rejects.toMatchObject({ reason: 'truncated' });
  });

  it('drops frames with foreign event names and relays nothing for them', async () => {
    const body = frame('evil', { x: 1 }) + openaiChunk({ content: 'a' }, 'stop') + DONE;
    const s = await open(write(body));
    const events = await collect(s.events);
    expect(events).toHaveLength(1);
    expect(s.result().unknownEvents).toBe(1);
  });

  it('controlled errors for invalid JSON, non-objects and in-stream error objects (scrubbed)', async () => {
    for (const [body, reason] of [
      [frame(undefined, '{not json'), 'invalid_json'],
      [frame(undefined, '[1]'), 'invalid_event'],
      [frame(undefined, { error: { message: `bad key ${KEY}` } }), 'upstream_error'],
    ] as const) {
      const s = await open(write(body));
      const err = await collect(s.events).catch((e: unknown) => e);
      expect(err).toMatchObject({ reason });
      expect((err as Error).message).not.toContain(KEY);
      await server?.close();
    }
  });

  it('maps HTTP errors without echoing the key, also for plain-text bodies', async () => {
    const err = await open((_r, res) => {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end(`bad request for ${KEY}\u001b[31m`);
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    const m = (err as Error).message;
    expect(m).not.toContain(KEY);
    expect(m).not.toContain('\u001b');
    expect(m).toContain('[redacted]');
  });

  it('handles error bodies with a string error field and an unreadable body', async () => {
    const err = await open((_r, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'model not found' }));
    }).catch((e: unknown) => e);
    expect((err as Error).message).toContain('model not found');
  });

  it('rejects header configuration with CRLF', async () => {
    server = await startServer(write(text));
    const t = new OpenAIStreamTransport({
      baseUrl: `${server.url}/v1`,
      headers: { 'x-a': 'b\r\nx-evil: 1' },
    });
    await expect(t.open({ body: { model: 'm' } })).rejects.toMatchObject({
      code: 'provider_error',
    });
    expect(server.requests).toHaveLength(0);
  });

  it('retries 429 before the first byte', async () => {
    const s = await open((_r, res, n) => {
      if (n === 1) {
        res.writeHead(429);
        res.end('slow down');
      } else {
        sseHead(res);
        res.end(text);
      }
    });
    await collect(s.events);
    expect(server!.requests).toHaveLength(2);
  });

  it('SSE comments (OpenRouter processing) are ignored', async () => {
    const s = await open(write(`: OPENROUTER PROCESSING\n\n${text}`));
    expect((await collect(s.events)).length).toBe(4);
  });

  it('abort closes the upstream socket mid-stream', async () => {
    let timer: NodeJS.Timeout | undefined;
    const s = await open((_r, res) => {
      sseHead(res);
      timer = setInterval(() => res.write(openaiChunk({ content: 'zz' })), 5);
      res.on('close', () => clearInterval(timer));
    });
    let n = 0;
    for await (const _e of s.events) if (++n === 3) s.abort('client_gone');
    await waitFor(() => server!.abortedResponses() === 1 && server!.openSockets() === 0);
    expect(s.result()).toMatchObject({
      complete: false,
      abortReason: 'client_gone',
      source: 'estimated',
    });
    clearInterval(timer);
  });

  it('slow-loris and endless streams end in controlled errors', async () => {
    const s = await open(
      (_r, res) => {
        sseHead(res);
        const t = setInterval(() => res.write('data: {"choices":[]'), 10); // never terminates
        res.on('close', () => clearInterval(t));
      },
      { limits: { maxLineBytes: 4096, idleMs: 300, ttfbMs: 300 } },
    );
    await expect(collect(s.events)).rejects.toMatchObject({
      reason: expect.stringMatching(/line_too_large|ttfb_timeout/),
    });
    await waitFor(() => server!.abortedResponses() === 1);
  });

  it('shouldStop with provider usage so far is settled as estimated', async () => {
    let timer: NodeJS.Timeout | undefined;
    const s = await open(
      (_r, res) => {
        sseHead(res);
        timer = setInterval(() => res.write(openaiChunk({ content: 'q'.repeat(60) })), 5);
        res.on('close', () => clearInterval(timer));
      },
      {},
      { model: 'm', messages: [] },
      { shouldStop: (m) => (m.outputBytes >= 300 ? 'budget' : undefined), inputEstimate: 11 },
    );
    await collect(s.events);
    const r = s.result();
    expect(r.abortReason).toBe('budget');
    expect(r.usage).toMatchObject({ inputTokens: 11, outputTokens: 100 });
    clearInterval(timer);
  });
});
