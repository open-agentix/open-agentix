/**
 * Opt-in W3C trace context for MCP tool calls (ADR 0015 section 6.4, slice S8).
 *
 * This file is the ONE place that decides whether, and with what, a `tools/call` request is
 * enriched. Every path that makes a call on behalf of a run goes through `ToolGateway.call`, which
 * asks {@link traceMetaFor}; the in-process executor does so today, and the control-node relay
 * (ADR 0016 S4) calls the same gateway method, so both inherit the same rules.
 *
 * Rules, all enforced here and not by the callers:
 *  - Both switches must be on: the platform (`OAX_OTEL_MCP_PROPAGATION=allow`, default `deny`) and the
 *    connection (`telemetry.propagate: true`, default off). `deny` wins.
 *  - Only `params._meta.traceparent` is produced, in the strict `00-<trace>-<span>-<flags>` form. No
 *    `tracestate`, no `baggage`, no other `_meta` key, no HTTP header.
 *  - The value is validated here: a caller cannot hand in anything but a well-formed traceparent
 *    (a malformed one is dropped, not repaired, and nothing is sent).
 *  - Nothing the MCP server returns is ever read as a trace position.
 */

/** Platform switch (`OAX_OTEL_MCP_PROPAGATION`). Anything but `allow` means deny. */
export type McpPropagationPolicy = 'allow' | 'deny';

/** What may be added to the `_meta` of a request: exactly this, never more. */
export interface McpTraceMeta {
  traceparent: string;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-(0[01])$/;

/** True for a well-formed version-00 traceparent with non-zero ids and no flags besides `sampled`. */
export function isTraceparent(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 55) return false;
  const m = TRACEPARENT.exec(value);
  return m !== null && !/^0+$/.test(m[1]!) && !/^0+$/.test(m[2]!);
}

/** Builds the traceparent of a span position; `undefined` for an invalid position. */
export function formatTraceparent(
  traceId: string,
  spanId: string,
  sampled: boolean,
): string | undefined {
  const value = `00-${traceId}-${spanId}-${sampled ? '01' : '00'}`;
  return isTraceparent(value) ? value : undefined;
}

/**
 * The `_meta` to send with one `tools/call`, or `undefined` (send nothing, exactly as before).
 * `traceparent` is the position of the run's own `execute_tool` span.
 */
export function traceMetaFor(
  connection: { telemetry?: { propagate?: boolean } | undefined },
  platform: McpPropagationPolicy | undefined,
  traceparent: string | undefined,
): McpTraceMeta | undefined {
  if (platform !== 'allow') return undefined;
  if (connection.telemetry?.propagate !== true) return undefined;
  if (!isTraceparent(traceparent)) return undefined;
  return { traceparent };
}

/** MCP protocol versions the attribute `mcp.protocol.version` may carry (closed set). */
export const MCP_PROTOCOL_VERSIONS = [
  '2024-10-07',
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2025-11-25',
] as const;
