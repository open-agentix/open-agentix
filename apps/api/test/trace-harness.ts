import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTRIBUTE_SPECS, spanKindFromName } from '@openagentix/core';
import { RunIdGenerator } from '../src/telemetry.js';
import { sanitizeReadableSpan } from '../src/telemetry-export.js';
import { telemetryRuntime, type TelemetryStats } from '../src/telemetry-runtime.js';

/**
 * An in-memory tracing setup that mirrors production wiring: the same id generator and the same
 * export-boundary sanitiser, without a network exporter. `stop()` unregisters it.
 */
export function startTracing(): {
  exporter: InMemorySpanExporter;
  provider: NodeTracerProvider;
  stop(): Promise<void>;
} {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    idGenerator: new RunIdGenerator(),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register({ propagator: null });
  return {
    exporter,
    provider,
    stop: async () => {
      await provider.shutdown();
      trace.disable();
    },
  };
}

/** Counting stats double. */
export function countingStats(): TelemetryStats & {
  dropped: Record<string, number>;
  inbound: Record<string, number>;
  node: { eventsDropped: number; mismatch: number };
} {
  const dropped: Record<string, number> = {};
  const inbound: Record<string, number> = {};
  const node = { eventsDropped: 0, mismatch: 0 };
  return {
    dropped,
    inbound,
    node,
    nodeEventsDropped: (n) => void (node.eventsDropped += n),
    nodeContextMismatch: (n) => void (node.mismatch += n),
    attributesDropped: (c, n) => void (dropped[c] = (dropped[c] ?? 0) + n),
    redactions: () => undefined,
    spansDropped: () => undefined,
    exportFailed: () => undefined,
    inboundContext: (r, n) => void (inbound[r] = (inbound[r] ?? 0) + n),
  };
}

/**
 * Compliance with the attribute allowlist: every key of every finished span is on the allowlist of
 * its span kind and survives the export-boundary sanitiser unchanged (nothing is dropped).
 */
export function attributesComply(spans: Parameters<typeof sanitizeReadableSpan>[0][]): string[] {
  const problems: string[] = [];
  for (const span of spans) {
    const clean = sanitizeReadableSpan(span, telemetryRuntime());
    for (const key of Object.keys(span.attributes)) {
      if (!(key in ATTRIBUTE_SPECS)) problems.push(`${span.name}: ${key} is not on the allowlist`);
      else if (!(key in clean.attributes))
        problems.push(`${span.name} (${spanKindFromName(span.name)}): ${key} would be dropped`);
    }
  }
  return problems;
}
