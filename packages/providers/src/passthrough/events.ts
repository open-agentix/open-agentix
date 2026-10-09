import { MODEL_ERRORS, type ModelErrorCode, type WorkerModelResponse } from '../model-wire.js';
import type { ChatResponse, StopReason } from '../types.js';
import { StreamError, type UpstreamEvent } from '../stream/types.js';
import type { PassthroughSurface } from './requests.js';

/**
 * Response side of the pass-through surfaces (ADR 0009 sections 2.5, 6.3 and 6.4). Every event
 * that reaches a client is **rebuilt** from allowlisted fields of the upstream event: unknown keys,
 * vendor extensions and anything else a provider adds are dropped, so an endpoint cannot smuggle
 * data through the stream. Strings are length-limited.
 */

/** One event for the client: `event` is the SSE event name (Anthropic) or `chunk` (OpenAI). */
export interface ClientEvent {
  event: string;
  data: Record<string, unknown>;
}

const STR_MAX = 64 * 1024;

/** Client-visible identity and usage bounds applied to every rebuilt event (ADR 0009 6.3). */
export interface SanitizeOpts {
  /** OpenAI: the client asked for the final usage chunk. */
  includeUsage: boolean;
  /** The step's model: replaces whatever model name the upstream reports. */
  model?: string | undefined;
  /** Own message/completion id (derived from the call id): upstream ids are never forwarded. */
  id?: string | undefined;
  /** Caps for the usage the client sees (the capped values the books use). */
  maxInput?: number | undefined;
  maxOutput?: number | undefined;
}

/** Message id of the Anthropic surface for a call id. */
export const anthropicMessageId = (callId: string): string =>
  `msg_${callId.replace(/[^A-Za-z0-9]/g, '').slice(0, 40)}`;
/** Completion id of the OpenAI surface for a call id. */
export const openaiCompletionId = (callId: string): string =>
  `chatcmpl-${callId.replace(/[^A-Za-z0-9]/g, '').slice(0, 40)}`;

/**
 * A content string: a string above the limit ends the stream with an error. Blanking it would
 * deliver a silently corrupted answer that is still billed.
 */
const big = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  if (v.length > STR_MAX)
    throw new StreamError('event_too_large', 'a provider event field exceeds the size limit');
  return v;
};

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const str = (v: unknown, max = STR_MAX): string | undefined =>
  typeof v === 'string' && v.length <= max ? v : undefined;
const int = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
const idx = (v: unknown): number =>
  int(v) !== undefined && (v as number) < 4096 ? (v as number) : 0;

function pick<T extends Record<string, unknown>>(o: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

// ---------------------------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------------------------

const cap = (v: number | undefined, max: number | undefined): number | undefined =>
  v === undefined || max === undefined ? v : Math.min(v, max);

function anthropicUsage(
  u: unknown,
  o2: Pick<SanitizeOpts, 'maxInput' | 'maxOutput'> = {},
): Record<string, unknown> | undefined {
  const o = obj(u);
  if (!o) return undefined;
  const out = pick({
    input_tokens: cap(int(o.input_tokens), o2.maxInput),
    output_tokens: cap(int(o.output_tokens), o2.maxOutput),
    cache_creation_input_tokens: cap(int(o.cache_creation_input_tokens), o2.maxInput),
    cache_read_input_tokens: cap(int(o.cache_read_input_tokens), o2.maxInput),
  });
  return Object.keys(out).length ? out : undefined;
}

/** Rebuilds an Anthropic stream event; `null` drops it. */
export function sanitizeAnthropicEvent(
  ev: UpstreamEvent,
  opts: Partial<SanitizeOpts> = {},
): ClientEvent | null {
  const d = ev.data;
  switch (ev.event) {
    case 'message_start': {
      const m = obj(d.message);
      return {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: pick({
            id: opts.id ?? str(m?.id, 200) ?? 'msg_proxy',
            type: 'message',
            role: 'assistant',
            model: opts.model ?? str(m?.model, 200),
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: anthropicUsage(m?.usage, opts) ?? { input_tokens: 0, output_tokens: 0 },
          }),
        },
      };
    }
    case 'content_block_start': {
      const b = obj(d.content_block);
      let block: Record<string, unknown> | undefined;
      switch (b?.type) {
        case 'text':
          block = { type: 'text', text: big(b.text) ?? '' };
          break;
        case 'thinking':
          block = { type: 'thinking', thinking: big(b.thinking) ?? '' };
          break;
        case 'redacted_thinking':
          block = { type: 'redacted_thinking', data: big(b.data) ?? '' };
          break;
        case 'tool_use':
          block = {
            type: 'tool_use',
            id: str(b.id, 200) ?? '',
            name: str(b.name, 200) ?? '',
            input: {},
          };
          break;
        default:
          return null;
      }
      return {
        event: 'content_block_start',
        data: { type: 'content_block_start', index: idx(d.index), content_block: block },
      };
    }
    case 'content_block_delta': {
      const x = obj(d.delta);
      let delta: Record<string, unknown> | undefined;
      switch (x?.type) {
        case 'text_delta':
          delta = { type: 'text_delta', text: big(x.text) ?? '' };
          break;
        case 'thinking_delta':
          delta = { type: 'thinking_delta', thinking: big(x.thinking) ?? '' };
          break;
        case 'input_json_delta':
          delta = { type: 'input_json_delta', partial_json: big(x.partial_json) ?? '' };
          break;
        case 'signature_delta':
          delta = { type: 'signature_delta', signature: big(x.signature) ?? '' };
          break;
        default:
          return null;
      }
      return {
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: idx(d.index), delta },
      };
    }
    case 'content_block_stop':
      return {
        event: 'content_block_stop',
        data: { type: 'content_block_stop', index: idx(d.index) },
      };
    case 'message_delta': {
      const x = obj(d.delta);
      return {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: {
            stop_reason: str(x?.stop_reason, 64) ?? null,
            stop_sequence: str(x?.stop_sequence, 256) ?? null,
          },
          usage: anthropicUsage(d.usage, opts) ?? { output_tokens: 0 },
        },
      };
    }
    case 'message_stop':
      return { event: 'message_stop', data: { type: 'message_stop' } };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------------------------

const FINISH = new Set(['stop', 'length', 'tool_calls', 'content_filter', 'function_call']);

function openaiUsage(
  u: unknown,
  o2: Pick<SanitizeOpts, 'maxInput' | 'maxOutput'> = {},
): Record<string, unknown> | undefined {
  const o = obj(u);
  if (!o) return undefined;
  const prompt = cap(int(o.prompt_tokens), o2.maxInput);
  const completion = cap(int(o.completion_tokens), o2.maxOutput);
  if (prompt === undefined && completion === undefined) return undefined;
  const details = obj(o.prompt_tokens_details);
  const cached = cap(int(details?.cached_tokens), prompt);
  return pick({
    prompt_tokens: prompt ?? 0,
    completion_tokens: completion ?? 0,
    total_tokens: (prompt ?? 0) + (completion ?? 0),
    prompt_tokens_details: cached !== undefined ? { cached_tokens: cached } : undefined,
  });
}

/**
 * Rebuilds a Chat Completions chunk. A chunk without choices carries the usage only; it is dropped
 * unless the client asked for it (`stream_options.include_usage`).
 */
export function sanitizeOpenAIChunk(ev: UpstreamEvent, opts: SanitizeOpts): ClientEvent | null {
  if (ev.event !== 'chunk') return null;
  const d = ev.data;
  const choices: Record<string, unknown>[] = [];
  for (const c of Array.isArray(d.choices) ? d.choices : []) {
    const choice = obj(c);
    if (!choice || (choice.index !== undefined && choice.index !== 0)) continue;
    const delta = obj(choice.delta);
    const outDelta: Record<string, unknown> = {};
    if (delta) {
      if (delta.role === 'assistant') outDelta.role = 'assistant';
      for (const k of ['content', 'reasoning_content', 'refusal'] as const) {
        const v = delta[k];
        if (typeof v === 'string') outDelta[k] = big(v);
        else if (k === 'content' && v === null) outDelta[k] = null;
      }
      if (Array.isArray(delta.tool_calls)) {
        outDelta.tool_calls = delta.tool_calls.slice(0, 128).flatMap((t) => {
          const call = obj(t);
          if (!call) return [];
          const fn = obj(call.function);
          return [
            pick({
              index: idx(call.index),
              id: str(call.id, 200),
              type: call.id !== undefined ? 'function' : undefined,
              function: fn
                ? pick({ name: str(fn.name, 200), arguments: big(fn.arguments) })
                : undefined,
            }),
          ];
        });
      }
    }
    const finish = typeof choice.finish_reason === 'string' ? choice.finish_reason : null;
    choices.push({
      index: 0,
      delta: outDelta,
      finish_reason:
        finish !== null && FINISH.has(finish) ? finish : finish === null ? null : 'stop',
    });
  }
  const usage = openaiUsage(d.usage, opts);
  if (choices.length === 0 && (!usage || !opts.includeUsage)) return null;
  return {
    event: 'chunk',
    data: pick({
      id: opts.id ?? str(d.id, 200) ?? 'chatcmpl-proxy',
      object: 'chat.completion.chunk',
      created: int(d.created) ?? Math.floor(Date.now() / 1000),
      model: opts.model ?? str(d.model, 200),
      choices,
      usage: opts.includeUsage ? usage : undefined,
    }),
  };
}

export function sanitizeEvent(
  surface: PassthroughSurface,
  ev: UpstreamEvent,
  opts: SanitizeOpts,
): ClientEvent | null {
  return surface === 'anthropic' ? sanitizeAnthropicEvent(ev, opts) : sanitizeOpenAIChunk(ev, opts);
}

// ---------------------------------------------------------------------------------------------
// Errors in the protocol's envelope
// ---------------------------------------------------------------------------------------------

const OPENAI_TYPE: Record<string, string> = {
  invalid_request_error: 'invalid_request_error',
  authentication_error: 'invalid_request_error',
  permission_error: 'invalid_request_error',
  request_too_large: 'invalid_request_error',
  rate_limit_error: 'rate_limit_error',
  api_error: 'server_error',
  overloaded_error: 'server_error',
};

/** Protocol error body; the platform code is in `code` and the message prefix. */
export function protocolError(
  surface: PassthroughSurface,
  code: ModelErrorCode,
  message: string,
): Record<string, unknown> {
  const t = MODEL_ERRORS[code].anthropicType ?? 'invalid_request_error';
  const text = `${code}: ${message}`;
  return surface === 'anthropic'
    ? { type: 'error', error: { type: t, message: text, code } }
    : { error: { message: text, type: OPENAI_TYPE[t] ?? 'server_error', code } };
}

// ---------------------------------------------------------------------------------------------
// Non-streaming answers
// ---------------------------------------------------------------------------------------------

const A_STOP: Record<StopReason, string> = {
  end_turn: 'end_turn',
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
  refusal: 'refusal',
  other: 'end_turn',
};
const O_FINISH: Record<StopReason, string> = {
  end_turn: 'stop',
  tool_use: 'tool_calls',
  max_tokens: 'length',
  refusal: 'content_filter',
  other: 'stop',
};

/** The Anthropic `message` object of a settled call. Usage is the settled (capped) usage. */
export function renderAnthropicMessage(out: WorkerModelResponse): Record<string, unknown> {
  const r = out.response;
  return {
    id: anthropicMessageId(out.callId),
    type: 'message',
    role: 'assistant',
    model: r.model,
    content: [
      ...(r.text ? [{ type: 'text', text: r.text }] : []),
      ...r.toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args })),
    ],
    stop_reason: A_STOP[r.stopReason],
    stop_sequence: null,
    usage: {
      input_tokens: out.usage.inputTokens,
      output_tokens: out.usage.outputTokens,
      cache_creation_input_tokens: out.usage.cacheWriteTokens,
      cache_read_input_tokens: out.usage.cacheReadTokens,
    },
  };
}

/** The Chat Completions object of a settled call. */
export function renderOpenAICompletion(out: WorkerModelResponse): Record<string, unknown> {
  const r = out.response;
  const u = out.usage;
  const prompt = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  return {
    id: openaiCompletionId(out.callId),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: r.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: r.text || (r.toolCalls.length ? null : ''),
          ...(r.toolCalls.length
            ? {
                tool_calls: r.toolCalls.map((c) => ({
                  id: c.id,
                  type: 'function',
                  function: { name: c.name, arguments: JSON.stringify(c.args) },
                })),
              }
            : {}),
        },
        finish_reason: O_FINISH[r.stopReason],
      },
    ],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: u.outputTokens,
      total_tokens: prompt + u.outputTokens,
      prompt_tokens_details: { cached_tokens: u.cacheReadTokens },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Providers without a stream (simulated): synthesised protocol events
// ---------------------------------------------------------------------------------------------

/** Splits a string into pieces under the event limit (never inside a surrogate pair). */
export function chunkString(v: string, size = STR_MAX / 2): string[] {
  if (v.length <= size) return [v];
  const out: string[] = [];
  for (let i = 0; i < v.length;) {
    let end = Math.min(i + size, v.length);
    const last = v.charCodeAt(end - 1);
    if (end < v.length && last >= 0xd800 && last <= 0xdbff) end--;
    out.push(v.slice(i, end));
    i = end;
  }
  return out;
}

/** Upstream-shaped events for a completed response, to be sanitized like real ones. */
export function synthesizeEvents(
  surface: PassthroughSurface,
  res: ChatResponse,
  callId: string,
): UpstreamEvent[] {
  const ev = (event: string, data: Record<string, unknown>): UpstreamEvent => ({ event, data });
  if (surface === 'anthropic') {
    const out: UpstreamEvent[] = [
      ev('message_start', {
        type: 'message_start',
        message: {
          id: `msg_${callId}`,
          model: res.model,
          usage: { input_tokens: res.usage.inputTokens, output_tokens: 0 },
        },
      }),
    ];
    let i = 0;
    if (res.text) {
      out.push(
        ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } }),
        ...chunkString(res.text).map((text) =>
          ev('content_block_delta', { index: i, delta: { type: 'text_delta', text } }),
        ),
        ev('content_block_stop', { index: i }),
      );
      i++;
    }
    for (const c of res.toolCalls) {
      out.push(
        ev('content_block_start', {
          index: i,
          content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} },
        }),
        ...chunkString(JSON.stringify(c.args)).map((partial_json) =>
          ev('content_block_delta', {
            index: i,
            delta: { type: 'input_json_delta', partial_json },
          }),
        ),
        ev('content_block_stop', { index: i }),
      );
      i++;
    }
    out.push(
      ev('message_delta', {
        delta: { stop_reason: A_STOP[res.stopReason] },
        usage: { output_tokens: res.usage.outputTokens },
      }),
      ev('message_stop', { type: 'message_stop' }),
    );
    return out;
  }
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    ev('chunk', {
      id: `chatcmpl-${callId}`,
      model: res.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
  const out: UpstreamEvent[] = [chunk({ role: 'assistant', content: '' }, null)];
  if (res.text) for (const content of chunkString(res.text)) out.push(chunk({ content }, null));
  res.toolCalls.forEach((c, index) => {
    chunkString(JSON.stringify(c.args)).forEach((piece, n) =>
      out.push(
        chunk(
          {
            tool_calls: [
              n === 0
                ? { index, id: c.id, function: { name: c.name, arguments: piece } }
                : { index, function: { arguments: piece } },
            ],
          },
          null,
        ),
      ),
    );
  });
  out.push(
    chunk({}, O_FINISH[res.stopReason]),
    ev('chunk', {
      id: `chatcmpl-${callId}`,
      model: res.model,
      choices: [],
      usage: {
        prompt_tokens: res.usage.inputTokens,
        completion_tokens: res.usage.outputTokens,
      },
    }),
  );
  return out;
}
