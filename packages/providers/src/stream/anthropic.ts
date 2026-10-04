import type { HandlerOutcome, ProtocolHandler } from './engine.js';
import { scrub } from './engine.js';
import {
  assertSafeHeaders,
  collectSecrets,
  openSseStream,
  type HttpTransportOptions,
} from './http.js';
import type { UsageMeter } from './meter.js';
import type { SseEvent } from './sse.js';
import {
  StreamError,
  type StreamCallOptions,
  type StreamUsage,
  type StreamingTransport,
  type UpstreamStream,
} from './types.js';

const BETA_VALUE = /^[a-z0-9._-]{1,64}$/;
const BLOCK_TYPES = new Set(['text', 'thinking', 'redacted_thinking', 'tool_use']);

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/** Anthropic usage objects (message_start, message_delta) into the meter. */
export function reportAnthropicUsage(meter: UsageMeter, usage: unknown): void {
  const u = obj(usage);
  if (!u) return;
  meter.report({
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens,
    cacheWriteTokens: u.cache_creation_input_tokens,
  });
}

/**
 * Bedrock `amazon-bedrock-invocationMetrics`. Only fields the Anthropic body did not report are
 * taken from it, so cache tokens are never counted twice.
 */
function reportBedrockMetrics(meter: UsageMeter, metrics: unknown): void {
  const m = obj(metrics);
  if (!m) return;
  const fill = (key: keyof StreamUsage, update: unknown): unknown =>
    meter.has(key) ? undefined : update;
  meter.report({
    inputTokens: fill('inputTokens', m.inputTokenCount),
    outputTokens: fill('outputTokens', m.outputTokenCount),
    cacheReadTokens: fill('cacheReadTokens', m.cacheReadInputTokenCount),
    cacheWriteTokens: fill('cacheWriteTokens', m.cacheWriteInputTokenCount),
  });
}

const METRICS_KEY = 'amazon-bedrock-invocationMetrics';

/** Event handler for the Anthropic Messages stream (also used for Bedrock chunks). */
export function createAnthropicHandler(secrets: readonly string[]): ProtocolHandler {
  return {
    handle(frame: SseEvent, meter: UsageMeter): HandlerOutcome {
      let parsed: unknown;
      try {
        parsed = JSON.parse(frame.data);
      } catch {
        throw new StreamError('invalid_json', 'upstream event is not valid JSON');
      }
      const data = obj(parsed);
      const type = data?.type;
      if (!data || typeof type !== 'string') {
        throw new StreamError('invalid_event', 'upstream event has no type');
      }
      // The SSE `event:` line must agree with the payload; a mismatch is a smuggling attempt.
      if (frame.event !== 'message' && frame.event !== type) {
        throw new StreamError('invalid_event', 'SSE event name and payload type disagree');
      }
      reportBedrockMetrics(meter, data[METRICS_KEY]);
      delete data[METRICS_KEY];
      switch (type) {
        case 'ping':
          return {};
        case 'error': {
          const e = obj(data.error);
          const kind = typeof e?.type === 'string' ? `${e.type}: ` : '';
          const msg = typeof e?.message === 'string' ? e.message : 'upstream stream error';
          throw new StreamError(
            'upstream_error',
            `provider stream error: ${scrub(kind + msg, secrets)}`,
          );
        }
        case 'message_start':
          reportAnthropicUsage(meter, obj(data.message)?.usage);
          return { emit: { event: type, data } };
        case 'content_block_start': {
          const block = obj(data.content_block);
          if (!block || typeof block.type !== 'string' || !BLOCK_TYPES.has(block.type)) {
            throw new StreamError('invalid_event', 'upstream content block type is not allowed');
          }
          if (typeof block.text === 'string') meter.addOutput(block.text);
          return { emit: { event: type, data } };
        }
        case 'content_block_delta': {
          const d = obj(data.delta);
          switch (d?.type) {
            case 'text_delta':
              if (typeof d.text === 'string') meter.addOutput(d.text);
              break;
            case 'thinking_delta':
              if (typeof d.thinking === 'string') meter.addOutput(d.thinking);
              break;
            case 'input_json_delta':
              if (typeof d.partial_json === 'string') meter.addOutput(d.partial_json);
              break;
            case 'signature_delta':
              break;
            default:
              return { unknown: true };
          }
          return { emit: { event: type, data } };
        }
        case 'content_block_stop':
          return { emit: { event: type, data } };
        case 'message_delta':
          reportAnthropicUsage(meter, data.usage);
          return { emit: { event: type, data } };
        case 'message_stop':
          return { emit: { event: type, data }, done: true };
        default:
          return { unknown: true };
      }
    },
  };
}

export interface AnthropicStreamOptions extends HttpTransportOptions {
  apiKey?: string | undefined;
  /** `anthropic-version` header. Default `2023-06-01`. */
  version?: string | undefined;
}

/**
 * Streaming upstream transport for the Anthropic Messages API. The body is the already validated
 * and re-serialized request; the transport forces `stream: true` and builds every header from
 * configuration (plus allowlisted beta values), never from the client.
 */
export class AnthropicStreamTransport implements StreamingTransport {
  readonly name = 'anthropic';

  constructor(private readonly opts: AnthropicStreamOptions) {}

  async open(
    request: { body: Record<string, unknown> },
    call: StreamCallOptions = {},
  ): Promise<UpstreamStream> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'anthropic-version': this.opts.version ?? '2023-06-01',
    };
    if (this.opts.apiKey) headers['x-api-key'] = this.opts.apiKey;
    const beta = (call.anthropicBeta ?? []).filter((b) => BETA_VALUE.test(b));
    if (beta.length !== (call.anthropicBeta ?? []).length) {
      throw new StreamError('invalid_event', 'anthropic-beta contains an invalid value');
    }
    if (beta.length) headers['anthropic-beta'] = beta.join(',');
    assertSafeHeaders(headers);
    const secrets = collectSecrets(this.opts.apiKey, undefined, this.opts.secrets);
    const base = this.opts.baseUrl.replace(/\/$/, '');
    return openSseStream(this.opts, secrets, {
      url: `${base}/v1/messages`,
      headers,
      body: JSON.stringify({ ...request.body, stream: true }),
      handler: createAnthropicHandler(secrets),
      call,
    });
  }
}
