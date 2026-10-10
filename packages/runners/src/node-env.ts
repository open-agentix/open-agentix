import { parseTraceparent } from '@openagentix/core';

/**
 * The `traceparent` value a run node gets as `TRACEPARENT` (ADR 0015 section 6.1), or undefined.
 * Only a value with exactly the W3C shape passes: the node's environment is a place where an
 * odd string could be read as an option or a second variable, and the node uses the value for log
 * correlation only. It carries a trace id and a span id and nothing else (no tenant data, no
 * `tracestate`, no `baggage`).
 */
export function nodeTraceparent(value: string | undefined): string | undefined {
  return value !== undefined && parseTraceparent(value) !== null ? value : undefined;
}
