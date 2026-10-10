/**
 * Span hooks of the step executor (ADR 0015 slice S3). The runners package knows nothing about
 * OpenTelemetry: the host (the worker) hands in an implementation that creates guarded spans, and
 * without one every call is a plain pass-through, so a process without an exporter behaves exactly
 * as before.
 *
 * What may be passed is limited by the allowlist of the host, but the executor itself only ever
 * passes metadata: names from the published definition, codes, counts and sizes. Never a prompt,
 * a response, a tool argument or result, an event payload or an error message.
 */

export type ExecutorSpanKind =
  'handover' | 'invoke_agent' | 'chat' | 'policy_check' | 'approval_wait' | 'execute_tool';

/** The only surface the executor gets: attributes and named events, no status, no exception. */
export interface ExecutorSpan {
  setAttributes(attributes: Record<string, unknown>): void;
  addEvent(name: string, attributes?: Record<string, unknown>): void;
}

export interface ExecutorTelemetry {
  /**
   * Runs `fn` inside a span that is a child of the active one. A thrown error ends the span as
   * failed (code and class only) and is rethrown unchanged.
   */
  span<T>(
    spec: { kind: ExecutorSpanKind; name: string },
    attributes: Record<string, unknown>,
    fn: (span: ExecutorSpan) => Promise<T>,
  ): Promise<T>;
}

export const NOOP_EXECUTOR_SPAN: ExecutorSpan = {
  setAttributes: () => undefined,
  addEvent: () => undefined,
};

export const NOOP_EXECUTOR_TELEMETRY: ExecutorTelemetry = {
  span: (_spec, _attributes, fn) => fn(NOOP_EXECUTOR_SPAN),
};
