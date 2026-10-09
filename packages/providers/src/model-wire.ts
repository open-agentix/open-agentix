import { HARNESS_KINDS } from '@openagentix/core';
import { z } from 'zod';

/**
 * Wire schemas of the native model proxy surface (ADR 0009, sections 2.2, 2.3 and 2.5). All
 * request schemas are strict: unknown keys (a `provider` field, server-side tool settings, a
 * node-supplied `simulation`) are refused instead of ignored. The control node parses a request
 * with these schemas and builds a new upstream request from the parsed value.
 */

export const MODEL_PROXY_LIMITS = {
  maxMessages: 500,
  maxTools: 128,
  maxToolSchemaBytes: 64 * 1024,
  maxTextBytes: 256 * 1024,
  maxJsonDepth: 64,
} as const;

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** True when a JSON value nests deeper than `maxDepth` or contains a prototype-polluting key. */
export function hasUnsafeJson(value: unknown, maxDepth: number = MODEL_PROXY_LIMITS.maxJsonDepth) {
  const walk = (v: unknown, depth: number): boolean => {
    if (depth > maxDepth) return true;
    if (Array.isArray(v)) return v.some((x) => walk(x, depth + 1));
    if (v !== null && typeof v === 'object') {
      for (const k of Object.keys(v)) {
        if (FORBIDDEN_KEYS.has(k)) return true;
        if (walk((v as Record<string, unknown>)[k], depth + 1)) return true;
      }
    }
    return false;
  };
  return walk(value, 0);
}

/**
 * Plain JSON object checked on the raw value. `z.record` is deliberately not used: it rebuilds the
 * object and silently drops `__proto__` keys, so a refinement after it would never see them.
 */
const JsonObject = z.custom<Record<string, unknown>>(
  (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !hasUnsafeJson(v),
  'object is too deep or contains a forbidden key',
);

const Text = z
  .string()
  .refine(
    (s) =>
      s.length <= MODEL_PROXY_LIMITS.maxTextBytes &&
      Buffer.byteLength(s) <= MODEL_PROXY_LIMITS.maxTextBytes,
    'text is too large',
  );

const ToolName = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);

export const WireToolSpecSchema = z.strictObject({
  name: ToolName,
  description: Text.optional(),
  inputSchema: JsonObject.refine(
    (v) => JSON.stringify(v).length <= MODEL_PROXY_LIMITS.maxToolSchemaBytes,
    'tool schema is too large',
  ),
});

const WireToolCallSchema = z.strictObject({
  id: z.string().min(1).max(200),
  name: ToolName,
  args: JsonObject,
});

export const WireChatMessageSchema = z.discriminatedUnion('role', [
  z.strictObject({ role: z.literal('user'), content: Text }),
  z.strictObject({
    role: z.literal('assistant'),
    content: Text,
    toolCalls: z.array(WireToolCallSchema).max(128).optional(),
  }),
  z.strictObject({
    role: z.literal('tool'),
    toolCallId: z.string().min(1).max(200),
    name: ToolName,
    content: Text,
    isError: z.boolean().optional(),
  }),
]);

const Id = z.string().min(1).max(200);

/** `WorkerModelRequest`: what a node sends to `POST /v1/worker/runs/{id}/model`. */
export const WorkerModelRequestSchema = z.strictObject({
  agentId: Id,
  request: z.strictObject({
    /** Must equal the published `agent.model`; checked by the proxy, not here. */
    model: z.string().min(1).max(200),
    system: Text.optional(),
    messages: z.array(WireChatMessageSchema).min(1).max(MODEL_PROXY_LIMITS.maxMessages),
    tools: z.array(WireToolSpecSchema).max(MODEL_PROXY_LIMITS.maxTools).optional(),
    /** Clamped by the proxy, never raised. */
    maxTokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    /** Only `context` for simulated templates; `simulation` comes from the published definition. */
    hints: z.strictObject({ context: JsonObject.optional() }).optional(),
  }),
});
export type WorkerModelRequest = z.infer<typeof WorkerModelRequestSchema>;

const TokenCount = z.number().int().nonnegative();

export const WireUsageSchema = z.strictObject({
  inputTokens: TokenCount,
  outputTokens: TokenCount,
  cacheReadTokens: TokenCount.optional(),
  cacheWriteTokens: TokenCount.optional(),
});

export const WireChatResponseSchema = z.strictObject({
  text: z.string(),
  toolCalls: z.array(WireToolCallSchema),
  usage: WireUsageSchema,
  stopReason: z.enum(['end_turn', 'tool_use', 'max_tokens', 'refusal', 'other']),
  model: z.string(),
});

export const USAGE_SOURCES = ['provider', 'estimated', 'floor'] as const;

/** `WorkerModelResponse`: the node uses `usage` and `remaining` for local decisions only. */
export const WorkerModelResponseSchema = z.strictObject({
  /** Reservation id, also in the audit entry. */
  callId: z.string().min(1),
  response: WireChatResponseSchema,
  usage: z.strictObject({
    inputTokens: TokenCount,
    outputTokens: TokenCount,
    cacheReadTokens: TokenCount,
    cacheWriteTokens: TokenCount,
    source: z.enum(USAGE_SOURCES),
  }),
  costMicros: TokenCount,
  priced: z.boolean(),
  /** Tightest remaining scope. */
  remaining: z.strictObject({
    costMicros: TokenCount.optional(),
    tokens: TokenCount.optional(),
    modelCalls: TokenCount.optional(),
  }),
});
export type WorkerModelResponse = z.infer<typeof WorkerModelResponseSchema>;

export const MODEL_PROTOCOLS = ['anthropic', 'openai', 'native'] as const;

/** Response of `POST /v1/worker/runs/{id}/model-token` (sent with `Cache-Control: no-store`). */
export const ModelTokenResponseSchema = z.strictObject({
  token: z.string().regex(/^oaxmt\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
  expiresAt: z.iso.datetime(),
  protocol: z.enum(MODEL_PROTOCOLS),
  baseUrl: z.string().min(1),
  model: z.string().min(1),
});
export type ModelTokenResponse = z.infer<typeof ModelTokenResponseSchema>;

/** Request body of `POST /v1/worker/runs/{id}/model-token`. */
export const ModelTokenRequestSchema = z.strictObject({
  agentId: Id,
  /**
   * Set by a harness step (`agents[].runtime.harness`): the control node then answers with the
   * pass-through surface that harness has to use. It must equal the harness the step published.
   */
  harness: z.enum(HARNESS_KINDS).optional(),
});
export type ModelTokenRequest = z.infer<typeof ModelTokenRequestSchema>;

/** Platform error envelope of the native and `model-token` routes. */
export const ModelErrorEnvelopeSchema = z.strictObject({
  error: z.strictObject({ code: z.string().min(1), message: z.string() }),
});
export type ModelErrorEnvelope = z.infer<typeof ModelErrorEnvelopeSchema>;

/** Error codes, HTTP status and Anthropic error `type` (ADR 0009 section 2.5). */
export const MODEL_ERRORS = {
  model_request_invalid: { status: 400, anthropicType: 'invalid_request_error' },
  model_parameter_refused: { status: 400, anthropicType: 'invalid_request_error' },
  model_surface_mismatch: { status: 400, anthropicType: 'invalid_request_error' },
  unauthenticated: { status: 401, anthropicType: 'authentication_error' },
  run_node_session_revoked: { status: 403, anthropicType: 'permission_error' },
  model_not_allowed: { status: 403, anthropicType: 'permission_error' },
  classification_denied: { status: 403, anthropicType: 'permission_error' },
  egress_denied: { status: 403, anthropicType: 'permission_error' },
  security_override: { status: 403, anthropicType: 'permission_error' },
  control_budget_tokens: { status: 403, anthropicType: 'permission_error' },
  control_budget_cost: { status: 403, anthropicType: 'permission_error' },
  control_budget_steps: { status: 403, anthropicType: 'permission_error' },
  control_budget_tenant: { status: 403, anthropicType: 'permission_error' },
  control_budget_use_case: { status: 403, anthropicType: 'permission_error' },
  control_budget_team: { status: 403, anthropicType: 'permission_error' },
  model_token_already_issued: { status: 409, anthropicType: null },
  model_request_too_large: { status: 413, anthropicType: 'request_too_large' },
  model_unpriced: { status: 422, anthropicType: 'invalid_request_error' },
  model_rate_limited: { status: 429, anthropicType: 'rate_limit_error' },
  provider_error: { status: 502, anthropicType: 'api_error' },
  model_proxy_unavailable: { status: 503, anthropicType: 'overloaded_error' },
  provider_timeout: { status: 504, anthropicType: 'api_error' },
} as const;
export type ModelErrorCode = keyof typeof MODEL_ERRORS;

export function modelErrorEnvelope(code: ModelErrorCode, message: string): ModelErrorEnvelope {
  return { error: { code, message } };
}
