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
  type StreamingTransport,
  type UpstreamStream,
} from './types.js';

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * OpenAI usage into the meter. `prompt_tokens` includes cached and written tokens, so both are
 * subtracted to get the Anthropic-style `inputTokens`.
 */
export function reportOpenAIUsage(meter: UsageMeter, usage: unknown): boolean {
  const u = obj(usage);
  if (!u) return false;
  const details = obj(u.prompt_tokens_details);
  const cached = typeof details?.cached_tokens === 'number' ? details.cached_tokens : 0;
  const written = typeof details?.cache_write_tokens === 'number' ? details.cache_write_tokens : 0;
  const prompt = u.prompt_tokens;
  meter.report({
    inputTokens:
      typeof prompt === 'number'
        ? Math.max(0, prompt - Math.max(0, cached) - Math.max(0, written))
        : undefined,
    outputTokens: u.completion_tokens,
    cacheReadTokens: typeof details?.cached_tokens === 'number' ? cached : undefined,
    cacheWriteTokens: typeof details?.cache_write_tokens === 'number' ? written : undefined,
  });
  return typeof prompt === 'number' || typeof u.completion_tokens === 'number';
}

/** Event handler for Chat Completions chunks. */
export function createOpenAIHandler(secrets: readonly string[]): ProtocolHandler {
  let finishSeen = false;
  let usageSeen = false;
  return {
    handle(frame: SseEvent, meter: UsageMeter): HandlerOutcome {
      if (frame.data === '[DONE]') return { done: true };
      if (frame.event !== 'message') return { unknown: true };
      let parsed: unknown;
      try {
        parsed = JSON.parse(frame.data);
      } catch {
        throw new StreamError('invalid_json', 'upstream chunk is not valid JSON');
      }
      const data = obj(parsed);
      if (!data) throw new StreamError('invalid_event', 'upstream chunk is not an object');
      if (data.error !== undefined && data.error !== null) {
        const e = obj(data.error);
        const msg = typeof e?.message === 'string' ? e.message : 'upstream stream error';
        throw new StreamError('upstream_error', `provider stream error: ${scrub(msg, secrets)}`);
      }
      if (Array.isArray(data.choices)) {
        for (const c of data.choices) {
          const choice = obj(c);
          const delta = obj(choice?.delta);
          if (choice && typeof choice.finish_reason === 'string') finishSeen = true;
          if (!delta) continue;
          for (const k of ['content', 'reasoning_content', 'reasoning', 'refusal'] as const) {
            if (typeof delta[k] === 'string') meter.addOutput(delta[k]);
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const t of delta.tool_calls) {
              const fn = obj(obj(t)?.function);
              if (typeof fn?.name === 'string') meter.addOutput(fn.name);
              if (typeof fn?.arguments === 'string') meter.addOutput(fn.arguments);
            }
          }
        }
      }
      if (data.usage !== undefined && data.usage !== null && reportOpenAIUsage(meter, data.usage)) {
        usageSeen = true;
      }
      return { emit: { event: 'chunk', data } };
    },
    // Endpoints that omit `[DONE]` are complete once a finish reason and the usage chunk arrived.
    completeAtEof: () => finishSeen && usageSeen,
  };
}

export interface OpenAIStreamOptions extends HttpTransportOptions {
  apiKey?: string | undefined;
  /** Extra headers, e.g. `{ "api-key": "..." }` for Azure OpenAI. */
  headers?: Record<string, string> | undefined;
  /** Extra query string, e.g. `api-version=2024-10-21`. */
  query?: string | undefined;
  /** Azure OpenAI deployment URLs; without a fixed `deployment` the request `model` is it. */
  azure?: { apiVersion: string; deployment?: string | undefined } | undefined;
}

/**
 * Streaming upstream transport for the OpenAI Chat Completions family (OpenAI, Azure OpenAI,
 * OpenRouter, vLLM, LM Studio, Ollama `/v1`, OpenAI-compatible). Forces `stream: true` and
 * `stream_options.include_usage: true` so usage arrives in the final chunk.
 */
export class OpenAIStreamTransport implements StreamingTransport {
  readonly name = 'openai';

  constructor(private readonly opts: OpenAIStreamOptions) {}

  async open(
    request: { body: Record<string, unknown>; model?: string | undefined },
    call: StreamCallOptions = {},
  ): Promise<UpstreamStream> {
    const { azure } = this.opts;
    const base = this.opts.baseUrl.replace(/\/$/, '');
    const model =
      request.model ?? (typeof request.body.model === 'string' ? request.body.model : '');
    const path = azure
      ? `/openai/deployments/${encodeURIComponent(azure.deployment ?? model)}/chat/completions`
      : '/chat/completions';
    const query = [
      azure ? `api-version=${encodeURIComponent(azure.apiVersion)}` : '',
      this.opts.query ?? '',
    ]
      .filter(Boolean)
      .join('&');
    const headers: Record<string, string> = {
      ...this.opts.headers,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    assertSafeHeaders(headers);
    const secrets = collectSecrets(this.opts.apiKey, this.opts.headers, this.opts.secrets);
    const prior = obj(request.body.stream_options) ?? {};
    return openSseStream(this.opts, secrets, {
      url: `${base}${path}${query ? `?${query}` : ''}`,
      headers,
      body: JSON.stringify({
        ...request.body,
        stream: true,
        stream_options: { ...prior, include_usage: true },
      }),
      handler: createOpenAIHandler(secrets),
      call,
    });
  }
}
