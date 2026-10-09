import type { InvokeModelWithResponseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { EgressPolicy, resetEgressPolicy, setEgressPolicy } from '@openagentix/core';
import { describe, expect, it } from 'vitest';
import {
  BedrockStreamTransport,
  ProviderError,
  StreamAbortedError,
  StreamError,
  type BedrockStreamClient,
} from '../../src/index.js';
import { collect } from './fake-server.js';

const enc = (o: unknown) => ({
  chunk: { bytes: new TextEncoder().encode(typeof o === 'string' ? o : JSON.stringify(o)) },
});

const happy = (metrics?: Record<string, number>) => [
  enc({ type: 'message_start', message: { usage: { input_tokens: 8, output_tokens: 1 } } }),
  enc({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  enc({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'héllo' } }),
  enc({ type: 'content_block_stop', index: 0 }),
  enc({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } }),
  enc({
    type: 'message_stop',
    ...(metrics ? { 'amazon-bedrock-invocationMetrics': metrics } : {}),
  }),
];

function client(
  members: unknown[],
  hooks: {
    onSend?: (c: InvokeModelWithResponseStreamCommand, signal?: AbortSignal) => void;
    gap?: number;
    throws?: unknown;
  } = {},
): BedrockStreamClient & { closed: boolean } {
  const c = {
    closed: false,
    async send(
      cmd: InvokeModelWithResponseStreamCommand,
      o?: { abortSignal?: AbortSignal | undefined },
    ) {
      hooks.onSend?.(cmd, o?.abortSignal);
      if (hooks.throws) throw hooks.throws;
      return {
        body: (async function* () {
          try {
            for (const m of members) {
              if (hooks.gap) await new Promise((r) => setTimeout(r, hooks.gap));
              yield m as never;
            }
            if (hooks.gap) await new Promise(() => undefined); // endless
          } finally {
            c.closed = true;
          }
        })(),
      };
    },
  };
  return c;
}

const transport = (c: BedrockStreamClient, extra: object = {}) =>
  new BedrockStreamTransport({ region: 'eu-central-1', client: c, ...extra });
const req = {
  model: 'eu.anthropic.claude-x-v1:0',
  body: { max_tokens: 50, messages: [], stream: true, anthropic_version: 'evil' },
};

describe('BedrockStreamTransport', () => {
  it('streams the Anthropic body with a forced version and extracts usage', async () => {
    let sent: InvokeModelWithResponseStreamCommand | undefined;
    const c = client(happy(), { onSend: (cmd) => (sent = cmd) });
    const s = await transport(c).open(req);
    const events = await collect(s.events);
    expect(events.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect(s.result()).toMatchObject({
      complete: true,
      source: 'provider',
      usage: { inputTokens: 8, outputTokens: 6 },
    });
    const input = sent!.input;
    expect(input.modelId).toBe('eu.anthropic.claude-x-v1:0');
    const body = JSON.parse(String(input.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 50 });
    expect(body.stream).toBeUndefined();
    expect(body.model).toBeUndefined();
    expect(c.closed).toBe(true);
  });

  it('uses invocation metrics only for fields the body did not report and never relays them', async () => {
    const members = [
      enc({ type: 'message_start', message: { usage: { input_tokens: 0 } } }),
      enc({
        type: 'message_stop',
        'amazon-bedrock-invocationMetrics': {
          inputTokenCount: 40,
          outputTokenCount: 9,
          cacheReadInputTokenCount: 5,
          cacheWriteInputTokenCount: 2,
        },
      }),
    ];
    const s = await transport(client(members)).open(req);
    const events = await collect(s.events);
    expect(JSON.stringify(events)).not.toContain('invocationMetrics');
    expect(s.result()).toMatchObject({
      usage: { inputTokens: 0, outputTokens: 9, cacheReadTokens: 5, cacheWriteTokens: 2 },
    });
  });

  it('flags a stream without any usage', async () => {
    const members = [
      enc({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'abc' } }),
      enc({ type: 'message_stop' }),
    ];
    const s = await transport(client(members)).open(req, { inputEstimate: 9 });
    await collect(s.events);
    expect(s.result()).toMatchObject({
      usageReported: false,
      source: 'estimated',
      usage: { inputTokens: 9, outputTokens: 1 },
    });
  });

  it('turns stream exceptions into scrubbed controlled errors', async () => {
    const members = [
      enc({ type: 'message_start', message: {} }),
      { throttlingException: { message: 'slow down AKIAFAKESECRETKEY' } },
    ];
    const s = await transport(client(members), { secrets: ['AKIAFAKESECRETKEY'] }).open(req);
    const err = await collect(s.events).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StreamError);
    expect((err as Error).message).toContain('throttlingException');
    expect((err as Error).message).not.toContain('AKIAFAKESECRETKEY');
  });

  it('rejects unknown members, oversized and malformed chunks, truncated streams', async () => {
    for (const [members, reason, limits] of [
      [[{ weird: {} }], 'invalid_event', undefined],
      [[enc('x'.repeat(200))], 'event_too_large', { maxEventBytes: 100 }],
      [[{ chunk: { bytes: Uint8Array.of(0xff, 0xfe) } }], 'invalid_utf8', undefined],
      [[enc('not json')], 'invalid_json', undefined],
      [[enc({ type: 'message_start', message: {} })], 'truncated', undefined],
      [
        [enc({ type: 'message_start', message: {} }), enc({ type: 'message_start', message: {} })],
        'response_too_large',
        { maxTotalBytes: 40 },
      ],
    ] as const) {
      const s = await transport(client([...members]), { limits }).open(req);
      await expect(collect(s.events)).rejects.toMatchObject({ reason });
    }
  });

  it('refuses invalid model ids before any call (injection into the path)', async () => {
    let called = false;
    const c = client(happy(), { onSend: () => (called = true) });
    for (const model of [undefined, '', '../x', 'a b', 'a\nb']) {
      await expect(transport(c).open({ ...req, model })).rejects.toMatchObject({
        code: 'model_request_invalid',
      });
    }
    expect(called).toBe(false);
  });

  it('maps SDK errors to ProviderError with status and a scrubbed message', async () => {
    const e = Object.assign(new Error('denied for SECRET-TOKEN-123'), {
      name: 'AccessDeniedException',
      $metadata: { httpStatusCode: 403 },
    });
    const err = await transport(client([], { throws: e }), { secrets: ['SECRET-TOKEN-123'] })
      .open(req)
      .catch((x: unknown) => x);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ status: 403, retryable: false });
    expect((err as Error).message).not.toContain('SECRET-TOKEN-123');
    const t = Object.assign(new Error('x'), { $metadata: { httpStatusCode: 503 } });
    expect(
      await transport(client([], { throws: t }))
        .open(req)
        .catch((x: unknown) => x),
    ).toMatchObject({ retryable: true });
    expect(
      await transport(client([], { throws: new Error('net') }))
        .open(req)
        .catch((x: unknown) => x),
    ).toMatchObject({ status: null });
  });

  it('abort() closes the SDK stream and the abort signal is passed to the SDK', async () => {
    let signal: AbortSignal | undefined;
    const c = client(happy().slice(0, 3), { gap: 5, onSend: (_c, s) => (signal = s) });
    const s = await transport(c).open(req);
    let n = 0;
    for await (const _e of s.events) if (++n === 2) s.abort('revoked');
    expect(signal?.aborted).toBe(true);
    expect(c.closed).toBe(true);
    expect(s.result()).toMatchObject({ complete: false, abortReason: 'revoked' });
  });

  it('abort before the response rejects with StreamAbortedError; idle and deadline time out', async () => {
    const ac = new AbortController();
    const slow: BedrockStreamClient = { send: () => new Promise(() => undefined) };
    const p = transport(slow).open(req, { signal: ac.signal });
    ac.abort('cancelled');
    await expect(p).rejects.toBeInstanceOf(StreamAbortedError);
    await expect(transport(slow, { limits: { ttfbMs: 50 } }).open(req)).rejects.toMatchObject({
      code: 'provider_timeout',
    });
    const idle = await transport(client(happy().slice(0, 2), { gap: 5 }), {
      limits: { idleMs: 80 },
    }).open(req);
    await expect(collect(idle.events)).rejects.toMatchObject({ reason: 'idle_timeout' });
  });

  it('refuses a missing body and enforces the air-gap egress policy', async () => {
    const empty: BedrockStreamClient = { send: async () => ({ body: undefined }) };
    await expect(transport(empty).open(req)).rejects.toMatchObject({ reason: 'bad_content_type' });
    setEgressPolicy(new EgressPolicy({ airgapped: true, allow: [] }));
    try {
      let called = false;
      const c = client(happy(), { onSend: () => (called = true) });
      await expect(transport(c).open(req)).rejects.toMatchObject({ code: 'egress_denied' });
      expect(called).toBe(false);
    } finally {
      resetEgressPolicy();
    }
  });
});

describe('BedrockStreamTransport destination check', () => {
  it('refuses a private custom endpoint before sending anything', async () => {
    let sent = 0;
    const t = new BedrockStreamTransport({
      region: 'r',
      endpoint: 'https://bedrock.internal',
      blockPrivateDestinations: { lookup: async () => [{ address: '169.254.169.254' }] },
      client: {
        async send() {
          sent++;
          return { body: undefined };
        },
      },
    });
    await expect(
      t.open({ body: { messages: [], max_tokens: 1 }, model: 'anthropic.claude-x' }),
    ).rejects.toMatchObject({ code: 'egress_denied' });
    expect(sent).toBe(0);
  });
});
