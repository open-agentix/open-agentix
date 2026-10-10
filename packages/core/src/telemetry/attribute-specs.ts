/**
 * The closed attribute allowlist of ADR 0015 section 4.3: every key a span or span event may carry,
 * with its type, bounds and value set. Declarative only; `attributes.ts` applies it.
 */

export type StringSpec = {
  t: 'string';
  /** Hard length cap. Free text is truncated to it, strictly typed values are dropped above it. */
  max: number;
  /** Fixed value set (checked before the value goes anywhere else). */
  enum?: readonly string[];
  /** Required shape of the (guarded) value; a mismatch drops the attribute. */
  pattern?: RegExp;
  /** Free text: control characters removed, truncated instead of dropped when too long. */
  freeText?: boolean;
};
export type IntSpec = { t: 'int'; min: number; max: number; clamp?: boolean };
export type NumberSpec = { t: 'number'; min: number; max: number };
export type BoolSpec = { t: 'bool' };
export type StringArraySpec = { t: 'string[]'; maxItems: number; item: StringSpec };
export type AttributeSpec = StringSpec | IntSpec | NumberSpec | BoolSpec | StringArraySpec;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Platform error codes (`OaxError.code`, proxy codes) and the catch-all `_OTHER`. */
export const ERROR_CODE_PATTERN = /^(?:_OTHER|[A-Za-z][A-Za-z0-9_.-]{0,63})$/;
const SLUG = /^[a-z][a-z0-9_-]{0,62}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]{0,48})?$/;
/** Provider-issued tool call ids are model-influenced: kept only in this shape (ADR 0015 4.3). */
const TOOL_CALL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HTTP_METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  '_OTHER',
] as const;
const MAX_COUNT = Number.MAX_SAFE_INTEGER;

const uuid: StringSpec = { t: 'string', max: 36, pattern: UUID };
const slug: StringSpec = { t: 'string', max: 63, pattern: SLUG };
const text = (max: number): StringSpec => ({ t: 'string', max, freeText: true });
const choice = (...values: string[]): StringSpec => ({
  t: 'string',
  max: Math.max(...values.map((v) => v.length)),
  enum: values,
});
const count: IntSpec = { t: 'int', min: 0, max: MAX_COUNT };
const bool: BoolSpec = { t: 'bool' };

/** Every key the platform may ever put on a span or span event. Anything else is dropped. */
export const ATTRIBUTE_SPECS = {
  // Identity (every span of a run).
  'oax.run.id': uuid,
  'oax.tenant.id': uuid,
  'oax.tenant.root_id': uuid,
  'oax.redacted': bool,
  // Reverse link to the audit entry that documents the span's fact (ADR 0015 section 11).
  'oax.audit.seq': { t: 'int', min: 1, max: MAX_COUNT },
  // Errors (ADR 0015 3.5): the code, never the message.
  'error.type': { t: 'string', max: 64, pattern: ERROR_CODE_PATTERN },
  'exception.type': { t: 'string', max: 64, pattern: /^(?:_OTHER|[A-Za-z_$][A-Za-z0-9_$]{0,63})$/ },
  // Only accepted when OAX_OTEL_EXCEPTION_DETAIL=guarded (see `SanitizeOptions`).
  'exception.message': text(256),
  // GenAI conventions (pinned, see semconv.ts).
  'gen_ai.operation.name': choice('chat', 'invoke_agent', 'invoke_workflow', 'execute_tool'),
  'gen_ai.provider.name': { t: 'string', max: 63, pattern: /^[a-z][a-z0-9_.-]{0,62}$/ },
  'gen_ai.request.model': text(128),
  'gen_ai.response.model': text(128),
  'gen_ai.request.max_tokens': count,
  'gen_ai.request.temperature': { t: 'number', min: 0, max: 10 },
  'gen_ai.response.finish_reasons': {
    t: 'string[]',
    maxItems: 8,
    item: { t: 'string', max: 32, pattern: /^[a-z][a-z0-9_-]{0,31}$/ },
  },
  'gen_ai.response.time_to_first_chunk': { t: 'number', min: 0, max: 86_400 },
  'gen_ai.usage.input_tokens': count,
  'gen_ai.usage.output_tokens': count,
  'gen_ai.usage.cache_read.input_tokens': count,
  'gen_ai.usage.cache_write.input_tokens': count,
  'gen_ai.workflow.name': slug,
  'gen_ai.agent.name': slug,
  'gen_ai.agent.id': {
    t: 'string',
    max: 127,
    pattern: /^[a-z][a-z0-9_-]{0,62}\/[a-z][a-z0-9_-]{0,62}$/,
  },
  'gen_ai.agent.version': { t: 'string', max: 64, pattern: SEMVER },
  'gen_ai.tool.name': text(128),
  'gen_ai.tool.type': choice('extension'),
  'gen_ai.tool.call.id': { t: 'string', max: 64, pattern: TOOL_CALL_ID },
  // Platform attributes.
  'oax.trigger.kind': slug,
  'oax.admission.result': slug,
  'oax.worker': { t: 'string', max: 64, pattern: /^[A-Za-z0-9_.:-]{1,64}$/ },
  'oax.agent.version': { t: 'string', max: 64, pattern: SEMVER },
  'oax.run.attempt': { t: 'int', min: 0, max: 10_000 },
  'oax.run.status': slug,
  'oax.cost.micro_usd': count,
  'oax.cost.priced': bool,
  'oax.classification': slug,
  'oax.use_case': text(64),
  'oax.step.id': slug,
  'oax.handover.explicit': bool,
  'oax.handover.result': choice('ok', 'skipped', 'invalid'),
  'oax.schema.digest': { t: 'string', max: 71, pattern: DIGEST },
  'oax.runner.kind': slug,
  'oax.usage.source': choice('provider', 'estimate', 'floor'),
  'oax.model.via': choice('in-process', 'proxy'),
  'oax.model.surface': slug,
  'oax.reservation.result': slug,
  'oax.provider.instance': text(63),
  'oax.mcp.server': text(64),
  // MCP conventions on `execute_tool`, only while context propagation is on (ADR 0015 section 6.4).
  'mcp.method.name': choice('tools/call'),
  'mcp.protocol.version': choice(
    '2024-10-07',
    '2024-11-05',
    '2025-03-26',
    '2025-06-18',
    '2025-11-25',
  ),
  'oax.mcp.propagated': bool,
  'oax.policy.effect': choice('allow', 'deny', 'require_approval'),
  'oax.policy.reason_codes': {
    t: 'string[]',
    maxItems: 8,
    item: { t: 'string', max: 64, pattern: /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/ },
  },
  'oax.policy.bundle_digests': {
    t: 'string[]',
    maxItems: 8,
    item: { t: 'string', max: 71, pattern: DIGEST },
  },
  'oax.approval.outcome': choice('approved', 'rejected', 'timeout', 'cancelled'),
  'oax.approval.id': uuid,
  'oax.tool.result_bytes': count,
  'oax.tool.truncated': bool,
  'oax.tool.is_error': bool,
  // Control decisions, guard reports, budget breaches and output validation (span events): codes,
  // rule names and counts only (ADR 0015 section 3.1).
  'oax.control.action': choice('pause', 'kill'),
  'oax.control.rules': {
    t: 'string[]',
    maxItems: 8,
    item: { t: 'string', max: 32, pattern: /^[a-z][a-z0-9_]{0,31}$/ },
  },
  'oax.budget.scopes': {
    t: 'string[]',
    maxItems: 4,
    item: { t: 'string', max: 32, pattern: /^[a-z][a-z0-9_]{0,31}$/ },
  },
  'oax.guard.source': choice('input', 'tool_result', 'tool_error'),
  'oax.guard.invisible': count,
  'oax.guard.secrets': count,
  'oax.guard.secret_kinds': {
    t: 'string[]',
    maxItems: 8,
    item: { t: 'string', max: 32, pattern: /^[a-z][a-z0-9_-]{0,31}$/ },
  },
  'oax.validation.direction': choice('input', 'output'),
  'oax.validation.attempt': { t: 'int', min: 0, max: 100 },
  'oax.validation.violations': count,
  'oax.node.runner': choice('container', 'kubernetes-job'),
  'oax.node.harness': slug,
  'oax.node.revoke_reason': slug,
  'oax.node.events_dropped': count,
  'oax.claim': choice('node'),
  // A node-claimed duration is capped, never trusted (ADR 0015 6.2).
  'oax.claimed.duration_ms': { t: 'int', min: 0, max: 3_600_000, clamp: true },
  // The status a node attached to its report (a fixed set; the report schema enforces it too).
  'oax.claimed.status': choice(
    'ok',
    'error',
    'denied',
    'pending',
    'approved',
    'rejected',
    'skipped',
  ),
  'http.request.method': { t: 'string', max: 8, enum: HTTP_METHODS },
  'http.route': { t: 'string', max: 128, pattern: /^\/[\x21-\x7e]{0,127}$/ },
  'http.response.status_code': { t: 'int', min: 100, max: 599 },
  'oax.access': choice('user', 'run-token', 'model-token', 'public'),
} as const satisfies Record<string, AttributeSpec>;

export type AttributeKey = keyof typeof ATTRIBUTE_SPECS;

/** Span kinds of the span table (ADR 0015 3.2) plus the legacy `oax.run` span and a fallback. */
export type SpanKind =
  | 'run'
  | 'run_admit'
  | 'invoke_workflow'
  | 'handover'
  | 'invoke_agent'
  | 'chat'
  | 'policy_check'
  | 'approval_wait'
  | 'execute_tool'
  | 'node_session'
  | 'http_server'
  | 'unknown';

/** Keys every span (and every span event) may carry. */
const COMMON: readonly AttributeKey[] = [
  'oax.run.id',
  'oax.tenant.id',
  'oax.tenant.root_id',
  'oax.redacted',
  'error.type',
  'exception.type',
  'exception.message',
];
const TOTALS: readonly AttributeKey[] = [
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  'oax.cost.micro_usd',
];

const PER_KIND: Record<Exclude<SpanKind, 'unknown'>, readonly AttributeKey[]> = {
  run: ['oax.worker', 'oax.run.status'],
  run_admit: ['oax.trigger.kind', 'oax.admission.result', 'oax.audit.seq'],
  invoke_workflow: [
    'gen_ai.operation.name',
    'gen_ai.workflow.name',
    'oax.agent.version',
    'oax.run.attempt',
    'oax.run.status',
    'oax.classification',
    'oax.use_case',
    'oax.audit.seq',
    ...TOTALS,
  ],
  handover: [
    'oax.step.id',
    'oax.handover.explicit',
    'oax.handover.result',
    'oax.schema.digest',
    'oax.validation.direction',
    'oax.validation.attempt',
    'oax.validation.violations',
  ],
  invoke_agent: [
    'gen_ai.operation.name',
    'gen_ai.agent.name',
    'gen_ai.agent.id',
    'gen_ai.agent.version',
    'gen_ai.request.model',
    'gen_ai.provider.name',
    'oax.runner.kind',
    'oax.control.action',
    'oax.control.rules',
    'oax.budget.scopes',
    'oax.guard.source',
    'oax.guard.invisible',
    'oax.guard.secrets',
    'oax.guard.secret_kinds',
    'oax.validation.direction',
    'oax.validation.attempt',
    'oax.validation.violations',
    'oax.schema.digest',
    ...TOTALS,
  ],
  chat: [
    'gen_ai.operation.name',
    'gen_ai.provider.name',
    'gen_ai.request.model',
    'gen_ai.response.model',
    'gen_ai.request.max_tokens',
    'gen_ai.request.temperature',
    'gen_ai.response.finish_reasons',
    'gen_ai.response.time_to_first_chunk',
    'gen_ai.usage.input_tokens',
    'gen_ai.usage.output_tokens',
    'gen_ai.usage.cache_read.input_tokens',
    'gen_ai.usage.cache_write.input_tokens',
    'oax.cost.micro_usd',
    'oax.cost.priced',
    'oax.usage.source',
    'oax.model.via',
    'oax.model.surface',
    'oax.reservation.result',
    'oax.provider.instance',
  ],
  policy_check: [
    'gen_ai.tool.name',
    'oax.mcp.server',
    'oax.policy.effect',
    'oax.policy.reason_codes',
    'oax.policy.bundle_digests',
  ],
  approval_wait: ['oax.approval.outcome', 'oax.approval.id'],
  execute_tool: [
    'gen_ai.operation.name',
    'gen_ai.tool.name',
    'gen_ai.tool.type',
    'gen_ai.tool.call.id',
    'oax.mcp.server',
    'mcp.method.name',
    'mcp.protocol.version',
    'oax.mcp.propagated',
    'oax.tool.result_bytes',
    'oax.tool.truncated',
    'oax.tool.is_error',
    'oax.cost.micro_usd',
  ],
  node_session: [
    'oax.node.runner',
    'oax.node.harness',
    'oax.node.revoke_reason',
    'oax.node.events_dropped',
    'oax.claim',
    'oax.claimed.duration_ms',
    'oax.claimed.status',
    'oax.guard.source',
    'oax.guard.invisible',
    'oax.guard.secrets',
    'oax.guard.secret_kinds',
    'gen_ai.tool.name',
    'oax.mcp.server',
  ],
  http_server: ['http.request.method', 'http.route', 'http.response.status_code', 'oax.access'],
};

/** Allowed keys per span kind; unknown span names get the common keys only. */
export const ALLOWED_KEYS: Record<SpanKind, ReadonlySet<string>> = Object.fromEntries([
  ...Object.entries(PER_KIND).map(([k, keys]) => [k, new Set<string>([...COMMON, ...keys])]),
  ['unknown', new Set<string>(COMMON)],
]) as Record<SpanKind, ReadonlySet<string>>;

/**
 * Keys that carry content or secrets by definition (ADR 0015 4.2). They are in no allowlist; this
 * list only lets the drop counter tell a content attempt from a plain unknown key.
 */
export const CONTENT_KEY_PATTERN =
  /^(?:gen_ai\.(?:input|output)\.messages|gen_ai\.system_instructions|gen_ai\.tool\.(?:definitions|description|call\.(?:arguments|result))|exception\.stacktrace|http\.(?:request|response)\.header\..*|url\.(?:full|query)|http\.url|db\.statement|enduser\..*|user\..*)$/;
