# Observability

openagentix emits OpenTelemetry traces (OTLP) and Prometheus metrics. The design, the threat
model and the slice plan are in [ADR 0015](adr/0015-opentelemetry-genai-tracing.md). This page
documents what is implemented; it grows with each slice.

> **Status.** Slice S5 completes the Prometheus metrics and removes tenant-chosen text from every
> label (section "Metrics"). The core is hardened (ADR 0015 slice S1): the attribute allowlist, error handling
> without messages, the exporter configuration and its safety rules. Slice S2 adds the run's trace
> identity, the audit links and the first spans: `oax.run.admit` at admission, one
> `invoke_workflow {name}` per worker attempt and one HTTP server span per API request. The spans
> below the workflow follow in later slices: slice S3 adds the executor spans of in-process steps
> (handover, agent, model call, policy check, approval wait, tool call); slice S4 adds the spans of
> isolated steps (run nodes and harnesses: model proxy `chat`, gate `oax.policy.check`,
> `oax.node.session` with bounded node events, `TRACEPARENT` for log correlation).

## Convention version

The GenAI semantic conventions are developed in
[`open-telemetry/semantic-conventions-genai`](https://github.com/open-telemetry/semantic-conventions-genai)
and every document there is still **Development** (experimental). The code is written against
commit `6fd0d76` (core conventions v1.44.0); the pin is the constant `GENAI_SEMCONV_PIN` in
`packages/core/src/telemetry/semconv.ts`. Following upstream is a deliberate pull request with
updated golden tests and a `Changed` changelog entry. Old and new names are never emitted together.

## What is exported (and what never is)

Telemetry is **metadata only**: names, versions, token counts, cost, latency, codes. Prompts,
responses, tool arguments and results, event payloads, exception messages, stack traces, HTTP
bodies, query strings, headers, user e-mail addresses, tenant names and slugs are never exported.
Tenants are identified by UUID (`oax.tenant.id`), never by name.

Three layers enforce this:

1. **Closed attribute allowlist** (`packages/core/src/telemetry/attribute-specs.ts`). Every key a
   span or span event may carry is listed per span kind with its type, length cap and value set.
   Strictly typed values (UUIDs, slugs, digests, enums) are dropped when they do not match; free
   text is control-character-free, guarded and truncated. A key that is not on the list is dropped
   and counted in `oax_otel_attributes_dropped_total{key_class}`
   (`unknown`, `content`, `wrong_span`, `invalid`, `overflow`).
2. **ContextGuard on every string.** Every string value, and every span name, passes
   `ContextGuard.text`: invisible steering Unicode is removed and secret values (known values
   such as the exporter headers, and common token shapes) are replaced by `[redacted:<kind>]`.
   A replacement sets `oax.redacted=true` and counts in `oax_otel_redactions_total{kind}`.
3. **Export boundary.** Right before the exporter, every span is rebuilt from the allowlist again
   (`GuardedSpanExporter`), so a span created with the raw tracer cannot carry a message, a stack
   or an unlisted attribute out of the process either.

Code creates spans with `withSpan({ name, kind }, attributes, fn)` only. The callback receives a
`GuardedSpan` (`setAttributes`, `addEvent`, `spanContext`): there is no raw `setAttribute`,
`recordException` or `setStatus`.

## Errors

A failed span has status `ERROR`. The status description and `error.type` are the platform's
**error code** (`OaxError.code`, a system code such as `ECONNREFUSED`) or `_OTHER`. One
`exception` event carries `exception.type` (the class name) and nothing else. The message, the
stack and the `cause` of an error are never read.

`OAX_OTEL_EXCEPTION_DETAIL=guarded` (default `off`) additionally records `exception.message`
after the ContextGuard, capped at 256 characters. The stack trace is never recorded. Enable it
only for a collector you trust with provider and tool error text.

## Exporter

The exporter is off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set: without it no SDK provider is
registered and no socket is opened.

- **Protocol:** `OTEL_EXPORTER_OTLP_PROTOCOL` is `http/protobuf` (default) or `http/json`.
- **TLS:** `http://` is accepted only for a loopback collector, or when `OAX_OTEL_INSECURE=true`
  (an in-cluster collector without TLS). Loopback means a literal loopback address (`127.0.0.0/8`,
  `[::1]`, also in decimal or hex notation, which the URL parser normalises) or the name
  `localhost`, which is resolved by the system resolver (`/etc/hosts`); prefer the literal address.
  Names such as `127.0.0.1.nip.io` are not loopback. The endpoint must not contain credentials, a
  query or a fragment.
- **Credentials:** exporter headers (for example a backend API key) come from
  `OAX_OTEL_HEADERS_SECRET`, a secret **reference** resolved through the secret resolver
  (`OAX_SECRET_<NAME>` or a file in `OAX_SECRETS_DIR`). The secret holds `Name=value,Name2=value2`.
  The values are registered with the guard, so they cannot appear in a span, and they are never
  logged. Like every known secret, a value shorter than 8 characters is not matched exactly (it
  would mangle ordinary text); use real credentials, not short placeholders.
- **Refused variables:** the standard `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_CERTIFICATE`,
  `OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE`, `OTEL_EXPORTER_OTLP_CLIENT_KEY` and their `_TRACES_`
  variants, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL`,
  `OTEL_TRACES_SAMPLER` and `OTEL_TRACES_SAMPLER_ARG` make start-up fail with a message that names
  the replacement. The OpenTelemetry SDK would read them implicitly (merging headers, loading
  certificate files, building its own sampler), which would be a second, unreviewed configuration
  path. Values are never echoed. `OTEL_SDK_DISABLED=true` or an `OTEL_TRACES_EXPORTER` other than
  `otlp` next to an endpoint also fails start-up: they are not read here, so they cannot turn the
  export off; unset `OTEL_EXPORTER_OTLP_ENDPOINT` instead.
- **Fixed in code, not read from the environment:** the sampler (always on, or the ratio sampler of
  `OAX_OTEL_SAMPLE_RATIO`, see [Sampling](#sampling)), the span limits (`OTEL_SPAN_*`, `OTEL_ATTRIBUTE_*`), the
  batch settings (`OTEL_BSP_*`) and the export timeout. No global propagator is registered
  (`OTEL_PROPAGATORS` is not read): nothing injects `traceparent` or `baggage` into outbound
  requests. `OTEL_EXPORTER_OTLP_COMPRESSION` is still applied by the exporter (it changes only
  the encoding of the payload).
- **No auto-instrumentation.** When another OpenTelemetry SDK is registered in the process (for
  example `@opentelemetry/auto-instrumentations-node` loaded with `NODE_OPTIONS=--require ...`,
  or injected by the OpenTelemetry Operator), start-up fails: its exporter would bypass the
  allowlist and the export guard, and its HTTP instrumentation would record full URLs and inject
  `traceparent` into every outbound request (ADR 0015 section 6.3).
- **No resource detectors.** The resource is static: `service.name` (`OTEL_SERVICE_NAME`) and the
  validated `OAX_OTEL_RESOURCE_ATTRIBUTES`. Nothing calls a cloud metadata endpoint or reads host
  details, and `OTEL_RESOURCE_ATTRIBUTES` is not read.
- **Never blocking.** The export queue is bounded (`OAX_OTEL_MAX_QUEUE`) and every export has a
  timeout (`OAX_OTEL_EXPORT_TIMEOUT_MS`). A full queue drops spans
  (`oax_otel_spans_dropped_total`); a failed export counts in
  `oax_otel_export_failures_total{reason}` (`timeout`, `network`, `http`, `other`) and is logged at
  most once a minute with the reason only. Shutdown waits at most 5 seconds.
- **Through the outbound dispatcher.** The exporter does not open sockets itself: it serialises the
  spans (OTLP protobuf or JSON) and posts them with `OutboundDispatcher.fetch` and the purpose
  `telemetry` (the network configuration, [ADR 0011](adr/0011-outbound-network-proxies-and-private-endpoints.md)). Routes, proxies, trust bundles and
  client certificates (mTLS) of the network file apply, a `deny` route and the cloud metadata
  addresses are refused, a redirect is an error (it is never followed), the connect, header and body
  times and the total time are bounded by `OAX_OTEL_EXPORT_TIMEOUT_MS`, and the response size is
  limited to 256 KiB (the body is not read). TLS verification is always on, and start-up fails with
  `NODE_TLS_REJECT_UNAUTHORIZED=0`. Route a collector with an `mTLS` route such as
  `{ "match": { "hosts": ["otel.internal.example"], "purposes": ["telemetry"] }, "via": "direct", "clientCertificate": "otel" }`;
  the secrets the network file references are loaded once at start-up. The route is resolved at
  start-up, so a denied or unusable destination refuses start-up (`egress_denied`,
  `network_secret_unavailable`) instead of failing every export later. The destination is checked
  by name and literal address like any platform destination; there is no DNS pinning (an internal
  collector normally has a private address). Nothing is retried: a failed batch is dropped and
  counted. At most two requests are in flight; further batches fail at once.
  `OTEL_EXPORTER_OTLP_COMPRESSION` is `none` (default) or `gzip`.
- **Air-gapped mode** fails closed *before* anything is created: with `OAX_AIRGAPPED=true` the
  endpoint must be on `OAX_AIRGAPPED_ALLOW` (host and port), otherwise start-up fails with
  `airgap_violation` before the header secret is resolved, before a dispatcher or exporter exists and
  before an SDK provider is registered. The process entry points (`api`, `worker`) activate the
  air-gapped configuration first and hand the policy to `initTelemetry`. Without an endpoint nothing
  is created at all (no provider, no socket), so a full air-gapped scenario ends with no blocked
  attempt. The network guard and the dispatcher's own allowlist rule apply on top.

## One trace per run

Every run gets its trace identity when its row is created (`RunsService.enqueue`, on the control
plane): `runs.trace_id` (16 random bytes, hex) and `runs.trace_root_span_id` (8 random bytes), both
from the operating system CSPRNG, written once, and never changed (a database trigger refuses an
update; shape checks refuse half-set, malformed or all-zero values). They are

- **not derived** from the run id, the tenant, the time or anything else, so a trace id says nothing
  about a run and two tenants' runs cannot be correlated through their trace ids;
- **never taken from an input**: a `traceparent` header, a webhook body, an event payload or a node
  report cannot choose, predict or join a run's trace;
- present **with or without an exporter** (they cost nothing and the audit chain stores them).

Runs created before migration `0020` have `NULL` ids: they have no trace, their audit entries are
unchanged, and their worker attempts start an unrelated trace each.

```text
oax.run.admit                       root span, the ids stored on the run (api or worker, at creation)
invoke_workflow {definition.name}   one per attempt (lease); child of the stored root span
```

- **`oax.run.admit`** (INTERNAL) is created with exactly the stored `trace_id` / `trace_root_span_id`
  and has no parent. The API or webhook request span that is active at admission is a **link**,
  never the parent. Attributes: `oax.run.id`, `oax.tenant.id`, `oax.trigger.kind`,
  `oax.admission.result` (`queued` or `blocked`), `oax.audit.seq`.
- **`invoke_workflow {name}`** (INTERNAL, worker) replaces the former `oax.run` span. Each attempt is
  a child of a remote context rebuilt from the two stored columns, so a run that a crashed worker
  lost and another worker retries is **one trace with several attempt spans**; the lost attempt's
  unexported spans are simply missing. Attributes: `gen_ai.operation.name`, `gen_ai.workflow.name`,
  `oax.agent.version`, `oax.run.attempt`, `oax.run.id`, `oax.tenant.id`, `oax.tenant.root_id`, and at
  the end `oax.run.status`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`,
  `oax.cost.micro_usd`, `oax.audit.seq`.
- **HTTP server span** `{METHOD} {route pattern}` (SERVER, api): created by a Fastify hook, not by
  `instrumentation-http`. Only the method, the route **pattern**, the status code and the access
  class (`oax.access`) are recorded; never a concrete path, a query string, a header or a body.
  Requests that match no route and `/healthz`, `/readyz`, `/metrics` get no span. Every request
  starts its own trace.

Spans only exist while an exporter is configured; ids and audit links do not depend on it.

## Executor spans (steps that run in the worker)

The step executor (`packages/runners/src/executor.ts`) knows nothing about OpenTelemetry. It calls
span **hooks** (`RunnerContext.telemetry`, `ExecutorTelemetry`) that the worker implements with
`withSpan`, so the allowlist, the guard and the export boundary apply unchanged. Without a
registered SDK the worker passes no hooks and the executor behaves exactly as before.

```text
invoke_workflow {name}
 ├─ oax.handover {step}                    condition + input validation (one per step, also when skipped)
 └─ invoke_agent {step}                    one per executed step
     ├─ chat {model}                       CLIENT; reservation + provider call
     ├─ oax.policy.check {server}/{tool}   gate decision
     ├─ oax.approval.wait {server}/{tool}  only when the decision is require_approval
     └─ execute_tool {tool}                the gateway call
```

Steps that a run node executes (isolated runners, harnesses) are not instrumented below
`invoke_agent` yet (slice S4).

| Span | Attributes (all from the allowlist) |
| --- | --- |
| `oax.handover` | `oax.step.id`, `oax.handover.explicit`, `oax.handover.result` (`ok`, `skipped`, `invalid`), `oax.schema.digest` (input schema, when there is one) |
| `invoke_agent` | `gen_ai.operation.name`, `gen_ai.agent.name` (step id), `gen_ai.agent.id` (`{definition}/{step}`), `gen_ai.agent.version`, `gen_ai.request.model`, `gen_ai.provider.name`, `oax.runner.kind`, and the step's token and cost totals (also when the step failed) |
| `chat` | `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.request.max_tokens`, `gen_ai.request.temperature`, `gen_ai.response.finish_reasons`, `gen_ai.usage.*` tokens (including cache read/write when reported), `oax.cost.micro_usd`, `oax.cost.priced`, `oax.usage.source`, `oax.model.via`, `oax.reservation.result` (`reserved`, `none`), `oax.provider.instance` |
| `oax.policy.check` | `gen_ai.tool.name`, `oax.mcp.server`, `oax.policy.effect`, `oax.policy.reason_codes` (codes, never messages) |
| `oax.approval.wait` | `oax.approval.outcome` (`approved`, `rejected`, `timeout`) |
| `execute_tool` | `gen_ai.operation.name`, `gen_ai.tool.name`, `gen_ai.tool.type=extension`, `gen_ai.tool.call.id` (only in the safe shape), `oax.mcp.server`, `oax.tool.result_bytes`, `oax.tool.truncated`, `oax.tool.is_error`, `oax.cost.micro_usd`; `error.type` for a refused or failed call |

Every span also carries `oax.run.id`, `oax.tenant.id` and `oax.tenant.root_id`.

**Span events** on the enclosing `invoke_agent` (or `oax.handover`) span carry counts, rule names and
codes only:

| Event | Attributes |
| --- | --- |
| `oax.control.decision` | `oax.control.action` (`pause`, `kill`), `oax.control.rules` (rule names such as `budget_cost`) |
| `oax.budget.breach` | `oax.budget.scopes` (`tenant`, `use_case`, `team`) |
| `oax.guard.report` | `oax.guard.source` (`input`, `tool_result`, `tool_error`), `oax.guard.invisible`, `oax.guard.secrets`, `oax.guard.secret_kinds` |
| `oax.handover.invalid` | `oax.validation.direction`, `oax.validation.attempt`, `oax.validation.violations`, `oax.schema.digest` |
| `oax.handover.retry` | `oax.validation.direction`, `oax.validation.attempt`, `oax.schema.digest` |
| `oax.output.valid` | `oax.validation.direction`, `oax.validation.attempt` |

A step that fails ends its span as `ERROR` with the failure code (`approval_timeout`,
`control_budget_use_case`, `handover_invalid`, a provider error code) as `error.type`.

**Never exported from the executor:** the prompt or the event payload, model output, tool
arguments, tool results and tool error text, provider error bodies, MCP tool descriptions, policy
or budget messages, approval comments, the `useCase` label. A tool name that the model made up
(and that the step does not expose) is **not** used as a span name or attribute: the span is named
`oax.policy.check _unknown`.

**Provider name.** `gen_ai.provider.name` comes from a closed table over the adapter family
(`anthropic`, `aws.bedrock`, `azure.ai.openai`, `openai`, `openrouter`, `ollama`, `lmstudio`,
`vllm`, `simulated`; an unknown family falls back to the adapter kind, then `other`). The
connection (instance) name is exported only as `oax.provider.instance` on `chat` spans, truncated
to 63 characters and guarded; it is never a span name, an event attribute or a metric label. For a
tenant-defined (BYOK) connection that name is chosen by the tenant: a shared collector shows it to
whoever can read the tenant's traces.

## Isolated steps (run nodes and harnesses)

A step that runs on a run node (container or Kubernetes job, with or without a harness) is
executed by an **untrusted process**. The worker still creates the step's `oax.handover` and
`invoke_agent` spans; everything below them is created by the **control node** (the API), never
from what the node says:

```text
invoke_agent {step}                          worker, dispatching span
 ├─ chat {model}                             API, model proxy (also the harness pass-through)
 ├─ oax.policy.check {server}/{tool}         API, gate route
 └─ oax.node.session                         API, lifetime of the session, node claims as events
```

**Stored context.** When the worker creates the session it writes the active `invoke_agent` span
as a `traceparent` to `run_node_sessions.trace_context` (only while an SDK is registered and only
when that span belongs to the run's own trace; otherwise the column stays empty and nothing below
happens). Every span the API makes for the session is a child of that stored context.

**`TRACEPARENT` for the node.** The node gets the same value as `TRACEPARENT` in its environment
(container and Kubernetes runner), and only when it has exactly the W3C shape. It is for **log
correlation only**: the node tags its own log lines with `trace_id` and `span_id`. The node has no
exporter and no route to a collector; harness telemetry stays disabled and the harness child does
not receive the variable. The value carries two random ids, no tenant data, `tracestate` or
`baggage`.

**A `traceparent` the node sends back is ignored.** On every node route (gate, steps, handover,
credentials, model token, model, pass-through) a `traceparent` header that is not the stored trace is
counted in `oax_otel_node_context_mismatch_total` and otherwise ignored: it is not a parent, not a
link, not a trace id.

**`chat {model}`** is made by the model proxy from its own numbers: provider family, the published
step's model, the reservation, the settled tokens, cost, price status and usage source
(`provider`, `estimate`, `floor`). `oax.model.via=proxy`, and `oax.model.surface` is `native`,
`anthropic` or `openai`. A refused call (`model_not_allowed`, `classification_denied`,
`egress_denied`, budget codes) ends as an `ERROR` span with the proxy's code as `error.type`. The
model a node *asked for* is not exported when it differs from the published one. This replaces the
`oax.model.call` / `gen_ai.system` of ADR 0009 section 12.

**`oax.policy.check`** wraps the control node's own decision. The tool name comes from the step's
**grant list**, not from the node: a call that matches a grant is named after the grant (a wildcard
grant `list_*` is exported as `list_*`, not as the name the node used), a call that matches none is
`oax.policy.check _unknown` with no tool or server attribute.

**`oax.node.session`** is emitted once, when the session ends (any revoke path), from creation to
revocation, with `oax.node.runner`, `oax.node.harness`, `oax.node.revoke_reason` and
`oax.node.events_dropped`. Accepted node reports are its **events**, never spans:

| Event | From the report | Attributes |
| --- | --- | --- |
| `oax.node.tool_call` | `tool_call` | `oax.claim=node`, `oax.claimed.status`, `oax.claimed.duration_ms`, `gen_ai.tool.name` and `oax.mcp.server` only if a grant of the step covers the call |
| `oax.node.output` | `output` | `oax.claim=node`, `oax.claimed.status`, `oax.claimed.duration_ms` |
| `oax.node.error` | `error` | `oax.claim=node`, `oax.claimed.status`, `oax.claimed.duration_ms` (no code, no message) |
| `oax.node.guard` | the input-guard report | `oax.claim=node`, `oax.guard.source`, `oax.guard.invisible`, `oax.guard.secrets`, `oax.guard.secret_kinds` (counts and the guard's closed kind names) |

What a node claims is bounded and never trusted:

- **Time.** An event is stamped when the control node *received* the report; a duration the node
  claims is only an attribute (capped at 1 hour), never a span time.
- **Count.** At most `OAX_OTEL_NODE_EVENTS_MAX` events per session (default 128; values above 1000 are refused at start-up);
  further reports are counted in `oax.node.events_dropped` and `oax_otel_node_events_dropped_total`.
  The cap is enforced in the database statement, so concurrent reports cannot exceed it. The
  ordinary step rows and audit entries of the reports are unaffected.
- **Content.** No message, code, argument, result, name or free text of a report is exported.
  Statuses come from a fixed set, counts are numbers with a ceiling, the tool name is the grant's.
  A model-call report is still refused (`step_kind_refused`) and never becomes an event.
- **Existence.** The events are kept in `run_node_sessions.otel_session` (migration
  `0022_run_node_otel_session`, written by the control node only, bounded by a check constraint)
  and read once when the session ends. Without a stored context (no SDK when the session was
  created) the column stays `NULL`, nothing is written and no span is emitted.

### Inbound `traceparent`

An inbound `traceparent` on an API request (webhook or authenticated) is never trusted: it is not
the parent of any span and not the trace of any run. `OAX_OTEL_INBOUND_CONTEXT` decides what else
happens, and the outcome is counted in `oax_otel_inbound_context_total{result}`:

| Value | Effect |
| --- | --- |
| `ignore` (default) | The header is dropped (`result=ignored`). |
| `link` | A well-formed header becomes a span **link** of the request span: trace id, span id and flags only, never `tracestate` or baggage (`result=linked`). Without an exporter nothing is linked and it counts as `ignored`. |

A header that is not exactly `00-<32 hex>-<16 hex>-<2 hex>` (lower-case, not all zero) counts as
`invalid` in both modes. The request is never rejected because of it.

### Audit links

The audit chain ([ADR 0002](adr/0002-audit-hash-chain.md)) stays the source of truth; traces may be
sampled, dropped or deleted. Both directions are linked:

- **Audit entry to trace.** Every audit entry of a run that has a trace identity gets
  `payload.otel = { "traceId": "<runs.trace_id>", "spanId": "<hex>" }`. The ids are written by the
  audit service from the run row; a caller-supplied `payload.otel` is always removed or replaced, so
  neither a node report nor a service can forge a link. `spanId` is the span that documents the
  entry when there is one (`run.queued` / `run.blocked`: `oax.run.admit`; `run.completed`: the
  attempt span that was active) and otherwise the root span of the run's trace. The field is part
  of the hashed payload, ids only, and is added only when the entry belongs to the run's own tenant
  (the `access.denied` entry that another tenant's request for a foreign run id causes carries no
  trace id).
- **Trace to audit entry.** A span that documents an entry carries `oax.audit.seq`, set after the
  entry is committed.

**Chain compatibility.** Verification recomputes the payload digest and the entry hash from the
stored payload; nothing about the algorithm changed. Entries written before the slice have no
`otel` and verify exactly as before (a golden test pins the digest and hash of such an entry), and
changing `otel` in a stored entry breaks the chain like any other payload change.

### Run API

`GET /v1/runs/{id}` returns `traceId` (null for runs without a trace) and, when
`OAX_OTEL_TRACE_URL_TEMPLATE` is set, `traceUrl` with the filled template. Both are returned only to
principals that may read the run (same tenant and permission as the rest of the run); the run
list, the trigger response and the other run endpoints do not contain them.

## Sampling

Volume is driven by the number of runs, so the default is `OAX_OTEL_SAMPLE_RATIO=1` (every run
is exported, complete). Below 1:

- **Head sampling by trace id.** The decision is a deterministic function of the run's trace id
  (the SDK's `TraceIdRatioBased` rule) and ignores any parent. The api and the worker see
  the same stored id, so they decide the same way without talking to each other. The HTTP request
  traces (every request starts its own trace) are sampled the same way.
- **Always keep** (`OAX_OTEL_KEEP`, default `error,deny,approval,budget,guard`): a run that was
  not sampled is still recorded (cheaply, in memory) but not exported. The `OaxKeepProcessor`
  buffers its finished spans per trace and releases the buffer, and every later span of that
  trace, when one span shows:

  | Class | Condition on a span |
  | --- | --- |
  | `error` | status `ERROR` |
  | `deny` | `oax.policy.effect=deny` |
  | `approval` | `oax.approval.outcome` is anything but `approved` |
  | `budget` | event `oax.budget.breach` |
  | `guard` | event `oax.guard.report` or `oax.node.guard` (emitted only for a non-empty report) |

  An empty `OAX_OTEL_KEEP` turns the path off (non-sampled runs are not recorded at all).
- **Nothing changes in what is exported.** The keep processor only decides *whether* spans reach
  the export queue; released spans pass the same allowlist and context guard at the export
  boundary as sampled ones. It reads fixed attribute values for classification and copies
  nothing.
- **A kept trace can be partial.** Each process decides on what it saw. A buffer is dropped when
  the attempt (`invoke_workflow`) or a request span ends without a match; a kept error trace from
  the worker does not contain the api's spans. Complete error traces at a low ratio are a job
  for tail sampling in the collector (below).

**Bounds.** Per trace, at most `OAX_OTEL_KEEP_BUFFER_SPANS` (default 512) finished spans are
buffered; further spans are dropped and counted. Per process the estimated size of all buffers is
capped at 4 MiB (an estimate: two bytes per character plus fixed per-span, per-attribute and per-event
costs; the measured heap for a full buffer is about 1.4 times the estimate, so the real worst case is
roughly 6 MiB per process); when the cap is exceeded the
oldest traces are evicted, whole. Memory does not grow with the number of runs or tenants, and a
kept trace leaves only a 128 byte marker in the same budget.

| Metric | Labels | Meaning |
| --- | --- | --- |
| `oax_otel_keep_kept_total` | `class` (`error`, `deny`, `approval`, `budget`, `guard`) | Not-sampled traces exported because of that class (the first matching class). |
| `oax_otel_keep_evicted_total` | `reason` (`run_buffer`, `process_cap`) | Spans discarded unexported: per-trace buffer full, or evicted by the process cap. |

Both are process-wide counters with closed labels; no run, tenant or span name reaches them.

### Collector tail sampling

Head sampling cannot know that a run will fail later. For complete traces of failed or denied runs
at a low ratio, export everything (`OAX_OTEL_SAMPLE_RATIO=1`) to a collector and let it decide once
the trace is complete. Example for the OpenTelemetry Collector (contrib distribution, `tail_sampling`
processor); adjust the wait and the percentage to your run length and volume:

```yaml
processors:
  tail_sampling:
    decision_wait: 60s          # longer than a typical run attempt
    num_traces: 50000           # bounds the collector's memory
    policies:
      - name: errors
        type: status_code
        status_code: { status_codes: [ERROR] }
      - name: policy-denied
        type: string_attribute
        string_attribute: { key: oax.policy.effect, values: [deny] }
      - name: approval-not-approved
        type: string_attribute
        string_attribute:
          key: oax.approval.outcome
          values: [rejected, timeout, cancelled]
      - name: budget-or-guard-events
        type: ottl_condition
        ottl_condition:
          error_mode: ignore
          span_event:
            - 'IsMatch(name, "^oax\\.(budget\\.breach|guard\\.report|node\\.guard)$")'
      - name: baseline
        type: probabilistic
        probabilistic: { sampling_percentage: 5 }

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [tail_sampling, batch]
      exporters: [otlp/backend]
```

`tail_sampling` keeps the policies as an OR: a trace is kept when any policy matches. Verify the
policy keys against the collector version you run. Use either head sampling in the platform or
tail sampling in the collector as the volume control, not both on the same traffic, or the two
ratios multiply.

## Log correlation

Every log line written inside a span carries `trace_id` and `span_id` (hex, ids only).

## Configuration

See [`configuration.md`](configuration.md#observability) for the table of variables. Keys whose
feature lands in a later slice (MCP propagation) are parsed and validated now and have no effect
yet; the sampling keys are in use since slice S6; `OAX_OTEL_NODE_EVENTS_MAX` is in use since slice S4 and
`OAX_OTEL_GENAI_METRICS` since slice S5.

## Metrics

`GET /metrics` on the api and the worker (optional bearer `OAX_METRICS_TOKEN`) is the only metrics
interface; there is no OTLP metric export. Prometheus metrics are an operations view for the whole
platform: **no label ever holds a tenant id, a tenant, team, agent, connection or event source
name, a use case, a model name chosen by a tenant, a tool name, a run id or an error message.**
Every label value is a member of a closed set and passes `apps/api/src/metric-labels.ts` right
before it is recorded, so a caller that passes a free text by mistake produces the fallback value
(`other`) instead of a new series. Per-tenant numbers come from the cost and run APIs.

| Metric | Type | Labels (closed sets) | Meaning |
| --- | --- | --- | --- |
| `oax_run_duration_seconds` | histogram | `status` (`succeeded`, `failed`, `cancelled`, `blocked_by_policy`), `trigger` (`manual`, `webhook`, `mail`, `kafka`, `cron`, `demo`, `other`) | From the first claim (creation if never claimed) to the end of the run, retries included. |
| `oax_step_duration_seconds` | histogram | `runner` (runner kinds), `status` (`ok`, `error`) | One executed agent step. |
| `oax_tool_calls_total` | counter | `decision` (`allow`, `deny`, `require_approval`), `result` (`ok`, `error`, `not_executed`) | In-process steps: every call the model asked for. Run nodes: calls they report (decision `allow`, an approval is not visible there); a denied call of a node is counted in `oax_policy_decisions_total` only. |
| `oax_approvals_total`, `oax_approval_wait_seconds` | counter, histogram | `outcome` (`approved`, `rejected`, `timeout`, `cancelled`) | Approval waits of in-process steps; `cancelled` is a wait that the run's abort ended. |
| `oax_tokens_total` | counter | `direction` (`input`, `output`, `cache_read`, `cache_write`), `provider` (family), `via` (`in-process`, `proxy`) | Tokens settled by the control node; `input` excludes cache tokens. `via="proxy"` counts the same tokens as `oax_model_proxy_tokens_total`, so one dashboard covers both paths. |
| `oax_budget_exhausted_total` | counter | `scope` (`run`, `step`, `team`, `use_case`, `tenant`), `limit` (`tokens`, `usd`, `steps`, `tool_calls`, `timeout`) | A model call refused at reservation, or a run killed by the control agent, because of a budget or the run timeout. |
| `oax_guard_replacements_total` | counter | `source` (`input`, `tool_result`, `tool_error`), `class` (`secret`, `invisible`) | Values the context guard removed or replaced (the number of values, never the values), also for run nodes. |
| `oax_node_reports_total` | counter | `kind` (step kinds), `result` (`accepted`, `refused`, `dropped`) | Step reports from untrusted run nodes: `refused` was answered with an error (a `model_call`), `dropped` was ignored (a kind a node may not report). The node *event* counters of slice S4 are `oax_otel_node_events_dropped_total` and `oax_otel_node_context_mismatch_total`. |
| `oax_cost_micro_usd_total` | counter | `provider` (family: `anthropic`, `aws.bedrock`, `azure.ai.openai`, `openai`, `openrouter`, `ollama`, `lmstudio`, `vllm`, `simulated`; `tool` for tool cost; `other`) | Model and tool cost. Resolved from the provider **instance** in the run's scope; the instance (connection) name is never a label. |
| `oax_events_ingested_total` | counter | `kind` (`webhook`, `mail`, `kafka`, `cron`), `outcome` | Ingested and refused events. |
| `oax_runs_created_total`, `oax_runs_refused_total` | counter | `trigger` (as above), `reason` | Admission. |
| `oax_otel_spans_dropped_total` | counter | – | Spans dropped because the export queue was full. |
| `oax_otel_export_failures_total` | counter | `reason` (`timeout`, `network`, `http`, `other`) | Failed exports. |
| `oax_otel_attributes_dropped_total` | counter | `key_class` | Attributes the allowlist refused. |
| `oax_otel_redactions_total` | counter | `kind` | Values the ContextGuard changed (secret kinds, `invisible`). |
| `oax_otel_inbound_context_total` | counter | `result` (`ignored`, `linked`, `invalid`) | Inbound `traceparent` headers on API requests. |
| `oax_otel_node_events_dropped_total` | counter | – | Node reports that did not become a span event because the session reached `OAX_OTEL_NODE_EVENTS_MAX`. |
| `oax_otel_node_context_mismatch_total` | counter | – | Run node requests whose `traceparent` is not the session's stored trace (ignored; a cheap signal for a tampered node). |

The older families (`oax_http_request_duration_seconds`, `oax_runs_by_status`, `oax_policy_decisions_total`,
`oax_model_proxy_*`, `oax_worker_active_runs`, ...) are unchanged. The model proxy's `provider` label is the
configured provider kind, never a connection name.

**Breaking label changes (pre-1.0, slice S5).** `oax_cost_micro_usd_total{provider}` used the
provider instance name, which for a tenant (BYOK) connection is the tenant's own text; it is now the
family. `oax_events_ingested_total{source}` used the event source name; it is now `{kind}`.
`oax_runs_created_total` and `oax_runs_refused_total` keep `trigger` but only the family of the
trigger (the first part of `triggered_by`), reduced to the set above. Dashboards and alerts that
select or group by `source`, or by a connection name, must be updated; the Grafana dashboard in
`deploy/grafana/openagentix-overview.json` uses the new labels. The Helm chart's `prometheusRule`
and dashboards live in `open-agentix-helm` and need the same change (tracked with the slice S9
Helm mirror issue).

### GenAI metrics (opt-in)

`OAX_OTEL_GENAI_METRICS=true` (default `false`: the names are still experimental) adds, in
Prometheus naming and without the `oax_` prefix: `gen_ai_client_inference_duration_seconds`,
`gen_ai_client_inference_usage_input_tokens_total`, `..._output_tokens_total`,
`..._cache_read_input_tokens_total`, `..._cache_write_input_tokens_total`,
`gen_ai_execute_tool_duration_seconds`, `gen_ai_invoke_agent_duration_seconds` and
`gen_ai_invoke_workflow_duration_seconds`. Labels: `gen_ai_operation_name`,
`gen_ai_provider_name` (family), `gen_ai_request_model` (**only** a model id of the pinned catalog
snapshot, every other value is `_OTHER`; a model that a tenant named in a BYOK connection and that
is not in the catalog is therefore `_OTHER`) and `error_type` (a closed list: empty on success,
`budget`, `timeout`, `cancelled`, `approval_timeout`, `handover_invalid`, `provider_error`,
`policy_denied`, `tool_error`, `_OTHER`). Series grow with the catalog (a few thousand model ids
at most), never with tenants. Durations of tool calls that a run node reports are its own claim and
stay out of `gen_ai_execute_tool_duration_seconds`.

### Cardinality test

`apps/worker/test/metrics-cardinality.test.ts` runs the default tenant's flows and 16 tenants with
random tenant, connection, agent and source names, then asserts that (1) the set of series does not
grow with new tenants and names, (2) every label value of every `oax_` metric is in its closed set
or shape, (3) a metric without a declared entry fails the test, so a new metric needs a reviewed
allowlist, and (4) none of the chosen names and no UUID appears anywhere in `/metrics`.
