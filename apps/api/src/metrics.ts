import type { DropClass } from '@openagentix/core';
import { stripGeoPrefix } from '@openagentix/providers';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import {
  APPROVAL_OUTCOMES,
  BUDGET_LIMITS,
  BUDGET_RULES,
  BUDGET_SCOPES,
  ERROR_TYPES,
  EVENT_KINDS,
  GUARD_CLASSES,
  GUARD_SOURCES,
  NODE_REPORT_RESULTS,
  RUNNER_LABELS,
  RUN_STATUS_LABELS,
  STEP_KIND_LABELS,
  STEP_STATUS_LABELS,
  TRIGGER_KINDS,
  TOKEN_DIRECTIONS,
  TOKEN_VIA,
  TOOL_DECISIONS,
  TOOL_RESULTS,
  closed,
  errorTypeOf,
  providerLabel,
} from './metric-labels.js';
import type { TelemetryStats } from './telemetry-runtime.js';

/** Options of the registry; everything is optional so `new Metrics()` keeps working in tests. */
export interface MetricsOptions {
  /** Expose the opt-in GenAI metrics (`OAX_OTEL_GENAI_METRICS`). */
  genai?: boolean;
  /** Model ids of the catalog snapshot: the only model names a GenAI metric label may carry. */
  catalogModels?: ReadonlySet<string>;
}

/** What `Metrics.modelCall` records for one settled model call. */
export interface ModelCallObservation {
  /** Provider family label source (already a family, `providerLabel` closes it again). */
  provider: string;
  model: string | undefined;
  via: string;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  seconds: number | undefined;
  failed: boolean;
}

/** Prometheus metrics of the control node and worker (`/metrics`). */
export class Metrics {
  readonly registry = new Registry();
  readonly httpDuration: Histogram<'method' | 'route' | 'status'>;
  readonly eventsIngested: Counter<'kind' | 'outcome'>;
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
  /** Stored tenant stdio MCP connections that break the ADR 0016 S0 rules (no tenant labels). */
  readonly mcpStdioViolations: Gauge<string>;
  readonly mcpStdioRefused: Counter<'code'>;
  readonly roleBindingsReconcileFixes: Counter<'kind' | 'trigger'>;
  readonly roleBindingsReconcileRuns: Counter<'trigger' | 'outcome'>;
  // ADR 0015 S5: every label value is a member of a closed set (`metric-labels.ts`) and is
  // normalised by the recording method below, never taken from tenant input.
  readonly runDuration: Histogram<'status' | 'trigger'>;
  readonly stepDuration: Histogram<'runner' | 'status'>;
  readonly toolCalls: Counter<'decision' | 'result'>;
  readonly approvals: Counter<'outcome'>;
  readonly approvalWait: Histogram<'outcome'>;
  readonly tokens: Counter<'direction' | 'provider' | 'via'>;
  readonly budgetExhausted: Counter<'scope' | 'limit'>;
  readonly guardReplacements: Counter<'source' | 'class'>;
  readonly nodeReports: Counter<'kind' | 'result'>;
  private readonly genai: GenAiMetrics | null;
  private readonly catalogModels: ReadonlySet<string>;

  constructor(prefix = 'oax_', options: MetricsOptions = {}) {
    this.catalogModels = options.catalogModels ?? new Set();
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
      help:
        'Ingested events by source kind (webhook, mail, kafka, cron) and outcome; the event ' +
        'source name is tenant-chosen and is not a label (ADR 0015 S5)',
      labelNames: ['kind', 'outcome'],
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
    this.mcpStdioViolations = new Gauge({
      name: `${prefix}mcp_stdio_violations`,
      help: 'Stored tenant stdio MCP connections that violate the stdio rules (ADR 0016 S0)',
      registers: [this.registry],
    });
    this.mcpStdioRefused = new Counter({
      name: `${prefix}mcp_stdio_refused_total`,
      help: 'Stdio MCP servers refused at run time (code: error code)',
      labelNames: ['code'],
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
      help:
        'Model and tool cost in micro-USD by provider family (anthropic, openai, ...; `tool` for ' +
        'tool cost); the connection name is tenant-chosen and is not a label (ADR 0015 S5)',
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
    const otelInboundContext = new Counter({
      name: `${prefix}otel_inbound_context_total`,
      help: 'Inbound traceparent headers on API requests by outcome (ignored, linked, invalid); never used as a parent',
      labelNames: ['result'],
      registers: [this.registry],
    });
    this.runDuration = new Histogram({
      name: `${prefix}run_duration_seconds`,
      help: 'Run duration from first claim (or creation) to the end, by final status and trigger kind',
      labelNames: ['status', 'trigger'],
      buckets: [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800, 3600, 7200],
      registers: [this.registry],
    });
    this.stepDuration = new Histogram({
      name: `${prefix}step_duration_seconds`,
      help: 'Duration of an executed agent step by runner kind and outcome (ok, error)',
      labelNames: ['runner', 'status'],
      buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800],
      registers: [this.registry],
    });
    this.toolCalls = new Counter({
      name: `${prefix}tool_calls_total`,
      help:
        'Tool calls by policy decision (allow, deny, require_approval) and result (ok, error, ' +
        'not_executed); counted for in-process steps, and for steps of run nodes when reported',
      labelNames: ['decision', 'result'],
      registers: [this.registry],
    });
    this.approvals = new Counter({
      name: `${prefix}approvals_total`,
      help: 'Approval waits that ended, by outcome (approved, rejected, timeout, cancelled)',
      labelNames: ['outcome'],
      registers: [this.registry],
    });
    this.approvalWait = new Histogram({
      name: `${prefix}approval_wait_seconds`,
      help: 'Time a run waited for a human approval, by outcome',
      labelNames: ['outcome'],
      buckets: [1, 5, 30, 60, 300, 900, 3600, 14400, 86400],
      registers: [this.registry],
    });
    this.tokens = new Counter({
      name: `${prefix}tokens_total`,
      help:
        'Tokens settled by the control node for in-process and proxied model calls, by direction ' +
        '(input excludes cache tokens), provider family and path (in-process, proxy)',
      labelNames: ['direction', 'provider', 'via'],
      registers: [this.registry],
    });
    this.budgetExhausted = new Counter({
      name: `${prefix}budget_exhausted_total`,
      help: 'Runs stopped by a budget or the run timeout, by budget scope and limit',
      labelNames: ['scope', 'limit'],
      registers: [this.registry],
    });
    this.guardReplacements = new Counter({
      name: `${prefix}guard_replacements_total`,
      help:
        'Values the context guard removed or replaced, by source (input, tool_result, ' +
        'tool_error) and class (secret, invisible); counts only, never the values',
      labelNames: ['source', 'class'],
      registers: [this.registry],
    });
    this.nodeReports = new Counter({
      name: `${prefix}node_reports_total`,
      help:
        'Step reports from untrusted run nodes by step kind and result (accepted, refused: ' +
        'rejected with an error, dropped: ignored)',
      labelNames: ['kind', 'result'],
      registers: [this.registry],
    });
    this.genai = options.genai ? new GenAiMetrics(this.registry) : null;
    const otelNodeEventsDropped = new Counter({
      name: `${prefix}otel_node_events_dropped_total`,
      help: 'Run node reports not exported as span events because the per-session cap was reached',
      registers: [this.registry],
    });
    const otelNodeContextMismatch = new Counter({
      name: `${prefix}otel_node_context_mismatch_total`,
      help: 'Run node requests whose traceparent header is not the stored context of the session (ignored)',
      registers: [this.registry],
    });
    const otelKeepKept = new Counter({
      name: `${prefix}otel_keep_kept_total`,
      help: 'Not-sampled traces exported because of an always-keep class (error, deny, approval, budget, guard)',
      labelNames: ['class'],
      registers: [this.registry],
    });
    const otelKeepEvicted = new Counter({
      name: `${prefix}otel_keep_evicted_total`,
      help: 'Spans of not-sampled traces discarded by the keep buffer, by reason (run_buffer, process_cap)',
      labelNames: ['reason'],
      registers: [this.registry],
    });
    this.otel = {
      keepKept: (keepClass) => otelKeepKept.inc({ class: keepClass }),
      keepEvicted: (reason, n) => otelKeepEvicted.inc({ reason }, n),
      nodeEventsDropped: (n) => otelNodeEventsDropped.inc(n),
      nodeContextMismatch: (n) => otelNodeContextMismatch.inc(n),
      inboundContext: (result, n) => otelInboundContext.inc({ result }, n),
      attributesDropped: (keyClass: DropClass, n) =>
        otelAttributesDropped.inc({ key_class: keyClass }, n),
      redactions: (kind, n) => otelRedactions.inc({ kind }, n),
      spansDropped: (n) => otelSpansDropped.inc(n),
      exportFailed: (reason) => otelExportFailures.inc({ reason }),
    };
  }

  // ---- recording methods: the only way the metrics above are fed from the services ----

  /** Cost line of a step or settlement; `provider` may be any value, only the family label is kept. */
  cost(provider: string | undefined, micros: number): void {
    if (micros > 0) this.costMicros.inc({ provider: providerLabel(provider) }, micros);
  }

  /** An ingested (or refused) event by source kind. */
  eventIngested(kind: string, outcome: string): void {
    this.eventsIngested.inc({ kind: closed(EVENT_KINDS, kind), outcome: safeCode(outcome) });
  }

  toolCall(decision: string, result: string): void {
    this.toolCalls.inc({
      decision: closed(TOOL_DECISIONS, decision, 'allow'),
      result: closed(TOOL_RESULTS, result, 'error'),
    });
  }

  approval(outcome: string, waitSeconds: number): void {
    const o = closed(APPROVAL_OUTCOMES, outcome, 'cancelled');
    this.approvals.inc({ outcome: o });
    this.approvalWait.observe({ outcome: o }, finiteSeconds(waitSeconds));
  }

  /** One executed agent step. */
  step(runner: string, ok: boolean, seconds: number, errorCode?: string | null): void {
    const r = closed(RUNNER_LABELS, runner, 'in-process');
    const status = ok ? 'ok' : 'error';
    this.stepDuration.observe(
      { runner: r, status: closed(STEP_STATUS_LABELS, status) },
      finiteSeconds(seconds),
    );
    this.genai?.operation('invoke_agent', ok ? '' : errorTypeOf(errorCode ?? '_unknown'), seconds);
  }

  runFinished(status: string, trigger: string, seconds: number, errorCode: string | null): void {
    const st = closed(RUN_STATUS_LABELS, status);
    this.runDuration.observe(
      { status: st, trigger: closed(TRIGGER_KINDS, trigger) },
      finiteSeconds(seconds),
    );
    this.genai?.operation(
      'invoke_workflow',
      st === 'succeeded' ? '' : errorTypeOf(errorCode ?? '_unknown'),
      seconds,
    );
  }

  /** A control decision of kind `kill` with these rule names; each budget rule counts once. */
  controlKill(rules: readonly string[]): void {
    for (const rule of new Set(rules)) {
      const hit = Object.hasOwn(BUDGET_RULES, rule) ? BUDGET_RULES[rule] : undefined;
      if (!hit) continue;
      this.budgetExhausted.inc({
        scope: closed(BUDGET_SCOPES, hit[0]),
        limit: closed(BUDGET_LIMITS, hit[1]),
      });
    }
  }

  guard(source: string | undefined, secrets: number, invisible: number): void {
    const src = closed(GUARD_SOURCES, source, 'input');
    if (secrets > 0)
      this.guardReplacements.inc({ source: src, class: closed(GUARD_CLASSES, 'secret') }, secrets);
    if (invisible > 0)
      this.guardReplacements.inc(
        { source: src, class: closed(GUARD_CLASSES, 'invisible') },
        invisible,
      );
  }

  nodeReport(kind: string, result: string): void {
    this.nodeReports.inc({
      kind: closed(STEP_KIND_LABELS, kind),
      result: closed(NODE_REPORT_RESULTS, result, 'refused'),
    });
  }

  /** Tokens (and, when enabled, the GenAI inference series) of one settled model call. */
  modelCall(o: ModelCallObservation): void {
    const provider = providerLabel(o.provider);
    const via = closed(TOKEN_VIA, o.via, 'in-process');
    const add = (direction: string, n: number) => {
      if (n > 0)
        this.tokens.inc({ direction: closed(TOKEN_DIRECTIONS, direction), provider, via }, n);
    };
    add('input', o.tokens.input);
    add('output', o.tokens.output);
    add('cache_read', o.tokens.cacheRead);
    add('cache_write', o.tokens.cacheWrite);
    this.genai?.inference(provider, this.modelLabel(o.model), o.tokens, o.seconds, o.failed);
  }

  /** Duration of a tool execution for the GenAI series (no-op unless enabled). */
  toolExecuted(seconds: number | undefined, failed: boolean): void {
    this.genai?.operation('execute_tool', failed ? 'tool_error' : '', seconds);
  }

  /** The model id when it is in the catalog snapshot, else `_OTHER`. */
  modelLabel(model: string | undefined): string {
    if (!model) return '_OTHER';
    return this.catalogModels.has(model) || this.catalogModels.has(stripGeoPrefix(model))
      ? model
      : '_OTHER';
  }
}

const finiteSeconds = (s: number): number => (Number.isFinite(s) && s >= 0 ? s : 0);

/** Webhook verification codes are short snake_case slugs; anything else is `error`. */
const safeCode = (c: string): string => (/^[a-z][a-z0-9_]{0,40}$/.test(c) ? c : 'error');

/**
 * Opt-in GenAI metrics (`OAX_OTEL_GENAI_METRICS`, ADR 0015 section 10.2) in Prometheus naming.
 * Labels: operation, provider family, model (catalog models only, else `_OTHER`) and a closed
 * `error_type`. No tenant, agent, run or connection label.
 */
class GenAiMetrics {
  private readonly inferenceDuration: Histogram<string>;
  private readonly usage: Record<'input' | 'output' | 'cacheRead' | 'cacheWrite', Counter<string>>;
  private readonly operationDuration: Record<
    'execute_tool' | 'invoke_agent' | 'invoke_workflow',
    Histogram<string>
  >;

  constructor(registry: Registry) {
    const buckets = [
      0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92,
    ];
    this.inferenceDuration = new Histogram({
      name: 'gen_ai_client_inference_duration_seconds',
      help: 'Duration of model calls (GenAI semantic conventions, development status)',
      labelNames: [
        'gen_ai_operation_name',
        'gen_ai_provider_name',
        'gen_ai_request_model',
        'error_type',
      ],
      buckets,
      registers: [registry],
    });
    const counter = (name: string, help: string) =>
      new Counter({
        name,
        help,
        labelNames: ['gen_ai_operation_name', 'gen_ai_provider_name', 'gen_ai_request_model'],
        registers: [registry],
      });
    this.usage = {
      input: counter(
        'gen_ai_client_inference_usage_input_tokens_total',
        'Input tokens of model calls',
      ),
      output: counter(
        'gen_ai_client_inference_usage_output_tokens_total',
        'Output tokens of model calls',
      ),
      cacheRead: counter(
        'gen_ai_client_inference_usage_cache_read_input_tokens_total',
        'Input tokens served from the provider cache',
      ),
      cacheWrite: counter(
        'gen_ai_client_inference_usage_cache_write_input_tokens_total',
        'Input tokens written to the provider cache',
      ),
    };
    const op = (name: string, operation: string) =>
      new Histogram({
        name,
        help: `Duration of ${operation} operations (GenAI semantic conventions, development status)`,
        labelNames: ['gen_ai_operation_name', 'error_type'],
        buckets,
        registers: [registry],
      });
    this.operationDuration = {
      execute_tool: op('gen_ai_execute_tool_duration_seconds', 'execute_tool'),
      invoke_agent: op('gen_ai_invoke_agent_duration_seconds', 'invoke_agent'),
      invoke_workflow: op('gen_ai_invoke_workflow_duration_seconds', 'invoke_workflow'),
    };
  }

  inference(
    provider: string,
    model: string,
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number },
    seconds: number | undefined,
    failed: boolean,
  ): void {
    const base = {
      gen_ai_operation_name: 'chat',
      gen_ai_provider_name: provider,
      gen_ai_request_model: model,
    };
    if (seconds !== undefined)
      this.inferenceDuration.observe(
        { ...base, error_type: failed ? 'provider_error' : '' },
        finiteSeconds(seconds),
      );
    if (tokens.input > 0) this.usage.input.inc(base, tokens.input);
    if (tokens.output > 0) this.usage.output.inc(base, tokens.output);
    if (tokens.cacheRead > 0) this.usage.cacheRead.inc(base, tokens.cacheRead);
    if (tokens.cacheWrite > 0) this.usage.cacheWrite.inc(base, tokens.cacheWrite);
  }

  operation(
    operation: 'execute_tool' | 'invoke_agent' | 'invoke_workflow',
    errorType: string,
    seconds: number | undefined,
  ): void {
    if (seconds === undefined) return;
    this.operationDuration[operation].observe(
      { gen_ai_operation_name: operation, error_type: closed(ERROR_TYPES, errorType, '_OTHER') },
      finiteSeconds(seconds),
    );
  }
}
