import { tracingEnabled, withSpan } from '@openagentix/api';
import type { ExecutorTelemetry } from '@openagentix/runners';

/** The run a span belongs to; ids only (ADR 0015 section 7.1). */
export interface RunSpanIdentity {
  runId: string;
  tenantId: string;
  tenantRootId?: string | undefined;
}

/**
 * Span hooks for the step executor (ADR 0015 slice S3). Every span carries the run's identity and
 * goes through the attribute allowlist and the telemetry guard like all other spans. Returns
 * `undefined` while no SDK provider is registered, so a process without an exporter runs the
 * executor exactly as before (no span objects, no sanitising).
 */
export function executorTelemetry(identity: RunSpanIdentity): ExecutorTelemetry | undefined {
  if (!tracingEnabled()) return undefined;
  const base = {
    'oax.run.id': identity.runId,
    'oax.tenant.id': identity.tenantId,
    ...(identity.tenantRootId ? { 'oax.tenant.root_id': identity.tenantRootId } : {}),
  };
  return {
    span: (spec, attributes, fn) =>
      withSpan({ name: spec.name, kind: spec.kind }, { ...attributes, ...base }, fn),
  };
}
