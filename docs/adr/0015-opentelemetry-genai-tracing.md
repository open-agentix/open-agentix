# ADR 0015: Observability with OpenTelemetry GenAI semantic conventions

- Status: Proposed. Slices S1, S2, S3 and S4 are implemented (see "Implementation notes S2/S3/S4"
  below and [`observability.md`](../observability.md)); S5 to S10 are open.
- Date: 2026-10-10
- Plan items: W3-5 (#37, "Observability completion: step, model and tool spans and the missing
  metrics"); RM-53 of the roadmap gap list; replaces the span list in the W3-5 acceptance
  criteria of the [implementation plan](../IMPLEMENTATION-PLAN.md)
- Builds on: [ADR 0002](0002-audit-hash-chain.md) (audit chain),
  [ADR 0003](0003-policy-engine-audit-and-control-agents.md) (policy gate, control agent),
  [ADR 0006](0006-control-node-and-worker-nodes.md) (control node and workers),
  [ADR 0007](0007-tenants-as-isolation-boundary.md) (tenants),
  [ADR 0008](0008-agents-md-data-flow-and-isolation-contract.md) (handovers, run nodes),
  [ADR 0009](0009-model-proxy.md) (model proxy, capture levels),
  [ADR 0011](0011-outbound-network-proxies-and-private-endpoints.md) (outbound routes, purpose
  `telemetry`), [ADR 0012](0012-connections-instances-scopes-and-data-protection.md) (data
  protection), [ADR 0013](0013-hierarchical-tenants-and-setup-modes.md) (tenant tree, setup modes)
- Amends: ADR 0009 section 12 (the span `oax.model.call` with `gen_ai.system` becomes the
  convention-conformant `chat {gen_ai.request.model}` span with `gen_ai.provider.name`, see 3.3)

## Context

What exists on `main` (commit `1e8a7ae`), verified in the code:

- **Traces: one span per run.** `apps/api/src/telemetry.ts` registers a `NodeTracerProvider` with
  a `BatchSpanProcessor` and the OTLP/HTTP (JSON) exporter `@opentelemetry/exporter-trace-otlp-http`
  when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (`<endpoint>/v1/traces`), resource
  `service.name` only. The api (`apps/api/src/main.ts`) and the worker
  (`apps/worker/src/main.ts`) call `initTelemetry`. The only span in the code base is `oax.run`
  (`apps/worker/src/worker.ts`, attributes `oax.run_id`, `oax.worker`) around
  `runner.execute`. There are no step, model, tool, policy, approval or HTTP spans, no
  `gen_ai.*` attribute anywhere, no `traceparent` handling, no log correlation by trace id.
  Run nodes (`apps/worker/src/run-node-cli.ts`) do not initialise telemetry.
- **The ADR 0009 span is not implemented.** ADR 0009 section 12 and W1-3b-9 name a span
  `oax.model.call` with `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.*`; no code emits it.
- **`withSpan` records raw error messages.** On failure it calls `span.recordException(e)` and
  `setStatus({ message: e.message })`. Provider and tool error messages can contain response
  bodies, tool output or secrets (the executor runs tool error messages through the
  `ContextGuard` before storing them, the span path does not). Today this only affects the one
  `oax.run` span, but it is the pattern every new span would copy.
- **The exporter bypasses the outbound dispatcher.** The OTLP exporter uses its own HTTP client.
  In air-gapped mode the start-up self-check lists the OTel endpoint
  (`apps/api/src/airgap.ts`, `configuredEndpoints`) and the network guard
  (`packages/providers/src/network-guard.ts`) blocks non-allowlisted hosts at the socket level,
  but ADR 0011 routes (proxies, trust bundles, client certificates) do not apply, although
  `telemetry` is already a declared `NetworkPurpose` (`packages/core/src/network/config.ts`).
  The SDK also reads the standard `OTEL_EXPORTER_OTLP_*` variables (headers, certificates)
  implicitly; none of them is documented.
- **Metrics** (`apps/api/src/metrics.ts`, prom-client, prefix `oax_`, `GET /metrics` on api and
  worker, optional bearer `OAX_METRICS_TOKEN`): HTTP duration, events ingested, runs
  created/refused/finished, policy decisions, runs by status, cost, worker active runs, and the
  model proxy family (`oax_model_proxy_*`). Missing per W3-5: tool calls, approvals, tokens of
  in-process calls, budget exhaustion, run and step durations.
- **Two metric labels carry tenant-chosen names** (cardinality and cross-tenant leak in a shared
  Prometheus): `oax_cost_micro_usd_total{provider}` is fed from `step.provider`
  (`apps/api/src/services/step-writer.ts`), which is the provider **instance** name and for BYOK
  `model` connections the tenant's connection name (`ModelsService.registryFor`);
  `oax_events_ingested_total{source}` uses the event source `name`
  (`apps/api/src/services/ingest.ts`). The model proxy already does it right
  (`provider` = family or kind, comment "never a tenant-chosen connection name").
- **The trusted fact path.** Every step of a run goes through `ControlPlaneService.recordStep`
  (`apps/api/src/services/control-plane.ts`): the in-process executor
  (`packages/runners/src/executor.ts`) calls it for model calls, tool calls, policy decisions,
  approvals, control decisions, guard reports and outputs; run nodes report only `tool_call`,
  `output`, `error` and guard counts over `POST /v1/worker/runs/:id/steps`, sanitised by
  `sanitizeNodeStep` (64 KiB cap, numbers dropped); model calls of nodes are recorded by the model
  proxy from its own measurement; gate decisions of nodes are made on the control node
  (`POST /v1/worker/runs/:id/gate` -> `decide`). Each fact becomes an audit entry
  (`AuditService.append`, hash chain over `payloadDigest`).
- **Redaction building blocks.** `ContextGuard` (`packages/core/src/context-guard.ts`) strips
  invisible steering Unicode and replaces known secret values and token shapes, reporting counts
  and kinds only; `redact()` (`packages/core/src/redact.ts`) for audit payloads; the run node
  broker values are scrubbed (`nodes.scrub`). ADR 0012 section 7.3 (PII redactor chain),
  7.2 (retention per tenant) and 7.7 (`operatorAccess: metadata`) are **not implemented** yet.
- **Identifiers.** Agent definition `name` and step `id` are slugs (`^[a-z][a-z0-9-]{0,62}$`,
  `packages/core/src/agents/schema.ts`); `labels.useCase` is free text up to 200 characters;
  tenant ids are UUIDs; tenant names and slugs are user-chosen.
- **Helm** (`open-agentix-helm`, `charts/open-agentix/values.yaml`): `observability.otel.endpoint`
  (empty = off), `observability.metrics`, `serviceMonitor`, `prometheusRule`, and a NetworkPolicy
  egress list for the OTLP collector.

The competitive landscape (task "idea 3") puts OpenTelemetry spans per step, model call and tool
call following the GenAI conventions, with the policy decision and cost as attributes, at P1: it
makes the platform usable in existing monitoring stacks (Tempo, Jaeger, Langfuse, Phoenix,
Grafana) without a proprietary integration.

## Decision

The control plane emits one trace per run, built **only from control-plane facts**, named and
attributed after the OpenTelemetry GenAI semantic conventions where a convention exists and with
`oax.*` attributes where it does not. Telemetry is **metadata only**: no prompt, response, tool
argument or tool result is exported by default, and the opt-in for content is a separate,
owner-gated decision (section 5.4). Untrusted run nodes never create spans; what they report
becomes bounded span events on spans the control plane owns. The exporter is off unless
configured, goes through the ADR 0011 outbound dispatcher, and is subject to air-gapped mode like
every other egress. The audit chain stays the source of truth; traces are an operational view
that references it.

### 1. Convention version

- The GenAI conventions moved from `open-telemetry/semantic-conventions` into the separate
  repository `open-telemetry/semantic-conventions-genai`. Every GenAI document there has status
  **Development** (experimental): names, attributes and span shapes may still change.
- This ADR is written against commit `6fd0d76` of `semantic-conventions-genai` (2026-10-09),
  which references the core conventions **v1.44.0** for shared attributes (`error.type`,
  `server.*`). Documents used: `client-inference.md`, `gen-ai-spans.md` (execute tool),
  `gen-ai-agent-spans.md` (invoke agent, invoke workflow), `gen-ai-metrics.md`,
  `gen-ai-token-metrics.md`, `mcp.md`.
- Consequences of the pin: `gen_ai.provider.name` (not the older `gen_ai.system`); token metrics
  are the counters `gen_ai.client.inference.usage.*` (older histogram names are not emitted);
  inference duration is `gen_ai.client.inference.duration`.
- The pin lives in one constant (`GENAI_SEMCONV_PIN`, slice S1) and is documented in
  `docs/observability.md`. Following an upstream change is a deliberate PR with updated golden
  tests and a `Changed` changelog entry (dashboards may break). There is no dual emission of old
  and new names.

### 2. Trace identity and the run trace

- **One trace per run.** `runs.trace_id` (16 random bytes, hex) and `runs.trace_root_span_id`
  (8 bytes) are written when the run row is created (`RunsService`), on the control plane, from
  a CSPRNG. The trace id is **not** derived from the run id and not taken from any inbound
  header. Old runs keep `NULL` (no trace).
- **Admission span.** Run creation emits a short span `oax.run.admit` (INTERNAL) whose span id is
  the stored `trace_root_span_id`; the ingest or API request span, if any, is linked, not parent.
- **Attempt spans.** Each worker attempt (lease) starts `invoke_workflow {name}` as a child of the
  stored context (a remote `SpanContext` built from the two columns). A retried run after a
  worker crash is therefore one trace with several attempt spans; a lost attempt only loses its
  own unexported spans.
- **Inbound context is not trusted.** A `traceparent` on a webhook, on the public API or on any
  worker route is ignored for parenting. `OAX_OTEL_INBOUND_CONTEXT=link` records it as a span
  **link** on the HTTP server span (default `ignore`), so an external caller cannot place spans
  into a platform trace or choose its trace id.

### 3. Span model

#### 3.1 Tree

```text
oax.run.admit                                    (api or worker, at run creation)
invoke_workflow {definition.name}                (worker, one per attempt; parent = stored root)
 ├─ oax.handover {step.id}                       (condition + input validation, ADR 0008)
 ├─ invoke_agent {step.id}                       (one per pipeline step)
 │   ├─ chat {model}                             (in-process provider call, CLIENT)
 │   ├─ oax.policy.check {server}/{tool}         (gate decision)
 │   ├─ oax.approval.wait {server}/{tool}        (only when require_approval)
 │   └─ execute_tool {tool}                      (in-process MCP gateway call)
 └─ invoke_agent {step.id}  [isolated step]      (worker: dispatch to a run node)
     ├─ oax.node.session                         (api: node session lifetime, owns node events)
     ├─ chat {model}                             (api: model proxy, from its own measurement)
     └─ oax.policy.check {server}/{tool}         (api: gate route for the node)
```

Control-agent decisions (`pause`, `kill`), guard reports, budget breaches, output validation
results and handover retries are **span events** on the enclosing `invoke_agent` span, not
spans. The API additionally gets an HTTP server span per request (route pattern only), created
by a Fastify hook, not by `@opentelemetry/instrumentation-http` (see 6.3).

#### 3.2 Span table

| Span name | Kind | Where | `gen_ai.operation.name` | Key attributes (all bounded, see 4) |
| --- | --- | --- | --- | --- |
| `oax.run.admit` | INTERNAL | api/worker | – | `oax.run.id`, `oax.trigger.kind`, `oax.admission.result` |
| `invoke_workflow {name}` | INTERNAL | worker | `invoke_workflow` | `gen_ai.workflow.name` (definition `name`), `oax.agent.version`, `oax.run.attempt`, `oax.run.status`, run totals `gen_ai.usage.input_tokens`/`output_tokens`, `oax.cost.micro_usd`, `oax.classification` |
| `oax.handover {step}` | INTERNAL | worker | – | `oax.step.id`, `oax.handover.explicit`, `oax.handover.result` (`ok`/`skipped`/`invalid`), `oax.schema.digest` |
| `invoke_agent {step}` | INTERNAL | worker | `invoke_agent` | `gen_ai.agent.name` (step id), `gen_ai.agent.id` (`{definition}/{step}`), `gen_ai.agent.version`, `gen_ai.request.model`, `gen_ai.provider.name`, `oax.runner.kind`, step token and cost totals |
| `chat {model}` | CLIENT | worker or api (proxy) | `chat` | `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.request.max_tokens`, `gen_ai.request.temperature`, `gen_ai.response.finish_reasons`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_write.input_tokens`, `gen_ai.response.time_to_first_chunk` (streams), `oax.cost.micro_usd`, `oax.cost.priced`, `oax.usage.source` (`provider`/`estimate`/`floor`), `oax.model.via` (`in-process`/`proxy`), `oax.reservation.result`, `error.type` |
| `oax.policy.check {server}/{tool}` | INTERNAL | worker or api | – | `gen_ai.tool.name`, `oax.mcp.server`, `oax.policy.effect` (`allow`/`deny`/`require_approval`), `oax.policy.reason_codes` (code list, max 8), `oax.policy.bundle_digests` |
| `oax.approval.wait {server}/{tool}` | INTERNAL | worker | – | `oax.approval.outcome` (`approved`/`rejected`/`timeout`/`cancelled`), `oax.approval.id` |
| `execute_tool {tool}` | INTERNAL | worker | `execute_tool` | `gen_ai.tool.name`, `gen_ai.tool.type` = `extension`, `gen_ai.tool.call.id` (provider-issued id, see 4.3), `oax.mcp.server`, `oax.tool.result_bytes`, `oax.tool.truncated`, `oax.tool.is_error`, `oax.cost.micro_usd`, `error.type` |
| `oax.node.session` | INTERNAL | api | – | `oax.node.runner` (`container`/`kubernetes-job`), `oax.node.harness`, `oax.node.revoke_reason`, `oax.node.events_dropped` |
| HTTP server span `{method} {route}` | SERVER | api | – | `http.request.method`, `http.route` (pattern), `http.response.status_code`, `oax.access` (`user`/`run-token`/`model-token`/`public`) |

Every span of a run carries `oax.run.id`, `oax.tenant.id` and `oax.tenant.root_id` (section 7).
`gen_ai.conversation.id` is **not** set: the conventions forbid a trace id or generated UUID as a
fallback, and runs have no conversation identifier.

#### 3.3 Model calls through the model proxy (amends ADR 0009 section 12)

The proxy creates `chat {model}` (CLIENT) on the api, as a child of the `invoke_agent` context
stored on the node session (section 6.1), after settlement, from the proxy's own numbers
(`usageSource`, reservation, cost). `oax.model.call` and `gen_ai.system` are dropped from ADR 0009.
Pass-through surfaces (Anthropic/OpenAI wire for harnesses) produce the same span with
`oax.model.surface`. Model refusals of the proxy (`model_not_allowed`, `classification_denied`,
`egress_denied`, budget codes) end the span with status ERROR and `error.type` = the code.

#### 3.4 `gen_ai.provider.name` mapping

From the adapter **kind / family**, never the instance name: `anthropic` -> `anthropic`,
`bedrock` -> `aws.bedrock`, `azure-openai` -> `azure.ai.openai`, `openai` (api.openai.com) ->
`openai`, `openrouter`, `ollama`, `lmstudio`, `vllm`, `simulated` -> the kind as a custom value.
The instance (connection) name goes to `oax.provider.instance` on spans only (truncated, 63
chars), never into a metric label or span name.

#### 3.5 Errors

- Status ERROR with `error.type` = the platform's error code (`OaxError.code`, the model proxy
  code, the HTTP status class) or `_OTHER`. The status description is the **code**, never the
  exception message.
- `span.recordException` is not used with raw exceptions. An exception event carries
  `exception.type` (class name) only; no `exception.message`, no `exception.stacktrace` unless
  `OAX_OTEL_EXCEPTION_DETAIL=guarded` (default `off`), which passes the message through the
  `ContextGuard` and caps it at 256 characters. Slice S1 fixes `withSpan` accordingly.

### 4. What is recorded

#### 4.1 By default (metadata)

Names and versions (definition, step, model, provider family, tool and MCP server name from the
published definition), token counts by kind, cost in micro-USD and the `priced` flag, latency
(span duration, time to first chunk), finish reasons, policy effect and reason **codes**, bundle
digests, approval outcome, control-agent rule names, guard report counts and kinds (the
`auditShapeOfReport` shape), classification level, runner kind, handover result and schema
digest, result sizes and truncation flags, error codes.

#### 4.2 Never by default

- Prompts, system instructions, messages, model responses (`gen_ai.input.messages`,
  `gen_ai.output.messages`, `gen_ai.system_instructions`).
- Tool definitions with descriptions (`gen_ai.tool.definitions`, `gen_ai.tool.description`):
  descriptions come from MCP servers and are untrusted text.
- **Tool arguments and tool results** (`gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`):
  never by default, and not part of the first content opt-in either (5.4).
- Event payloads, handover values, output values, approval comments, policy reason **messages**
  (they quote arguments), exception messages, HTTP bodies, query strings, headers.
- Secrets of any kind (resolved references, brokered credentials, run and model tokens, exporter
  headers), user e-mail addresses and names, tenant names and slugs, IP addresses of callers,
  provider endpoint hosts of BYOK connections (`server.address` only for platform providers).

#### 4.3 Attribute allowlist

All attributes go through one pure module (`packages/core/src/telemetry/attributes.ts`, slice
S1): a closed allowlist of keys with a type, a maximum length (string 128 unless stated), an
enum where the value set is fixed, and a sanitizer (control characters and invisible Unicode
removed, `ContextGuard.text` for every free-text value). A key that is not on the list is dropped
and counted (`oax_otel_attributes_dropped_total{key_class}`), so a future code path cannot leak a
new field by accident. `gen_ai.tool.call.id` is provider-issued and model-influenced: it is kept
only when it matches `^[A-Za-z0-9_-]{1,64}$`.

### 5. Redaction and content

#### 5.1 ContextGuard on every free-text attribute

Even metadata contains model- or tenant-influenced text (tool names chosen by an MCP server,
`useCase` labels, model names of BYOK connections). The allowlist module runs every string value
through the run's `ContextGuard` (known secret values of the run plus token shapes) before it
reaches a span; a replacement sets `oax.redacted=true` on the span and increments
`oax_otel_redactions_total{kind}`.

#### 5.2 Use case and tenant labels

`labels.useCase` (free text, 200 chars) goes onto `invoke_workflow` only, as `oax.use_case`, after
the guard and truncated to 64 characters; never into span names or metric labels. Tenant names
and slugs are never exported; the tenant is identified by its UUID.

#### 5.3 Relationship to ADR 0012

Telemetry follows the stricter of the tenant's settings: with ADR 0012 retention and
`operatorAccess: metadata` (when implemented), telemetry stays metadata only regardless of
platform configuration. The record of processing (ADR 0012 section 7.5) lists the OTLP
collector as a platform sub-processor when an exporter is configured.

#### 5.4 Content capture (not in the first slices)

Content capture is a separate, owner-gated slice (S10). Its proposed shape, for the owner
decision only:

- `OAX_OTEL_CONTENT=off` (only accepted value until S10; anything else refuses to start).
- S10 adds `redacted`: model input and output messages (not tool arguments or results), through
  the `ContextGuard` and the ADR 0012 PII redactor, 8 KiB per attribute, only for runs whose
  classification is at most the exporter's declared `clearance` (default `internal`), only when
  the operator allows it **and** the tenant opts in, and only to an exporter that serves this
  tenant alone (tenant-owned exporter, 7.3) or in single-tenant setup mode (ADR 0013), never to a
  shared platform collector in multi-tenant mode. Each opt-in is audited
  (`telemetry.content_enabled`).

### 6. Propagation

#### 6.1 Into run nodes and harness containers

- At dispatch the worker writes the `invoke_agent` span context (trace id, span id, flags) onto
  the node session row (`run_node_sessions.trace_context`, new column). Every span the api creates
  for that session (model proxy `chat`, gate `oax.policy.check`, `oax.node.session`) uses this
  **stored** context as parent.
- The node receives `TRACEPARENT` in its environment for **log correlation only** (its JSON logs
  carry `trace_id`, `span_id`); it has no route to a collector, no OTel SDK, and harness
  telemetry stays disabled (`DISABLE_TELEMETRY=1` is already set by `harness.ts`; the harness
  adapters also keep the CLI's own OTel exporter variables unset).
- A `traceparent` header sent by a node on worker or model-proxy routes is **ignored**; a value
  that does not match the session's stored trace id increments
  `oax_otel_node_context_mismatch_total` (a cheap signal for a tampered node), nothing else.
- The control node never forwards trace context to model providers (ADR 0009 boundary B2:
  upstream headers are built from configuration only).

#### 6.2 Node-reported facts become bounded events

A node can lie about what it did. Therefore:

- No span is created from a node report, and no node-supplied timestamp or duration becomes a
  span time. Accepted reports (`tool_call`, `output`, `error`, guard counts, after
  `sanitizeNodeStep`) become **span events** on `oax.node.session`, named `oax.node.tool_call`,
  `oax.node.output`, `oax.node.error`, `oax.node.guard`, timestamped at receipt, with
  `oax.claim=node`, the tool name only if it was granted to the step, a status enum and the
  node-claimed duration as an attribute (`oax.claimed.duration_ms`, capped).
- Bounds per session: `OAX_OTEL_NODE_EVENTS_MAX` (default 128) events; further reports are
  counted in `oax.node.events_dropped` and `oax_otel_node_events_dropped_total`. The OTel span
  event limit is set to the same value. The existing 64 KiB step cap and run-token rate limits
  still apply.
- The authoritative records of an isolated step are server-side spans: the gate decision for
  every tool call the node attempted (`oax.policy.check`, created by `decide`) and every model
  call (`chat`, created by the proxy). A node that hides a tool call cannot hide the gate check
  that the in-node gate bridge must pass.

#### 6.3 No automatic HTTP instrumentation

`@opentelemetry/instrumentation-http` and auto-instrumentation packages are not used: they would
inject `traceparent` into every outbound request (providers, MCP servers, OIDC, webhooks) and
create spans with full URLs. HTTP server spans come from a Fastify hook with the route pattern;
outbound spans exist only where this ADR names them.

#### 6.4 MCP calls

- Per the MCP conventions, context goes into `params._meta.traceparent` (not HTTP headers),
  unprefixed, per SEP-414.
- **Default off.** A connection opts in with `telemetry.propagate: true` (MCP instance setting,
  tenant admin for tenant connections, operator for platform connections), and
  `OAX_OTEL_MCP_PROPAGATION=allow` must be set on the platform (default `deny`). Only `traceparent`
  is sent, never `tracestate` or `baggage` (baggage could carry tenant data). A remote MCP server's
  own spans are its business; the platform never ingests them.
- With propagation on, MCP-specific attributes (`mcp.method.name`, `mcp.session.id` omitted,
  `mcp.protocol.version`) are added to the existing `execute_tool` span instead of a separate MCP
  client span, as the MCP conventions allow when an outer GenAI span exists.

### 7. Multi-tenancy

#### 7.1 Attributes, not resources

Resource attributes describe the process (`service.name`, `service.version`,
`service.instance.id`, `deployment.environment.name` from static configuration). A shared api or
worker process serves many tenants, so tenant identity cannot be a resource attribute of the
platform's own SDK. Every span carries the span attributes `oax.tenant.id` and
`oax.tenant.root_id` (the organisation of ADR 0013), both UUIDs.

#### 7.2 Shared collectors

`docs/observability.md` ships reviewed collector configurations that turn the span attribute into
a resource attribute and route per tenant: `groupbyattrs` on `oax.tenant.id`, then the `routing`
connector into per-tenant pipelines or backends (or Tempo/Loki tenant headers via
`X-Scope-OrgID`). The guidance is explicit: a collector or backend shared by several tenants'
users must enforce the tenant split itself; the platform guarantees that every span is tagged and
that no span mixes tenants (golden test: every span of a run has the run's tenant, the api never
batches spans of different tenants into one span).

#### 7.3 Tenant-owned exporters (owner question)

Per-tenant export routing in the platform (a tenant configures its own OTLP endpoint as an ADR
0012 connection of a new type `telemetry`, exported through the dispatcher with tenant scope,
clearance and region checks) is **not** part of the first slices. It is a new tenant-controlled
egress channel (exfiltration path, SSRF surface) and needs its own review (slice S10, together
with content capture).

#### 7.4 Metrics

Metric labels never contain tenant ids, tenant names, connection names, event source names,
agent names, use cases, run ids or model names chosen by tenants (unchanged rule of ADR 0009
section 12, now general). Per-tenant numbers come from the cost and run APIs, not from Prometheus.

### 8. Exporters and egress

- **Off unless configured.** No exporter, no SDK provider registration and no socket when
  `OTEL_EXPORTER_OTLP_ENDPOINT` is unset; spans then go to the no-op tracer and the trace ids in
  `runs` and audit payloads are still written (they cost nothing).
- **Protocols.** `OTEL_EXPORTER_OTLP_PROTOCOL`: `http/protobuf` (new default), `http/json`
  (today's behaviour). `grpc` is an owner question (adds `@grpc/grpc-js` and its proxy handling).
- **Through the outbound dispatcher.** The exporter's HTTP transport is built from
  `OutboundDispatcher.nodeAgents(url, { purpose: 'telemetry' })` (ADR 0011): routes, trust
  bundles, client certificates (mTLS) and proxies are configured in the network file like for any
  other purpose; TLS verification is always on. If the pinned exporter version cannot take an
  agent, S7 replaces its transport with a minimal sender that posts the serialised payload through
  `dispatcher.fetch` (no other change).
- **TLS rules.** `http://` is accepted only for loopback or when `OAX_OTEL_INSECURE=true`
  (in-cluster collector without TLS); production start refuses plain HTTP otherwise.
- **Credentials.** Exporter headers (for example a backend API key) come from
  `OAX_OTEL_HEADERS_SECRET`, a secret **reference** resolved through the secret resolver, never
  logged. The standard `OTEL_EXPORTER_OTLP_HEADERS`, `_CERTIFICATE`, `_CLIENT_CERTIFICATE`,
  `_CLIENT_KEY` (and their `_TRACES_` variants) refuse start-up with a message naming the
  replacement, so there is exactly one configuration path.
- **No resource detectors.** No cloud, container or host detectors (they call metadata endpoints
  such as `169.254.169.254` and read host details); resource attributes are static.
- **Air-gapped mode.** Unchanged fail-closed rule: the endpoint must be on `OAX_AIRGAPPED_ALLOW`
  or start-up fails (`airgap_violation`, already implemented); the dispatcher's air-gapped check
  and the network guard apply on top. Only internal collectors can be configured. Test: zero
  egress attempts (section 12).
- **Never blocking.** `BatchSpanProcessor` with `maxQueueSize` `OAX_OTEL_MAX_QUEUE` (default 2048),
  export timeout `OAX_OTEL_EXPORT_TIMEOUT_MS` (default 10 000); a full queue drops spans and counts
  them (`oax_otel_spans_dropped_total`), export failures count in
  `oax_otel_export_failures_total{reason}` and are logged at most once a minute. A down collector
  never slows or fails a run. Shutdown flushes with a 5 s bound.

### 9. Sampling

- Default `OAX_OTEL_SAMPLE_RATIO=1.0`: a run produces tens of spans; volume is driven by run
  count, not traffic, and complete traces are the point.
- With a ratio below 1, the decision is a deterministic function of the run's trace id
  (`TraceIdRatioBased`), so api and worker agree without coordination.
- **Always keep** (`OAX_OTEL_KEEP`, default `error,deny,approval,budget,guard`): a non-sampled
  run's spans are recorded but not exported, buffered per run attempt by an `OaxKeepProcessor`
  (bounded: `OAX_OTEL_KEEP_BUFFER_SPANS` default 512 per run, 4 MiB per process, oldest runs
  evicted and counted); if any span of the attempt ends with status ERROR, a policy `deny`, an
  approval that is not `approved`, a budget breach or a non-empty guard report, the buffer is
  exported. Each process decides on what it saw, so a kept trace can lack the other process's
  spans; complete error traces at lower ratios are a job for collector tail sampling
  (`tail_sampling` processor policies for status ERROR and `oax.policy.effect=deny`, shipped as a
  documented config).

### 10. Metrics

#### 10.1 `oax_` metrics (stable contract, Prometheus `/metrics`)

| Metric | Type | Labels (closed sets) |
| --- | --- | --- |
| `oax_run_duration_seconds` | histogram | `status`, `trigger` (kind) |
| `oax_step_duration_seconds` | histogram | `runner` (kind), `status` |
| `oax_tool_calls_total` | counter | `decision` (`allow`/`deny`/`require_approval`), `result` (`ok`/`error`/`not_executed`) |
| `oax_approvals_total` | counter | `outcome` (`approved`/`rejected`/`timeout`/`cancelled`) |
| `oax_approval_wait_seconds` | histogram | `outcome` |
| `oax_tokens_total` | counter | `direction` (`input`/`output`/`cache_read`/`cache_write`), `provider` (family), `via` (`in-process`/`proxy`) |
| `oax_budget_exhausted_total` | counter | `scope` (`run`/`step`/`team`/`use_case`/`tenant`), `limit` (`tokens`/`usd`/`steps`/`tool_calls`/`timeout`) |
| `oax_guard_replacements_total` | counter | `source` (`input`/`tool_result`/`tool_error`), `class` (`secret`/`invisible`) |
| `oax_node_reports_total` | counter | `kind`, `result` (`accepted`/`refused`/`dropped`) |
| `oax_otel_spans_dropped_total`, `oax_otel_export_failures_total{reason}`, `oax_otel_attributes_dropped_total{key_class}`, `oax_otel_redactions_total{kind}`, `oax_otel_node_events_dropped_total`, `oax_otel_node_context_mismatch_total` | counter | as named |

Label fixes (pre-1.0 breaking change, changelog "Breaking"): `oax_cost_micro_usd_total{provider}`
uses the provider family instead of the instance name; `oax_events_ingested_total{source}`
becomes `{kind}` (webhook, kafka, mail, cron). `oax_model_proxy_tokens_total` stays and
`oax_tokens_total{via="proxy"}` counts the same tokens for one dashboard across both paths.

#### 10.2 GenAI metrics (opt-in)

`OAX_OTEL_GENAI_METRICS=true` (default `false`, because the names are experimental) exposes, in
Prometheus naming (dots to underscores, unit suffix, `_total` on counters):
`gen_ai.client.inference.duration`, `gen_ai.client.inference.usage.input_tokens`,
`gen_ai.client.inference.usage.output_tokens`, `gen_ai.client.inference.usage.cache_read.input_tokens`,
`gen_ai.client.inference.usage.cache_write.input_tokens`, `gen_ai.execute_tool.duration`,
`gen_ai.invoke_agent.duration`, `gen_ai.invoke_workflow.duration`. Labels: `gen_ai.operation.name`,
`gen_ai.provider.name` (family), `gen_ai.request.model` **only** if the model is in the vendored
catalog snapshot, else `_OTHER`; `error.type` (closed code list). No tenant or agent labels.
OTLP metric export is not added: metrics stay pull-based (`/metrics`, ServiceMonitor).

### 11. Relationship to the audit chain

- The audit chain (ADR 0002) is the **source of truth** for what happened; billing, budgets,
  compliance evidence and incident reconstruction use the database and the audit chain, never a
  trace backend. Traces may be sampled, dropped, delayed or deleted by the collector.
- Every audit entry with a `runId` gets `payload.otel = { traceId, spanId }`: the run's trace id
  and, when one exists, the span that documents the same fact (`policy.decision` -> the
  `oax.policy.check` span, `step.model_call` -> `chat`). The values are server-generated, part of
  the hashed payload, and present even when the trace was not sampled or no exporter is
  configured (they cost nothing).
- The reverse link is the span attribute `oax.audit.seq` on spans that document an audit entry,
  set after `append` returns.
- `GET /v1/runs/{id}` returns `traceId` (for "open in Tempo/Jaeger" links configured by
  `OAX_OTEL_TRACE_URL_TEMPLATE`, e.g. `https://tempo.internal/trace/{traceId}`).

### 12. Test plan

| Suite | What it proves |
| --- | --- |
| Span-shape golden tests | In-memory exporter, ids and times normalised, one JSON tree per scenario: simple run, tool allowed, tool denied, approval approved/rejected/timeout, budget kill, handover invalid with retry, isolated step through the model proxy, harness step, worker crash and second attempt. Names, kinds, parent links and attribute **keys** must match the golden file; a semconv bump updates them in one reviewed diff. |
| Redaction tests | Canary values (a known secret, a token-shaped string, an e-mail, invisible Unicode, a marker string) are placed in the event payload, prompt, model response, tool arguments, tool result, tool error, provider error body, MCP tool description, `useCase` and BYOK connection name; asserts that **no** exported attribute, event, status, link or resource value contains a canary (property test over the whole export), and that the allowlist drops unknown keys. |
| Cardinality tests | 1 000 runs over 50 tenants with random names, sources, connections, use cases and models: the number of Prometheus series stays constant; every label value belongs to its closed set; every span attribute key is on the allowlist; every string respects its length cap; span names come from slugs or fixed strings only. |
| Node threat tests | A node sends a forged `traceparent` (ignored, mismatch counter), floods 10 000 `tool_call` reports (events capped, counter), reports a tool it was not granted (no tool name exported), claims a 10-day duration (attribute capped, span times unaffected), reports a model call (still refused). |
| Exporter failure tests | Collector down, slow, returning 500, or TLS mismatch: runs succeed with unchanged latency budget, drop and failure counters move, logs rate-limited, shutdown bounded. |
| Air-gap tests | `OAX_AIRGAPPED=true` and no endpoint: a full scenario run, then `blockedAttempts == 0` and no socket opened by the SDK; endpoint not allowlisted: start refused; allowlisted fake internal collector: the only host contacted; no metadata-endpoint access (no detectors). |
| Egress tests | Exporter honours an ADR 0011 route with a proxy, a trust bundle and a client certificate (mTLS) for purpose `telemetry`; `http://` to a non-loopback host refused without `OAX_OTEL_INSECURE`; standard `OTEL_EXPORTER_OTLP_HEADERS` refused at start. |
| MCP propagation tests | Default: no `_meta.traceparent`; with both opt-ins: only `traceparent`, never `tracestate`/`baggage`; platform `deny` overrides a tenant opt-in. |
| Audit link tests | `audit verify` passes; every run-bound entry has `payload.otel.traceId` equal to `runs.trace_id`; exported spans carry the matching `oax.audit.seq`. |
| Performance | Bench with the exporter on against a local fake collector (section 13). |

### 13. Performance budget

- Span creation and attribute sanitising: at most 30 µs CPU per span (median, measured in a
  micro-benchmark); at most 1 ms added p95 per model or tool call.
- `scripts/bench.mjs --otel` (S5): API read p95 and ingest p95 targets of `docs/performance.md`
  unchanged (< 50 ms, < 30 ms) with the exporter on; executor CPU per simulated run at most 3 %
  higher than with the exporter off; numbers recorded in `docs/performance-baseline.json`.
- Memory: export queue 2048 spans (about 2 MiB), keep-buffer 4 MiB per process, node events 128
  per session. Nothing grows with tenant count.
- No synchronous I/O on the run path; the span context lookup for node sessions reuses the session
  row the proxy and gate already load (no extra query).

### 14. Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | – | Collector base URL; unset = no export (existing). |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | `http/protobuf`, `http/json` (`grpc` per owner decision). |
| `OTEL_SERVICE_NAME` | `openagentix-api` / `openagentix-worker` | Existing. |
| `OAX_OTEL_RESOURCE_ATTRIBUTES` | – | Static `key=value` list, validated (no `oax.tenant.*`, no secrets). |
| `OAX_OTEL_HEADERS_SECRET` | – | Secret reference holding exporter headers. |
| `OAX_OTEL_INSECURE` | `false` | Allow `http://` to a non-loopback collector. |
| `OAX_OTEL_SAMPLE_RATIO` | `1.0` | Head sampling ratio by run trace id. |
| `OAX_OTEL_KEEP` | `error,deny,approval,budget,guard` | Always-export classes below ratio 1. |
| `OAX_OTEL_KEEP_BUFFER_SPANS` | `512` | Per-run buffer of the keep processor. |
| `OAX_OTEL_MAX_QUEUE` | `2048` | Export queue size (drops beyond). |
| `OAX_OTEL_EXPORT_TIMEOUT_MS` | `10000` | Export timeout. |
| `OAX_OTEL_NODE_EVENTS_MAX` | `128` | Node-reported events per session. |
| `OAX_OTEL_INBOUND_CONTEXT` | `ignore` | `ignore` or `link` for inbound `traceparent`. |
| `OAX_OTEL_MCP_PROPAGATION` | `deny` | `allow` lets MCP instances opt in. |
| `OAX_OTEL_EXCEPTION_DETAIL` | `off` | `guarded`: guarded, capped exception messages. |
| `OAX_OTEL_CONTENT` | `off` | Only `off` until slice S10. |
| `OAX_OTEL_GENAI_METRICS` | `false` | Expose GenAI metrics on `/metrics`. |
| `OAX_OTEL_TRACE_URL_TEMPLATE` | – | Link template for the run view (`{traceId}`). |

Helm (mirrored as an issue in `open-agentix-helm` by slice S9): `observability.otel.{endpoint,
protocol, insecure, headersSecret.{name,key}, sampleRatio, keep, inboundContext, mcpPropagation,
genaiMetrics, traceUrlTemplate, resourceAttributes}`; the existing NetworkPolicy egress list for
the collector stays; the chart fails rendering when `airgapped.enabled` and the endpoint host is
not covered by the air-gapped allowlist values; the values-airgapped example leaves the endpoint
empty.

### 15. Threat model

```text
 untrusted                       |  trusted (control plane)                 |  external
 run node / harness  --reports-->|  api: worker routes, model proxy, gate   |
 tenant users (agents.md, BYOK,  |  worker: executor, dispatcher            |--OTLP--> collector
   webhooks, MCP descriptions)   |  attribute allowlist + ContextGuard      |   (operator's)
 MCP servers, model providers    |  audit chain (source of truth)           |
```

| # | Threat | Actor | Decision (section) |
| --- | --- | --- | --- |
| T1 | A node forges spans or parents spans into other traces | compromised node | Nodes have no exporter route; server creates every span; node `traceparent` ignored (6.1, 6.2) |
| T2 | A node floods telemetry to exhaust collector or memory | compromised node | Bounded events per session, counters, existing step caps and rate limits (6.2) |
| T3 | A node hides a tool call | compromised node | Gate decisions and model calls are server-side spans; node events are claims (6.2) |
| T4 | External caller injects trace context | webhook/API caller | Inbound context ignored or only linked (2) |
| T5 | Prompt, tool data or secrets leak to the collector | prompt injection, operator | Metadata only, allowlist, ContextGuard on free text, no exception messages (3.5, 4, 5) |
| T6 | Cross-tenant exposure in a shared collector | other tenant, operator | Tenant UUID on every span, no tenant names, documented per-tenant routing, no content in shared mode (5.4, 7) |
| T7 | Cardinality explosion / tenant names in Prometheus | tenant users | Closed label sets, label fixes for cost and events, cardinality tests (7.4, 10) |
| T8 | Air-gap bypass through the exporter or SDK detectors | operator misconfig | Allowlist check at start, dispatcher, network guard, no detectors, zero-egress test (8, 12) |
| T9 | Collector credentials leak | operator, logs | Secret reference only, standard header variables refused (8) |
| T10 | Trace context leaks to third parties (correlation) | MCP server, provider | No propagation to providers; MCP opt-in twice, no baggage (6.1, 6.4) |
| T11 | Telemetry outage degrades runs | collector down | Async bounded export, never blocking, drop counters (8) |
| T12 | Traces treated as evidence and tampered | operator, attacker on collector | Audit chain stays authoritative; traces reference it (11) |
| T13 | Experimental convention changes silently break dashboards | upstream | Pinned commit, golden tests, deliberate bumps (1) |

Not prevented: the operator of the collector sees metadata of all tenants exported to it (agent
names, models, costs, tool names). That is the same metadata ADR 0012 `operatorAccess: metadata`
grants the operator in the console.

### 16. Implementation slices

Each slice is one PR for a Sonnet agent; the security-review points are checked by the reviewer
(Opus) before merge. Every slice adds its tests to section 12, keeps `pnpm test` and the OpenAPI
drift check green, and adds its `[Unreleased]` changelog line.

| # | Slice | Content | Depends on | Security review |
| --- | --- | --- | --- | --- |
| S1 | Telemetry core hardening | `GENAI_SEMCONV_PIN`; attribute allowlist module with sanitizers and ContextGuard; `withSpan` without raw messages (`error.type`, code as description); no detectors; `http/protobuf` default; `OAX_OTEL_HEADERS_SECRET`, refusal of standard header/cert variables, plaintext rule; bounded queue and `oax_otel_*` counters; trace and span id in pino logs; config keys of section 14 (parsing only); `docs/observability.md` skeleton | – | yes: no message or stack leaves the process; allowlist complete; secrets never logged |
| S2 | Run trace identity and audit links | migration (`runs.trace_id`, `runs.trace_root_span_id`, `run_node_sessions.trace_context`); generation at run creation; `oax.run.admit`; attempt span `invoke_workflow` parented from the stored context (replaces `oax.run`); `payload.otel` on run-bound audit entries and `oax.audit.seq`; `traceId` in `GET /v1/runs/{id}`; inbound context `ignore`/`link`; HTTP server spans by hook | S1 | yes: trace ids from CSPRNG only; inbound context never parents; audit verify unchanged |
| S3 | Executor spans (in-process) | `oax.handover`, `invoke_agent`, `chat`, `oax.policy.check`, `oax.approval.wait`, `execute_tool`, control/guard/budget events; provider family mapping; span-shape golden tests for in-process scenarios; redaction canary suite | S2 | yes: canary suite over all exported data; tool arguments/results never exported |
| S4 | Control-node spans for isolated steps | stored session context at dispatch; model proxy `chat` (amends ADR 0009 section 12); gate `oax.policy.check` for nodes; `oax.node.session` with bounded node events; `TRACEPARENT` env for node log correlation; mismatch counter; golden tests for isolated and harness steps; node threat tests | S2, S3 | yes: no span from node data; caps; forged context ignored |
| S5 | Metrics completion and label fixes | metrics of 10.1; label fixes for `oax_cost_micro_usd_total` and `oax_events_ingested_total` (Breaking); opt-in GenAI metrics (10.2) with catalog-bounded model label; cardinality tests; `scripts/bench.mjs --otel`; Grafana dashboard JSON | S3 | yes: no tenant-chosen label value anywhere (cardinality suite) |
| S6 | Sampling | ratio sampler by run trace id; `OaxKeepProcessor` with bounds and eviction counters; collector tail-sampling example | S3, S4 | no (performance review: memory bounds) |
| S7 | Exporter through the outbound dispatcher | transport via `nodeAgents`/`fetch` for purpose `telemetry` (routes, trust bundles, mTLS); air-gap zero-egress and egress tests; `grpc` only if the owner decides so | S1 | yes: TLS always verified; air-gap zero egress proven |
| S8 | MCP context propagation (opt-in) | `telemetry.propagate` on MCP instances, `OAX_OTEL_MCP_PROPAGATION`; `params._meta.traceparent` only; MCP attributes on `execute_tool`; tests | S3 | yes: default off; no baggage/tracestate; platform deny wins |
| S9 | Docs, collector configs, compatibility | full `docs/observability.md` (span reference, attribute table, what is never exported, sampling, multi-tenant collector configs with `groupbyattrs` + `routing`, tail sampling), examples for Grafana Tempo, Jaeger, Langfuse and Arize Phoenix (docs only), `docs/configuration.md` and `docs/airgapped.md` updates, Helm mirror issue | S5, S7 | no |
| S10 | Content capture and tenant-owned exporters (gated) | only after the owner decides the questions below: `OAX_OTEL_CONTENT=redacted`, tenant opt-in, connection type `telemetry`, clearance/region checks, audited opt-ins | S9 + owner decision | yes: full review, new egress channel |

### 17. Compatibility with tools (documentation only)

No vendor SDK is added; everything is plain OTLP.

- **Grafana Tempo** and **Jaeger**: OTLP directly or via a collector; TraceQL/Jaeger search by
  `oax.run.id`, `oax.tenant.id`, `gen_ai.request.model`, `oax.policy.effect`.
- **Langfuse**: accepts OTLP over HTTP and maps `gen_ai.*` attributes; with metadata-only
  telemetry it shows the run tree, tokens, cost and latency, but no prompts (by design).
- **Arize Phoenix**: OTLP ingestion; Phoenix centres on the OpenInference attribute set, so
  `gen_ai.*` coverage depends on its version. The docs mark the example as "verify with your
  version" and show a collector `transform` only if a tested mapping exists.
- Examples are written and checked against the pinned convention (section 1); vendor behaviour
  claims are dated and labelled.

## Consequences

Positive:

- Runs become visible in standard monitoring with step, model, tool, policy and approval detail,
  following the conventions other agent frameworks use.
- Telemetry cannot become the leak: closed attribute allowlist, ContextGuard on free text,
  no content by default, no exception messages, no node-authored spans.
- Isolated steps get authoritative spans from the model proxy and the gate, and node claims are
  visible as claims.
- Audit and traces link both ways without making traces a second source of truth.
- Air-gapped installs stay at zero egress, proven by a test, and exporter TLS/mTLS follows the
  same network configuration as every other outbound path.

Negative:

- The conventions are experimental; following them costs a reviewed bump now and then and may
  break user dashboards (mitigated by the pin and `Changed` notes; `oax_` metrics stay stable).
- Metadata-only traces are less useful for prompt debugging than tools that capture content;
  content needs the gated S10.
- Two breaking metric label changes before 1.0.
- With sampling below 1, kept error traces may be partial; complete ones need collector tail
  sampling.
- A new migration and audit payload field; more code in the run path (bounded by section 13).

## Alternatives considered

- **Auto-instrumentation (`@opentelemetry/sdk-node` + `auto-instrumentations-node`).** Rejected:
  injects context into every outbound request (providers, MCP, OIDC), records full URLs, adds
  detectors that contact metadata endpoints and a large dependency footprint.
- **Let run nodes export their own spans** (collector reachable from nodes, or spans posted to
  the control node and re-exported). Rejected: an untrusted node could forge timing, names and
  hierarchy and flood the collector; the control plane already sees every authoritative fact.
- **Trace id = run id.** Simple lookup, no column. Rejected: couples an exported correlation id to
  the public identifier and to the UUID layout (fixed version bits), and a run is not always a
  single attempt; the stored random id plus `oax.run.id` gives the same lookup.
- **Tenant as a resource attribute via one TracerProvider per tenant.** Rejected: provider and
  exporter per tenant in every process does not scale with tenant count; collector-side routing
  on a span attribute does the same job.
- **Content capture on by default with redaction** (as several frameworks do). Rejected: conflicts
  with ADR 0012 (metadata-only default, operator access) and makes the collector a store of
  classified data.
- **Only `oax.*` names, no GenAI conventions.** Rejected: loses the ecosystem (Langfuse, Phoenix,
  dashboards); the pin makes the experimental status manageable.
- **Traces as the audit trail.** Rejected: sampling, loss and external mutability; ADR 0002 stays.

## Implementation notes S2

Decisions taken while implementing slice S2 (#207) where the text above left room:

- Migration `0020_run_trace_identity` (planned without a number). Besides the three columns it adds
  shape checks (both ids or neither, W3C shape, not all zero) and a trigger that makes
  `runs.trace_id` / `runs.trace_root_span_id` immutable. There is no backfill: a run created before
  the migration has no trace identity and its audit entries stay as they are.
- `payload.otel.spanId` is the documenting span when there is one and otherwise the run's root span;
  `traceId` is always the run's. The audit service writes the field from the run row, replaces any
  caller-supplied `otel`, and omits it for an entry whose tenant is not the run's tenant (an
  `access.denied` entry caused by another tenant's request for a foreign run id).
- `oax.audit.seq` is set on the admission span and on the attempt span (for `run.completed`).
  Further documenting spans get it in the slices that create them.
- Every id the platform creates for a span comes from the operating system CSPRNG (the provider's
  id generator replaces the SDK default, which uses `Math.random`).
- `traceId` (and the link from `OAX_OTEL_TRACE_URL_TEMPLATE`, `traceUrl`) is returned by
  `GET /v1/runs/{id}` only, not by lists or the other run endpoints.
- `oax_otel_inbound_context_total{result=ignored|linked|invalid}` counts inbound `traceparent`
  headers; with `ignore`, and in `link` mode without an exporter, nothing is linked.
- `run_node_sessions.trace_context` is created here but written only by slice S4.

## Implementation notes S3

Decisions taken while implementing slice S3 (#208) where the text above left room:

- The executor lives in `@openagentix/runners`, which must not depend on the API's telemetry. It
  calls an `ExecutorTelemetry` hook (`RunnerContext.telemetry`, `span(spec, attributes, fn)`); the
  worker provides it (`apps/worker/src/executor-spans.ts`) on top of `withSpan` and adds
  `oax.run.id`, `oax.tenant.id`, `oax.tenant.root_id` to every span. The hook is only handed out
  while an SDK provider is registered. `chat` spans are now `CLIENT`.
- Events go to the innermost step span: `oax.handover` while the input handover runs, `invoke_agent`
  afterwards. Event names: `oax.control.decision`, `oax.budget.breach`, `oax.guard.report`,
  `oax.handover.invalid`, `oax.handover.retry`, `oax.output.valid`; their attributes are new
  allowlist keys of the two span kinds and carry counts, rule names and codes only.
- A tool name that is not exposed to the step (the model invented it) is never a span name or
  attribute: `oax.policy.check _unknown`, no `gen_ai.tool.name`, no `oax.mcp.server`.
- `oax.approval.id` is not set (the approval wait returns an outcome only); `time_to_first_chunk`
  is not set (the executor does not stream); `oax.policy.bundle_digests` is not set (the policy
  decision does not carry digests yet); `oax.usage.source` is `provider` for every executor call.
- A step that fails ends its `invoke_agent` span with the failure code as `error.type`
  (`RunAborted` and `HandoverFailure` carry their code); the attempt span stays `OK` because the
  executor returns the failure as a result.
- `gen_ai.provider.name` maps the adapter family through a closed table (`genAiProviderName`); the
  instance name appears only as `oax.provider.instance` on `chat` spans. Owner question: the
  connection name of a BYOK provider is tenant-chosen text on a platform-wide collector.
- Isolated steps (run nodes, harnesses) get `oax.handover` and `invoke_agent` only; their children
  are slice S4.
- No migration.

## Implementation notes S4

Decisions taken while implementing slice S4 (#209) where the text above left room:

- **Where the node events live.** The API process that receives a node report is not the process
  that sees the session end (the worker revokes it, or the run completes elsewhere), so a span held
  open in memory could not collect them. Accepted reports are therefore appended to a bounded
  column `run_node_sessions.otel_session` (migration `0022_run_node_otel_session`: runner, harness,
  `dropped`, `events`; check constraint, at most 1000 events) and `revoke()` turns it into the
  `oax.node.session` span once, with the session's creation and revocation as span times and each
  event at its receipt time. The cap is a conditional `UPDATE`, so concurrent reports cannot exceed
  it. A session created without a stored context has no state (`NULL`): nothing is read or written
  for it.
- **The stored context** is written by `createSession` from the active span, only when that span is
  in the run's own trace (`invoke_agent` of the dispatching step). The same value goes to the
  runner as `RunNodeSpec.traceparent` and becomes `TRACEPARENT` (container and Kubernetes) after a
  strict W3C shape check. The node tags its log lines with it; the harness child environment is an
  allowlist and does not contain it.
- **Tool names come from the grant list, not from the node.** A reported or gated call is matched
  against the step's concrete tool grants (stored in the handover). The span carries the *grant's*
  strings: for a wildcard grant `list_*` the node's own suffix is never exported. A call without a
  matching grant is `oax.policy.check _unknown` (gate) or an event without a tool name (report).
- **Node-claimed statuses and durations.** New allowlist key `oax.claimed.status` (fixed set);
  `oax.claimed.duration_ms` was already capped at 1 hour by the allowlist, the event builder
  additionally drops non-finite and negative values. Error reports carry neither code nor message.
- **`chat` span timing.** Started when the call is admitted, ended where the proxy counts the
  outcome; a refused call (`deny`) is an instantly ended `ERROR` span named after the *published*
  model (never the model the node asked for). Tokens, cost, price status and usage source are set
  from the settlement. Pass-through surfaces add `oax.model.surface`.
- **Mismatch counter.** `traceparent` of node requests is compared in `checkSession` /
  `authenticate` with the stored context; a missing, malformed or different trace id increments
  `oax_otel_node_context_mismatch_total`. Nothing else is done with the header.
- **Not part of S4:** `oax_node_reports_total{kind,result}` (slice S5), `oax.policy.bundle_digests`,
  audit `payload.otel.spanId` pointing at the node spans (`policy.decision` and `step.model_call`
  entries of nodes link to the run's root span as before).

## Open questions (owner decisions needed)

1. **Content capture**: never in v1, or the gated `redacted` mode of 5.4 (input/output messages,
   tenant opt-in, tenant-owned exporter or single-tenant mode only)?
2. **Tenant-owned exporters** (connection type `telemetry`, 7.3): wanted, and in which release?
3. **gRPC exporter**: needed (adds `@grpc/grpc-js`), or HTTP/protobuf only?
4. **Breaking metric label changes** of 10.1 (`provider` family on cost, `kind` instead of the
   event source name): accept for the next 0.x minor?
5. **Default sample ratio 1.0** and the always-keep classes: agreed?
6. **MCP propagation**: default `deny` platform-wide with per-instance opt-in, or allow by
   default for platform-scope (operator-run) MCP servers?
7. **Inbound `traceparent`**: `ignore` by default, or `link` by default for the authenticated API
   (not webhooks)?
8. **Tenant label on metrics** for single-tenant setups (ADR 0013): allow an opt-in
   `oax_*{tenant}` label there, or keep the rule absolute?
