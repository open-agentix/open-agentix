import type { DropClass } from '@openagentix/core';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { TelemetryStats } from './telemetry-runtime.js';

/** Prometheus metrics of the control node and worker (`/metrics`). */
export class Metrics {
  readonly registry = new Registry();
  readonly httpDuration: Histogram<'method' | 'route' | 'status'>;
  readonly eventsIngested: Counter<'source' | 'outcome'>;
  readonly runsCreated: Counter<'trigger'>;
  readonly runsRefused: Counter<'trigger' | 'reason'>;
  readonly runsFinished: Counter<'status'>;
  readonly policyDecisions: Counter<'effect'>;
  readonly queueDepth: Gauge<'status'>;
  readonly costMicros: Counter<'provider'>;
  readonly workerActiveRuns: Gauge<'worker'>;
  readonly modelProxyRequests: Counter<'surface' | 'provider' | 'code'>;
  readonly modelProxyTokens: Counter<'direction' | 'source'>;
  readonly modelProxyReservedMicros: Gauge<string>;
  readonly modelProxyReservationsActive: Gauge<string>;
  readonly modelProxyDuration: Histogram<'phase'>;
  readonly modelProxyAborts: Counter<'reason'>;
  readonly modelProxyStreamsActive: Gauge<string>;
  /** Counters of the tracing pipeline itself (ADR 0015 section 8); label values are closed sets. */
  readonly otel: TelemetryStats;
  readonly roleBindingsShadow: Counter<'outcome' | 'authoritative'>;
  readonly authzEpochRejected: Counter<'reason'>;
  readonly roleBindingsReconcileFixes: Counter<'kind' | 'trigger'>;
  readonly roleBindingsReconcileRuns: Counter<'trigger' | 'outcome'>;

  constructor(prefix = 'oax_') {
    collectDefaultMetrics({ register: this.registry, prefix });
    this.httpDuration = new Histogram({
      name: `${prefix}http_request_duration_seconds`,
      help: 'HTTP request duration',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.registry],
    });
    this.eventsIngested = new Counter({
      name: `${prefix}events_ingested_total`,
      help: 'Ingested events',
      labelNames: ['source', 'outcome'],
      registers: [this.registry],
    });
    this.roleBindingsShadow = new Counter({
      name: `${prefix}role_bindings_shadow_total`,
      help:
        'Shadow comparison of the tenant role resolver with the legacy bindings (ADR 0014 S1, S2): ' +
        'outcome match, mismatch, error or skipped; `authoritative` names the source that decides ' +
        '(legacy, or bindings once OAX_ROLE_BINDINGS_READ=bindings) and the other one is compared',
      labelNames: ['outcome', 'authoritative'],
      registers: [this.registry],
    });
    this.authzEpochRejected = new Counter({
      name: `${prefix}authz_epoch_rejected_total`,
      help:
        'Cached principals rejected because the authz epoch of their organisation moved (ADR 0014 ' +
        'S2, #227): reason stale (the epoch changed since the entry was built) or invalid (the ' +
        'entry did not belong to the token, was malformed or its owner check failed)',
      labelNames: ['reason'],
      registers: [this.registry],
    });
    this.roleBindingsReconcileFixes = new Counter({
      name: `${prefix}role_bindings_reconcile_fixes_total`,
      help:
        'Rows the reconcile of tenant_role_bindings against users.global_roles changed (ADR 0014 ' +
        'S1, #216): kind added or removed; blocked = a wanted role whose key is held by a ' +
        'non-managed row (kept, needs a look). A non-zero rate outside a deploy means an old ' +
        'application version or a manual change writes global_roles without the mirror',
      labelNames: ['kind', 'trigger'],
      registers: [this.registry],
    });
    this.roleBindingsReconcileRuns = new Counter({
      name: `${prefix}role_bindings_reconcile_runs_total`,
      help:
        'Reconcile runs of the role binding mirror by trigger (startup, periodic, mismatch, cli) ' +
        'and outcome (ok, error, skipped)',
      labelNames: ['trigger', 'outcome'],
      registers: [this.registry],
    });
    this.runsCreated = new Counter({
      name: `${prefix}runs_created_total`,
      help: 'Runs created',
      labelNames: ['trigger'],
      registers: [this.registry],
    });
    this.runsRefused = new Counter({
      name: `${prefix}runs_refused_total`,
      help: 'Runs refused at admission (for example because the agent is disabled)',
      labelNames: ['trigger', 'reason'],
      registers: [this.registry],
    });
    this.runsFinished = new Counter({
      name: `${prefix}runs_finished_total`,
      help: 'Runs finished',
      labelNames: ['status'],
      registers: [this.registry],
    });
    this.policyDecisions = new Counter({
      name: `${prefix}policy_decisions_total`,
      help: 'Policy gate decisions',
      labelNames: ['effect'],
      registers: [this.registry],
    });
    this.queueDepth = new Gauge({
      name: `${prefix}runs_by_status`,
      help: 'Runs per status (sampled on scrape)',
      labelNames: ['status'],
      registers: [this.registry],
    });
    this.costMicros = new Counter({
      name: `${prefix}cost_micro_usd_total`,
      help: 'Model and tool cost in micro-USD',
      labelNames: ['provider'],
      registers: [this.registry],
    });
    this.workerActiveRuns = new Gauge({
      name: `${prefix}worker_active_runs`,
      help: 'Runs currently executed by a worker process',
      labelNames: ['worker'],
      registers: [this.registry],
    });
    // Model proxy (ADR 0009 section 12): no tenant, run or token labels; provider = instance name.
    this.modelProxyRequests = new Counter({
      name: `${prefix}model_proxy_requests_total`,
      help: 'Model proxy requests by surface, provider and result code',
      labelNames: ['surface', 'provider', 'code'],
      registers: [this.registry],
    });
    this.modelProxyTokens = new Counter({
      name: `${prefix}model_proxy_tokens_total`,
      help: 'Tokens settled by the model proxy',
      labelNames: ['direction', 'source'],
      registers: [this.registry],
    });
    this.modelProxyReservedMicros = new Gauge({
      name: `${prefix}model_proxy_reserved_micros`,
      help: 'Micro-USD currently reserved by active model calls (this replica)',
      registers: [this.registry],
    });
    this.modelProxyReservationsActive = new Gauge({
      name: `${prefix}model_proxy_reservations_active`,
      help: 'Active model call reservations (this replica)',
      registers: [this.registry],
    });
    this.modelProxyDuration = new Histogram({
      name: `${prefix}model_proxy_duration_seconds`,
      help: 'Model proxy call duration by phase (ttfb, total)',
      labelNames: ['phase'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600],
      registers: [this.registry],
    });
    this.modelProxyAborts = new Counter({
      name: `${prefix}model_proxy_aborts_total`,
      help: 'Model calls ended by the proxy (hard stop) by reason',
      labelNames: ['reason'],
      registers: [this.registry],
    });
    this.modelProxyStreamsActive = new Gauge({
      name: `${prefix}model_proxy_streams_active`,
      help: 'Open model streams on this replica',
      registers: [this.registry],
    });
    const otelSpansDropped = new Counter({
      name: `${prefix}otel_spans_dropped_total`,
      help: 'Spans dropped because the export queue was full',
      registers: [this.registry],
    });
    const otelExportFailures = new Counter({
      name: `${prefix}otel_export_failures_total`,
      help: 'Failed span exports by reason (timeout, network, http, other)',
      labelNames: ['reason'],
      registers: [this.registry],
    });
    const otelAttributesDropped = new Counter({
      name: `${prefix}otel_attributes_dropped_total`,
      help: 'Span attributes dropped by the allowlist, by key class (unknown, content, wrong_span, invalid, overflow)',
      labelNames: ['key_class'],
      registers: [this.registry],
    });
    const otelRedactions = new Counter({
      name: `${prefix}otel_redactions_total`,
      help: 'Values changed by the context guard before they reached a span, by kind',
      labelNames: ['kind'],
      registers: [this.registry],
    });
    this.otel = {
      attributesDropped: (keyClass: DropClass, n) =>
        otelAttributesDropped.inc({ key_class: keyClass }, n),
      redactions: (kind, n) => otelRedactions.inc({ kind }, n),
      spansDropped: (n) => otelSpansDropped.inc(n),
      exportFailed: (reason) => otelExportFailures.inc({ reason }),
    };
  }
}
