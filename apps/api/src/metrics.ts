import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/** Prometheus metrics of the control node and worker (`/metrics`). */
export class Metrics {
  readonly registry = new Registry();
  readonly httpDuration: Histogram<'method' | 'route' | 'status'>;
  readonly eventsIngested: Counter<'source' | 'outcome'>;
  readonly runsCreated: Counter<'trigger'>;
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
    this.runsCreated = new Counter({
      name: `${prefix}runs_created_total`,
      help: 'Runs created',
      labelNames: ['trigger'],
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
  }
}
