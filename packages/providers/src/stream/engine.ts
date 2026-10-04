import { UsageMeter } from './meter.js';
import { SseParser, type SseEvent } from './sse.js';
import {
  StreamAbortedError,
  StreamError,
  type MeterSnapshot,
  type StreamAbortReason,
  type StreamCallOptions,
  type StreamLimits,
  type StreamResult,
  type UpstreamEvent,
  type UpstreamStream,
} from './types.js';

/** Replaces every configured secret value in `text` and cuts it to `max` characters. */
export function scrub(text: string, secrets: readonly string[], max = 300): string {
  let out = text;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join('[redacted]');
  // Control characters (log forging, terminal escapes) never leave the transport.
  // eslint-disable-next-line no-control-regex
  out = out.replace(/[\u0000-\u001f\u007f]+/g, ' ');
  return out.length > max ? `${out.slice(0, max)}...` : out;
}

export type Cause =
  { kind: 'external'; reason: StreamAbortReason } | { kind: 'error'; error: StreamError };

/** Timers and abort plumbing of one call: deadline, time to first event, idle between events. */
export class StreamGuard {
  readonly controller = new AbortController();
  cause: Cause | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private readonly deadlineTimer: NodeJS.Timeout;
  private readonly aborted: Promise<never>;
  private events = 0;
  private detach: (() => void) | undefined;

  constructor(
    private readonly limits: StreamLimits,
    signal?: AbortSignal,
  ) {
    this.aborted = new Promise<never>((_, reject) => {
      this.controller.signal.addEventListener('abort', () => reject(this.controller.signal.reason));
    });
    this.aborted.catch(() => undefined); // never an unhandled rejection
    this.deadlineTimer = setTimeout(
      () => this.fail(new StreamError('deadline', 'model call exceeded its deadline')),
      limits.deadlineMs,
    );
    this.deadlineTimer.unref();
    this.armIdle();
    if (signal) {
      const onAbort = () =>
        this.stop(typeof signal.reason === 'string' ? signal.reason : 'client_abort');
      if (signal.aborted) onAbort();
      else {
        signal.addEventListener('abort', onAbort, { once: true });
        this.detach = () => signal.removeEventListener('abort', onAbort);
      }
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Called per complete event: the idle window restarts, trickled bytes never do that. */
  touch(): void {
    this.events++;
    this.armIdle();
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    const first = this.events === 0;
    this.idleTimer = setTimeout(
      () =>
        this.fail(
          first
            ? new StreamError('ttfb_timeout', 'upstream sent no event within the time limit')
            : new StreamError('idle_timeout', 'upstream stream was idle for too long'),
        ),
      first ? this.limits.ttfbMs : this.limits.idleMs,
    );
    this.idleTimer.unref();
  }

  /** Ends the call on purpose (not an error). */
  stop(reason: StreamAbortReason): void {
    if (this.cause) return;
    this.cause = { kind: 'external', reason };
    this.controller.abort(new StreamAbortedError(reason));
  }

  fail(error: StreamError): void {
    if (this.cause) return;
    this.cause = { kind: 'error', error };
    this.controller.abort(error);
  }

  /** Rejects as soon as the call is aborted, even when the upstream source ignores the signal. */
  race<T>(p: Promise<T>): Promise<T> {
    return Promise.race([p, this.aborted]);
  }

  dispose(): void {
    clearTimeout(this.idleTimer);
    clearTimeout(this.deadlineTimer);
    this.detach?.();
    // Closes the upstream socket if the response is still open.
    if (!this.controller.signal.aborted) this.controller.abort(new StreamAbortedError('closed'));
  }
}

export type FrameBatch = { done: true } | { done: false; frames: SseEvent[]; bytes: number };

export interface FrameSource {
  read(): Promise<FrameBatch>;
  /** Called at the end of a stream; throws `truncated` when an unfinished event is buffered. */
  finish(): void;
  close(): Promise<void> | void;
}

export interface HandlerOutcome {
  emit?: UpstreamEvent;
  /** Event type is outside the protocol allowlist: dropped and counted. */
  unknown?: boolean;
  /** Terminal event seen. */
  done?: boolean;
}

export interface ProtocolHandler {
  handle(frame: SseEvent, meter: UsageMeter): HandlerOutcome;
  /** Some endpoints end the stream without a terminal marker; true when the data is complete. */
  completeAtEof?(meter: UsageMeter): boolean;
}

/** Source of raw bytes parsed as SSE with strict limits. */
export function sseSource(
  body: ReadableStream<Uint8Array>,
  limits: StreamLimits,
  controller: AbortController,
): FrameSource {
  const reader = body.getReader();
  const parser = new SseParser(limits);
  return {
    async read() {
      const r = await reader.read();
      if (r.done) return { done: true };
      return { done: false, frames: parser.push(r.value), bytes: r.value.byteLength };
    },
    finish() {
      parser.end();
      if (parser.hasPending) {
        throw new StreamError('truncated', 'upstream stream ended inside an event');
      }
    },
    async close() {
      controller.abort(new StreamAbortedError('closed'));
      await reader.cancel().catch(() => undefined);
    },
  };
}

export interface EngineOptions {
  status: number;
  source: FrameSource;
  handler: ProtocolHandler;
  limits: StreamLimits;
  guard: StreamGuard;
  call: StreamCallOptions;
  secrets: readonly string[];
}

/** Turns a frame source into the pull-based, limit-enforcing `UpstreamStream`. */
export function createUpstreamStream(o: EngineOptions): UpstreamStream {
  const meter = new UsageMeter();
  const state = { complete: false, unknown: 0, bytes: 0 };
  let generator: AsyncGenerator<UpstreamEvent> | undefined;

  async function* run(): AsyncGenerator<UpstreamEvent> {
    try {
      let done = false;
      while (!done) {
        const batch = await o.guard.race(o.source.read());
        if (batch.done) break;
        state.bytes += batch.bytes;
        if (state.bytes > o.limits.maxTotalBytes) {
          throw new StreamError('response_too_large', 'upstream response exceeds the size limit');
        }
        for (const frame of batch.frames) {
          o.guard.touch();
          const out = o.handler.handle(frame, meter);
          if (out.unknown) state.unknown++;
          const why = o.call.shouldStop?.(meter.snapshot());
          if (why !== undefined) {
            o.guard.stop(why);
            return;
          }
          if (out.emit) yield out.emit;
          if (out.done) {
            state.complete = true;
            done = true;
            break;
          }
        }
      }
      if (!state.complete) {
        o.source.finish();
        if (o.handler.completeAtEof?.(meter)) state.complete = true;
        else throw new StreamError('truncated', 'upstream stream ended before its terminal event');
      }
    } catch (e) {
      const cause = o.guard.cause;
      if (cause?.kind === 'external') return;
      if (cause?.kind === 'error') throw cause.error;
      if (e instanceof StreamError) throw e;
      throw new StreamError(
        'upstream_error',
        `upstream stream failed: ${scrub(e instanceof Error ? e.message : 'unknown error', o.secrets)}`,
      );
    } finally {
      o.guard.dispose();
      // Not awaited: a source stuck in a read must not hold up the consumer.
      void Promise.resolve(o.source.close()).catch(() => undefined);
    }
  }

  return {
    status: o.status,
    get events() {
      generator ??= run();
      return generator as AsyncIterable<UpstreamEvent>;
    },
    abort(reason = 'client_abort') {
      o.guard.stop(reason);
      o.guard.dispose();
      // Close the socket now, even when nobody is iterating any more.
      void Promise.resolve(o.source.close()).catch(() => undefined);
    },
    snapshot(): MeterSnapshot {
      return meter.snapshot();
    },
    result(): StreamResult {
      const cause = o.guard.cause;
      return {
        ...meter.settle(state.complete, o.call.inputEstimate ?? 0),
        complete: state.complete,
        abortReason: cause?.kind === 'external' ? cause.reason : undefined,
        unknownEvents: state.unknown,
        bytesRead: state.bytes,
      };
    },
  };
}
