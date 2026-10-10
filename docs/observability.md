# Observability

openagentix emits OpenTelemetry traces (OTLP) and Prometheus metrics. The design, the threat
model and the slice plan are in [ADR 0015](adr/0015-opentelemetry-genai-tracing.md). This page
documents what is implemented; it grows with each slice.

> **Status.** The core is hardened (ADR 0015 slice S1): the attribute allowlist, error handling
> without messages, the exporter configuration and its safety rules. The span tree (one span per
> step, model call and tool call) follows in later slices. Today the worker emits one span per
> run (`oax.run`).

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

The exporter is off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set; then no SDK provider is
registered and no socket is opened.

- **Protocol:** `OTEL_EXPORTER_OTLP_PROTOCOL` is `http/protobuf` (default) or `http/json`.
- **TLS:** `http://` is accepted only for a loopback collector, or when `OAX_OTEL_INSECURE=true`
  (an in-cluster collector without TLS). The endpoint must not contain credentials, a query or a
  fragment.
- **Credentials:** exporter headers (for example a backend API key) come from
  `OAX_OTEL_HEADERS_SECRET`, a secret **reference** resolved through the secret resolver
  (`OAX_SECRET_<NAME>` or a file in `OAX_SECRETS_DIR`). The secret holds `Name=value,Name2=value2`.
  The values are registered with the guard, so they cannot appear in a span, and they are never
  logged.
- **Refused variables:** the standard `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_CERTIFICATE`,
  `OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE`, `OTEL_EXPORTER_OTLP_CLIENT_KEY` and their `_TRACES_`
  variants, as well as `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL`,
  make start-up fail with a message that names the replacement. The OpenTelemetry SDK would read
  them implicitly (merging headers, loading certificate files), which would be a second,
  unreviewed configuration path. Values are never echoed.
- **No resource detectors.** The resource is static: `service.name` (`OTEL_SERVICE_NAME`) and the
  validated `OAX_OTEL_RESOURCE_ATTRIBUTES`. Nothing calls a cloud metadata endpoint or reads host
  details, and `OTEL_RESOURCE_ATTRIBUTES` is not read.
- **Never blocking.** The export queue is bounded (`OAX_OTEL_MAX_QUEUE`) and every export has a
  timeout (`OAX_OTEL_EXPORT_TIMEOUT_MS`). A full queue drops spans
  (`oax_otel_spans_dropped_total`); a failed export counts in
  `oax_otel_export_failures_total{reason}` (`timeout`, `network`, `http`, `other`) and is logged at
  most once a minute with the reason only. Shutdown waits at most 5 seconds.
- **Air-gapped mode** is unchanged: the endpoint must be on `OAX_AIRGAPPED_ALLOW`. Routing the
  exporter through the outbound dispatcher (proxies, trust bundles, client certificates) is slice S7.

## Log correlation

Every log line written inside a span carries `trace_id` and `span_id` (hex, ids only).

## Configuration

See [`configuration.md`](configuration.md#observability) for the table of variables. Keys whose
feature lands in a later slice (sampling, keep classes, node events, inbound context, MCP
propagation, GenAI metrics, trace URL template) are parsed and validated now and have no effect yet.

## Metrics of the tracing pipeline

| Metric | Labels | Meaning |
| --- | --- | --- |
| `oax_otel_spans_dropped_total` | – | Spans dropped because the export queue was full. |
| `oax_otel_export_failures_total` | `reason` | Failed exports (`timeout`, `network`, `http`, `other`). |
| `oax_otel_attributes_dropped_total` | `key_class` | Attributes the allowlist refused. |
| `oax_otel_redactions_total` | `kind` | Values the ContextGuard changed (secret kinds, `invisible`). |

All label values come from closed sets; none is derived from tenant input.
