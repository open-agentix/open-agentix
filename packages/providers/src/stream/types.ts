import { OaxError } from '@openagentix/core';
import type { Usage } from '../types.js';

/** Strict size and time limits for one upstream stream (defaults follow ADR 0009 section 6). */
export interface StreamLimits {
  /** Longest single SSE line in bytes. */
  maxLineBytes: number;
  /** Largest single event (all `data:` lines together) in bytes. */
  maxEventBytes: number;
  /** Upper bound of all bytes read from one upstream response. */
  maxTotalBytes: number;
  /** Time to the first event, headers included (`OAX_MODEL_PROXY_TTFB_SECONDS`). */
  ttfbMs: number;
  /** Maximum time between two complete events. Trickled bytes do not reset it. */
  idleMs: number;
  /** Wall clock deadline of the whole call (`OAX_MODEL_PROXY_MAX_CALL_SECONDS`). */
  deadlineMs: number;
}

export const DEFAULT_STREAM_LIMITS: StreamLimits = {
  maxLineBytes: 256 * 1024,
  maxEventBytes: 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
  ttfbMs: 120_000,
  idleMs: 60_000,
  deadlineMs: 600_000,
};

export type StreamErrorReason =
  | 'line_too_large'
  | 'event_too_large'
  | 'response_too_large'
  | 'invalid_utf8'
  | 'invalid_json'
  | 'invalid_event'
  | 'ttfb_timeout'
  | 'idle_timeout'
  | 'deadline'
  | 'truncated'
  | 'upstream_error'
  | 'bad_content_type';

/** Why a stream was ended on purpose (not an error): the consumer or a hard-stop hook decided. */
export type StreamAbortReason = string;

/**
 * Controlled failure of an upstream stream. `code` is `provider_timeout` for time limits and
 * `provider_error` for everything else (ADR 0009 section 2.5). Messages never contain request or
 * response bodies and are scrubbed of configured secrets.
 */
export class StreamError extends OaxError {
  constructor(
    readonly reason: StreamErrorReason,
    message: string,
    readonly status: number | null = null,
  ) {
    super(
      reason === 'ttfb_timeout' || reason === 'idle_timeout' || reason === 'deadline'
        ? 'provider_timeout'
        : 'provider_error',
      message,
      { reason, status },
    );
  }
}

/**
 * One upstream event. `event` is the protocol event type, `data` the parsed JSON object **as the
 * provider sent it**: unknown keys are kept on purpose. The allowlist re-serialization before
 * anything reaches a client belongs to the proxy surfaces (W1-3b-6, ADR 0009 section 6).
 */
export interface UpstreamEvent {
  event: string;
  data: Record<string, unknown>;
}

/**
 * Normalised usage; same field names as `Usage` of `../types.ts`, but the cache fields are
 * always present. `inputTokens` excludes cache reads and writes (Anthropic convention).
 */
export type StreamUsage = Required<Usage>;

export type UsageSource = 'provider' | 'estimated' | 'floor';

export interface StreamSettlement {
  usage: StreamUsage;
  /** `provider` = reported by the endpoint, `estimated` = nothing usable reported, `floor` = floor won. */
  source: UsageSource;
  /** False when the endpoint reported no usage at all, or none for a stream that was cut. */
  usageReported: boolean;
  /** The floor replaced the reported output tokens (audit `model.usage_floor`). */
  floorApplied: boolean;
  /** Streamed output size in bytes (text, thinking and tool input deltas). */
  outputBytes: number;
}

export interface StreamResult extends StreamSettlement {
  /** The terminal event of the protocol arrived (`message_stop`, `[DONE]`). */
  complete: boolean;
  /** Set when the stream was ended on purpose; never set for errors. */
  abortReason: StreamAbortReason | undefined;
  /** Events dropped because their type is not in the protocol allowlist. */
  unknownEvents: number;
  bytesRead: number;
}

export interface MeterSnapshot {
  outputBytes: number;
  usage: Readonly<StreamUsage>;
  usageReported: boolean;
}

export interface StreamCallOptions {
  /** Aborts the upstream request and ends the stream (client disconnect, revocation, cancel). */
  signal?: AbortSignal | undefined;
  /**
   * Hard-stop hook, called after every event with the live meter. Returning a reason aborts the
   * upstream request; the stream ends and `result().abortReason` carries the reason.
   */
  shouldStop?: ((snap: MeterSnapshot) => StreamAbortReason | undefined) | undefined;
  /** Input estimate of the reservation, used when the provider reports no input usage. */
  inputEstimate?: number | undefined;
  /** Extra `anthropic-beta` values, each `^[a-z0-9._-]{1,64}$` (Anthropic transport only). */
  anthropicBeta?: readonly string[] | undefined;
}

export interface UpstreamStream {
  /** HTTP status of the upstream response (200 for Bedrock). */
  readonly status: number;
  /** Pull based: the upstream is read only when the consumer asks for the next event (backpressure). */
  readonly events: AsyncIterable<UpstreamEvent>;
  /** Ends the stream on purpose and closes the upstream connection. Safe to call repeatedly. */
  abort(reason?: StreamAbortReason): void;
  /** Live usage meter. */
  snapshot(): MeterSnapshot;
  /** Final accounting; valid after the iteration ended (also after an error or abort). */
  result(): StreamResult;
}

export interface StreamingTransport {
  readonly name: string;
  open(
    request: { body: Record<string, unknown>; model?: string | undefined },
    call?: StreamCallOptions,
  ): Promise<UpstreamStream>;
}

/** The caller aborted before the upstream connection delivered a response. */
export class StreamAbortedError extends OaxError {
  constructor(readonly abortReason: StreamAbortReason) {
    super('aborted', 'model call aborted before the upstream response started', {
      reason: abortReason,
    });
  }
}
