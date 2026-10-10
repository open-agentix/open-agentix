import { CLASSIFICATIONS, normalizeTarget } from '@openagentix/core';
import { z } from 'zod';

/**
 * The ADR 0012 connection type `telemetry` (ADR 0015 section 7.3, slice S10): a tenant-owned OTLP
 * exporter. The config is closed (unknown keys are refused) and holds no credential: exporter
 * headers come from `headersSecret`, a secret REFERENCE in the tenant's own namespace.
 */

export const TelemetryConnectionConfigSchema = z
  .object({
    /** Base URL of the collector (`/v1/traces` is appended), https only. */
    endpoint: z.string().min(1).max(2048),
    protocol: z.enum(['http/protobuf', 'http/json']).default('http/protobuf'),
    /** Secret reference whose value is `Name=value,Name2=value2` (the OTLP header list). */
    headersSecret: z.string().min(1).max(256).optional(),
    /** Where the collector processes data (ADR 0012 7.1), checked against OAX_OTEL_ALLOWED_REGIONS. */
    region: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,31}$/)
      .optional(),
    /** Highest data classification this exporter may receive as content (default `internal`). */
    clearance: z.enum(CLASSIFICATIONS).default('internal'),
    /** The tenant's content opt-in (ADR 0015 5.4); also needs the operator allow. */
    content: z.enum(['off', 'redacted']).default('off'),
    /** `false` keeps the connection but stops all export to it. */
    enabled: z.boolean().default(true),
  })
  .strict();

export type TelemetryConnectionConfig = z.infer<typeof TelemetryConnectionConfigSchema>;

/** Problems with an endpoint that do not need the network configuration (pure, no DNS). */
export function telemetryEndpointProblem(endpoint: string): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return 'endpoint must be a valid URL';
  }
  if (url.protocol !== 'https:') return 'endpoint must be an https:// URL';
  if (url.username || url.password || url.search || url.hash || /[?#]/.test(endpoint))
    return 'endpoint must not contain credentials, a query or a fragment (use headersSecret)';
  if (!normalizeTarget(endpoint)) return 'endpoint is not a valid destination';
  return null;
}

/** The traces URL of a collector base URL. */
export function telemetryTracesUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, '')}/v1/traces`;
}

type Listener = (tenantId: string) => void;
const listeners = new Set<Listener>();

/** The exporter registry subscribes here to drop what it cached about a tenant's connections. */
export function onTelemetryConnectionChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Called after a `telemetry` connection was created, changed or deleted (same process, at once). */
export function notifyTelemetryConnectionChanged(tenantId: string): void {
  for (const l of listeners) {
    try {
      l(tenantId);
    } catch {
      // A listener must not break the write that triggered it.
    }
  }
}
