import { z } from 'zod';
import { MODEL_PROXY_LIMITS, hasUnsafeJson } from '../model-wire.js';
import type { ChatMessage, ChatRequest, ToolCall } from '../types.js';

/**
 * Request side of the pass-through surfaces (ADR 0009 sections 2.4, 6.1 and 6.2): the Anthropic
 * Messages and OpenAI Chat Completions protocols as harnesses speak them. A client body is parsed
 * with a strict allowlist schema and the upstream body is **built anew** from the parsed value;
 * raw bytes, unknown keys, query strings and client headers are never forwarded.
 */

export type PassthroughSurface = 'anthropic' | 'openai';

/** Image and block limits on top of `MODEL_PROXY_LIMITS` (ADR 0009 section 6.2). */
export const PASSTHROUGH_LIMITS = {
  maxImages: 20,
  maxImageBytes: 5 * 1024 * 1024,
  maxStopSequences: 4,
  maxSystemBlocks: 128,
  maxResponseFormatBytes: 32 * 1024,
  maxToolCalls: 128,
} as const;

/** A request the proxy refuses; the message names the parameter, never its value. */
export class PassthroughRequestError extends Error {
  constructor(
    readonly code: 'model_parameter_refused' | 'model_request_invalid',
    message: string,
  ) {
    super(message);
  }
}

/** A validated pass-through request, ready for admission and for building the upstream body. */
export interface PassthroughRequest {
  surface: PassthroughSurface;
  model: string;
  /** The client wants a Server-Sent Events answer. */
  stream: boolean;
  /** OpenAI: the client asked for the final usage chunk (`stream_options.include_usage`). */
  includeUsage: boolean;
  /** What the client asked for; the proxy clamps it and never raises it. */
  requestedMaxTokens: number | undefined;
  /** Flattened view for estimation, the request digest and the simulated provider. */
  chat: ChatRequest;
  /** Number of images (each counts a fixed upper bound in the input estimate). */
  images: number;
  /** Bytes of parameters that are not part of `chat` but are tokenised (tool choice, stops, ...). */
  extraBytes: number;
  /** Builds the upstream body with the granted output bound. A fresh object every time. */
  build(maxTokens: number, opts?: BuildOptions): Record<string, unknown>;
}

export interface BuildOptions {
  /** OpenAI: name of the output bound parameter of the provider. Default `max_tokens`. */
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens' | undefined;
}

const safeName = (k: unknown): string =>
  String(k)
    .replace(/[^\w.-]/g, '')
    .slice(0, 64) || 'unknown';

/** Plain JSON object checked on the raw value (see `model-wire.ts`). */
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
const Id = z.string().min(1).max(200);
const ToolName = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const ToolSchema = JsonObject.refine(
  (v) => JSON.stringify(v).length <= MODEL_PROXY_LIMITS.maxToolSchemaBytes,
  'tool schema is too large',
);
const StopSequence = z.string().min(1).max(256);

/** Turns a zod failure into a refusal that names parameters only. */
function refuse(error: z.ZodError): never {
  const unknown = error.issues.find((i) => i.code === 'unrecognized_keys');
  if (unknown && unknown.code === 'unrecognized_keys') {
    const path = unknown.path.map(safeName).join('.');
    const keys = unknown.keys.map(safeName).join(', ');
    throw new PassthroughRequestError(
      'model_parameter_refused',
      `parameter not allowed: ${path ? `${path}.` : ''}${keys || 'unknown'}`,
    );
  }
  const where = [...new Set(error.issues.map((i) => i.path.map(safeName).join('.') || '/'))].slice(
    0,
    5,
  );
  throw new PassthroughRequestError(
    'model_request_invalid',
    `request validation failed: ${where.join(', ')}`,
  );
}

function parseWith<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) return refuse(r.error);
  return r.data;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const refused = (what: string): never => {
  throw new PassthroughRequestError('model_parameter_refused', what);
};

// ---------------------------------------------------------------------------------------------
// Anthropic Messages
// ---------------------------------------------------------------------------------------------

const CacheControl = z.strictObject({
  type: z.literal('ephemeral'),
  ttl: z.enum(['5m', '1h']).optional(),
});

const AText = z.strictObject({
  type: z.literal('text'),
  text: Text,
  cache_control: CacheControl.optional(),
});
const AImage = z.strictObject({
  type: z.literal('image'),
  source: z.strictObject({
    type: z.literal('base64'),
    media_type: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
    data: z
      .string()
      .max(PASSTHROUGH_LIMITS.maxImageBytes)
      .regex(/^[A-Za-z0-9+/=_-]*$/),
  }),
  cache_control: CacheControl.optional(),
});
const AToolUse = z.strictObject({
  type: z.literal('tool_use'),
  id: Id,
  name: ToolName,
  input: JsonObject,
  cache_control: CacheControl.optional(),
});
const AToolResult = z.strictObject({
  type: z.literal('tool_result'),
  tool_use_id: Id,
  content: z
    .union([Text, z.array(z.discriminatedUnion('type', [AText, AImage])).max(128)])
    .optional(),
  is_error: z.boolean().optional(),
  cache_control: CacheControl.optional(),
});
const AThinking = z.strictObject({
  type: z.literal('thinking'),
  thinking: Text,
  signature: z.string().max(64 * 1024),
});
const ARedacted = z.strictObject({
  type: z.literal('redacted_thinking'),
  data: z.string().max(MODEL_PROXY_LIMITS.maxTextBytes),
});
const ABlock = z.discriminatedUnion('type', [
  AText,
  AImage,
  AToolUse,
  AToolResult,
  AThinking,
  ARedacted,
]);
const AMessage = z.strictObject({
  role: z.enum(['user', 'assistant']),
  content: z.union([Text, z.array(ABlock).max(256)]),
});
const ATool = z.strictObject({
  type: z.literal('custom').optional(),
  name: ToolName,
  description: Text.optional(),
  input_schema: ToolSchema,
  cache_control: CacheControl.optional(),
});
const AToolChoice = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('auto'), disable_parallel_tool_use: z.boolean().optional() }),
  z.strictObject({ type: z.literal('any'), disable_parallel_tool_use: z.boolean().optional() }),
  z.strictObject({
    type: z.literal('tool'),
    name: ToolName,
    disable_parallel_tool_use: z.boolean().optional(),
  }),
  z.strictObject({ type: z.literal('none') }),
]);
const AnthropicRequestSchema = z.strictObject({
  model: z.string().min(1).max(200),
  max_tokens: z.number().int().positive(),
  messages: z.array(AMessage).min(1).max(MODEL_PROXY_LIMITS.maxMessages),
  system: z.union([Text, z.array(AText).max(PASSTHROUGH_LIMITS.maxSystemBlocks)]).optional(),
  tools: z.array(ATool).max(MODEL_PROXY_LIMITS.maxTools).optional(),
  tool_choice: AToolChoice.optional(),
  temperature: z.number().min(0).max(1).optional(),
  top_p: z.number().min(0).max(1).optional(),
  top_k: z.number().int().min(0).max(100_000).optional(),
  stop_sequences: z.array(StopSequence).max(PASSTHROUGH_LIMITS.maxStopSequences).optional(),
  stream: z.boolean().optional(),
  thinking: z
    .discriminatedUnion('type', [
      z.strictObject({
        type: z.literal('enabled'),
        budget_tokens: z.number().int().min(1024).max(1_000_000),
      }),
      z.strictObject({ type: z.literal('disabled') }),
    ])
    .optional(),
  // Accepted and dropped: the proxy never forwards client identifiers.
  metadata: z.strictObject({ user_id: z.string().max(256).nullable().optional() }).optional(),
});

const A_BLOCK_TYPES = new Set([
  'text',
  'image',
  'tool_use',
  'tool_result',
  'thinking',
  'redacted_thinking',
]);

/** Refuses what the schema would only report as a union mismatch (ADR 0009 section 6.2). */
function prescanAnthropic(body: unknown): void {
  if (!isObj(body)) return;
  if (Array.isArray(body.tools)) {
    for (const t of body.tools) {
      if (isObj(t) && t.type !== undefined && t.type !== 'custom')
        refused(`tool type not allowed: ${safeName(t.type)}`);
    }
  }
  const scan = (blocks: unknown, nested: boolean): void => {
    if (!Array.isArray(blocks)) return;
    for (const b of blocks) {
      if (!isObj(b)) continue;
      const type = b.type;
      const allowed = nested
        ? type === 'text' || type === 'image'
        : A_BLOCK_TYPES.has(String(type));
      if (typeof type === 'string' && !allowed)
        refused(`content block type not allowed: ${safeName(type)}`);
      if (type === 'image' && isObj(b.source) && b.source.type !== 'base64')
        refused('image source must be base64');
      if (type === 'tool_result') scan(b.content, true);
    }
  };
  if (Array.isArray(body.messages))
    for (const m of body.messages) if (isObj(m)) scan(m.content, false);
  if (Array.isArray(body.system)) scan(body.system, true);
}

type AMsg = z.infer<typeof AMessage>;
type ABlockT = z.infer<typeof ABlock>;

const textOf = (c: string | z.infer<typeof AToolResult>['content']): string =>
  c === undefined
    ? ''
    : typeof c === 'string'
      ? c
      : c.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');

function flattenAnthropic(
  p: z.infer<typeof AnthropicRequestSchema>,
): Pick<PassthroughRequest, 'chat' | 'images'> & { system: string | undefined } {
  const messages: ChatMessage[] = [];
  const toolNames = new Map<string, string>();
  let images = 0;
  const countImages = (blocks: readonly { type: string }[]) => {
    for (const b of blocks) if (b.type === 'image') images++;
  };
  for (const m of p.messages as AMsg[]) {
    if (typeof m.content === 'string') {
      messages.push(
        m.role === 'user'
          ? { role: 'user', content: m.content }
          : { role: 'assistant', content: m.content },
      );
      continue;
    }
    const text: string[] = [];
    const calls: ToolCall[] = [];
    const results: ChatMessage[] = [];
    countImages(m.content);
    for (const b of m.content as ABlockT[]) {
      switch (b.type) {
        case 'text':
          text.push(b.text);
          break;
        case 'thinking':
          text.push(b.thinking, b.signature);
          break;
        case 'redacted_thinking':
          text.push(b.data);
          break;
        case 'tool_use':
          toolNames.set(b.id, b.name);
          calls.push({ id: b.id, name: b.name, args: b.input });
          break;
        case 'tool_result': {
          if (Array.isArray(b.content)) countImages(b.content);
          results.push({
            role: 'tool',
            toolCallId: b.tool_use_id,
            name: toolNames.get(b.tool_use_id) ?? 'tool',
            content: textOf(b.content),
            ...(b.is_error ? { isError: true } : {}),
          });
          break;
        }
        default:
          break;
      }
    }
    messages.push(...results);
    if (m.role === 'user') {
      if (text.length || results.length === 0)
        messages.push({ role: 'user', content: text.join('\n') });
    } else {
      messages.push({
        role: 'assistant',
        content: text.join('\n'),
        ...(calls.length ? { toolCalls: calls } : {}),
      });
    }
  }
  const system =
    p.system === undefined
      ? undefined
      : typeof p.system === 'string'
        ? p.system
        : p.system.map((b) => b.text).join('\n');
  const chat: ChatRequest = {
    model: p.model,
    messages,
    ...(system ? { system } : {}),
    ...(p.tools?.length
      ? {
          tools: p.tools.map((t) => ({
            name: t.name,
            ...(t.description ? { description: t.description } : {}),
            inputSchema: t.input_schema,
          })),
        }
      : {}),
    ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
  };
  return { chat, images, system };
}

/**
 * Parses an Anthropic Messages request body (already JSON-parsed by the strict parser). Throws
 * `PassthroughRequestError` for a refused or malformed request.
 */
export function parseAnthropicRequest(body: unknown): PassthroughRequest {
  prescanAnthropic(body);
  const p = parseWith(AnthropicRequestSchema, body);
  if (p.stream !== true && p.thinking?.type === 'enabled')
    refused('thinking requires stream: true');
  const { chat, images } = flattenAnthropic(p);
  if (images > PASSTHROUGH_LIMITS.maxImages) refused('too many images');
  const extra = JSON.stringify([p.tool_choice, p.stop_sequences, p.thinking]);
  return {
    surface: 'anthropic',
    model: p.model,
    stream: p.stream === true,
    includeUsage: true,
    requestedMaxTokens: p.max_tokens,
    chat,
    images,
    extraBytes: Buffer.byteLength(extra),
    build(maxTokens) {
      const thinking =
        p.thinking?.type === 'enabled'
          ? // The thinking budget must stay below the (possibly clamped) output bound.
            {
              type: 'enabled' as const,
              budget_tokens: Math.min(p.thinking.budget_tokens, Math.max(1, maxTokens - 1)),
            }
          : p.thinking;
      return {
        model: p.model,
        max_tokens: maxTokens,
        messages: p.messages.map((m) => ({
          role: m.role,
          content:
            typeof m.content === 'string'
              ? m.content
              : (m.content as ABlockT[]).map((b) => ({ ...b })),
        })),
        ...(p.system !== undefined
          ? { system: typeof p.system === 'string' ? p.system : p.system.map((b) => ({ ...b })) }
          : {}),
        ...(p.tools?.length
          ? {
              tools: p.tools.map((t) => ({
                name: t.name,
                description: t.description ?? '',
                input_schema: { type: 'object', ...t.input_schema },
                ...(t.cache_control ? { cache_control: t.cache_control } : {}),
              })),
            }
          : {}),
        ...(p.tool_choice ? { tool_choice: p.tool_choice } : {}),
        ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
        ...(p.top_p !== undefined ? { top_p: p.top_p } : {}),
        ...(p.top_k !== undefined ? { top_k: p.top_k } : {}),
        ...(p.stop_sequences?.length ? { stop_sequences: [...p.stop_sequences] } : {}),
        ...(thinking ? { thinking } : {}),
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// OpenAI Chat Completions
// ---------------------------------------------------------------------------------------------

const DATA_URI = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=_-]+$/;
const OText = z.strictObject({ type: z.literal('text'), text: Text });
const OImage = z.strictObject({
  type: z.literal('image_url'),
  image_url: z.strictObject({
    url: z
      .string()
      .max(PASSTHROUGH_LIMITS.maxImageBytes + 64)
      .regex(DATA_URI, 'only data: image URIs are accepted'),
    detail: z.enum(['auto', 'low', 'high']).optional(),
  }),
});
const OTextContent = z.union([Text, z.array(OText).max(256)]);
const OToolCall = z.strictObject({
  id: Id,
  type: z.literal('function'),
  function: z.strictObject({ name: ToolName, arguments: Text }),
});
const OMessage = z.discriminatedUnion('role', [
  z.strictObject({
    role: z.enum(['system', 'developer']),
    content: OTextContent,
    name: z.string().max(64).optional(),
  }),
  z.strictObject({
    role: z.literal('user'),
    content: z.union([Text, z.array(z.discriminatedUnion('type', [OText, OImage])).max(256)]),
    name: z.string().max(64).optional(),
  }),
  z.strictObject({
    role: z.literal('assistant'),
    content: OTextContent.nullable().optional(),
    tool_calls: z.array(OToolCall).max(PASSTHROUGH_LIMITS.maxToolCalls).optional(),
    refusal: Text.nullable().optional(),
    name: z.string().max(64).optional(),
  }),
  z.strictObject({ role: z.literal('tool'), tool_call_id: Id, content: OTextContent }),
]);
const OTool = z.strictObject({
  type: z.literal('function'),
  function: z.strictObject({
    name: ToolName,
    description: Text.optional(),
    parameters: ToolSchema.optional(),
    strict: z.boolean().nullable().optional(),
  }),
});
const OToolChoice = z.union([
  z.enum(['none', 'auto', 'required']),
  z.strictObject({ type: z.literal('function'), function: z.strictObject({ name: ToolName }) }),
]);
const OResponseFormat = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text') }),
  z.strictObject({ type: z.literal('json_object') }),
  z.strictObject({
    type: z.literal('json_schema'),
    json_schema: z.strictObject({
      name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
      description: Text.optional(),
      schema: JsonObject.optional(),
      strict: z.boolean().nullable().optional(),
    }),
  }),
]);
const OpenAIRequestSchema = z.strictObject({
  model: z.string().min(1).max(200),
  messages: z.array(OMessage).min(1).max(MODEL_PROXY_LIMITS.maxMessages),
  tools: z.array(OTool).max(MODEL_PROXY_LIMITS.maxTools).optional(),
  tool_choice: OToolChoice.optional(),
  parallel_tool_calls: z.boolean().optional(),
  max_tokens: z.number().int().positive().nullable().optional(),
  max_completion_tokens: z.number().int().positive().nullable().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stop: z
    .union([StopSequence, z.array(StopSequence).max(PASSTHROUGH_LIMITS.maxStopSequences)])
    .nullable()
    .optional(),
  seed: z.number().int().optional(),
  n: z.number().int().optional(),
  response_format: OResponseFormat.optional(),
  reasoning_effort: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
  stream: z.boolean().optional(),
  // Overwritten by the transport (usage is always requested upstream); only `include_usage` is read.
  stream_options: z.strictObject({ include_usage: z.boolean().optional() }).nullable().optional(),
  // Accepted and dropped: the proxy never forwards client identifiers.
  user: z.string().max(256).optional(),
});

const O_PART_TYPES = new Set(['text', 'image_url']);

function prescanOpenAI(body: unknown): void {
  if (!isObj(body)) return;
  if (Array.isArray(body.tools)) {
    for (const t of body.tools) {
      if (isObj(t) && t.type !== 'function') refused(`tool type not allowed: ${safeName(t.type)}`);
    }
  }
  if (body.n !== undefined && body.n !== 1) refused('parameter not allowed: n');
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (!isObj(m) || !Array.isArray(m.content)) continue;
      for (const part of m.content) {
        if (isObj(part) && typeof part.type === 'string' && !O_PART_TYPES.has(part.type))
          refused(`content part type not allowed: ${safeName(part.type)}`);
        if (
          isObj(part) &&
          part.type === 'image_url' &&
          isObj(part.image_url) &&
          typeof part.image_url.url === 'string' &&
          !part.image_url.url.startsWith('data:')
        )
          refused('image_url must be a data: URI');
      }
    }
  }
  const rf = isObj(body.response_format) ? body.response_format : undefined;
  if (rf && rf.type === 'json_schema' && isObj(rf.json_schema)) {
    if (JSON.stringify(rf.json_schema).length > PASSTHROUGH_LIMITS.maxResponseFormatBytes)
      refused('response_format is too large');
  }
}

const oText = (c: z.infer<typeof OTextContent> | null | undefined): string =>
  c === null || c === undefined ? '' : typeof c === 'string' ? c : c.map((p) => p.text).join('\n');

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw);
    if (isObj(v) && !hasUnsafeJson(v)) return v;
  } catch {
    // not JSON: kept as raw text below
  }
  return { _raw: raw };
}

/** Parses an OpenAI Chat Completions request body. */
export function parseOpenAIRequest(body: unknown): PassthroughRequest {
  prescanOpenAI(body);
  const p = parseWith(OpenAIRequestSchema, body);
  const messages: ChatMessage[] = [];
  const toolNames = new Map<string, string>();
  const systems: string[] = [];
  let images = 0;
  for (const m of p.messages) {
    switch (m.role) {
      case 'system':
      case 'developer':
        systems.push(oText(m.content));
        break;
      case 'user': {
        if (typeof m.content === 'string') messages.push({ role: 'user', content: m.content });
        else {
          images += m.content.filter((x) => x.type === 'image_url').length;
          messages.push({
            role: 'user',
            content: m.content.flatMap((x) => (x.type === 'text' ? [x.text] : [])).join('\n'),
          });
        }
        break;
      }
      case 'assistant': {
        const calls: ToolCall[] = (m.tool_calls ?? []).map((c) => {
          toolNames.set(c.id, c.function.name);
          return { id: c.id, name: c.function.name, args: parseArgs(c.function.arguments) };
        });
        messages.push({
          role: 'assistant',
          content: [oText(m.content), m.refusal ?? ''].filter(Boolean).join('\n'),
          ...(calls.length ? { toolCalls: calls } : {}),
        });
        break;
      }
      case 'tool':
        messages.push({
          role: 'tool',
          toolCallId: m.tool_call_id,
          name: toolNames.get(m.tool_call_id) ?? 'tool',
          content: oText(m.content),
        });
        break;
    }
  }
  if (images > PASSTHROUGH_LIMITS.maxImages) refused('too many images');
  const stream = p.stream === true;
  const system = systems.join('\n');
  const chat: ChatRequest = {
    model: p.model,
    messages,
    ...(system ? { system } : {}),
    ...(p.tools?.length
      ? {
          tools: p.tools.map((t) => ({
            name: t.function.name,
            ...(t.function.description ? { description: t.function.description } : {}),
            inputSchema: t.function.parameters ?? {},
          })),
        }
      : {}),
    ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
  };
  const requested = p.max_completion_tokens ?? p.max_tokens ?? undefined;
  const extra = JSON.stringify([p.tool_choice, p.stop, p.response_format]);
  return {
    surface: 'openai',
    model: p.model,
    stream,
    includeUsage: p.stream_options?.include_usage === true,
    requestedMaxTokens: requested,
    chat,
    images,
    extraBytes: Buffer.byteLength(extra),
    build(maxTokens, opts = {}) {
      const param = opts.maxTokensParam ?? 'max_tokens';
      return {
        model: p.model,
        messages: p.messages.map((m) => {
          switch (m.role) {
            case 'system':
            case 'developer':
              // Not every endpoint knows the `developer` role; `system` is understood by all.
              return { role: 'system', content: m.content };
            case 'assistant':
              return {
                role: 'assistant',
                content: m.content ?? null,
                ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}),
                ...(m.refusal ? { refusal: m.refusal } : {}),
              };
            case 'user':
              return { role: 'user', content: m.content };
            case 'tool':
              return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
          }
        }),
        ...(p.tools?.length
          ? {
              tools: p.tools.map((t) => ({
                type: 'function',
                function: {
                  name: t.function.name,
                  ...(t.function.description ? { description: t.function.description } : {}),
                  ...(t.function.parameters ? { parameters: t.function.parameters } : {}),
                  ...(t.function.strict !== undefined && t.function.strict !== null
                    ? { strict: t.function.strict }
                    : {}),
                },
              })),
            }
          : {}),
        ...(p.tool_choice !== undefined ? { tool_choice: p.tool_choice } : {}),
        ...(p.parallel_tool_calls !== undefined
          ? { parallel_tool_calls: p.parallel_tool_calls }
          : {}),
        [param]: maxTokens,
        ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
        ...(p.top_p !== undefined ? { top_p: p.top_p } : {}),
        ...(p.stop !== undefined && p.stop !== null ? { stop: p.stop } : {}),
        ...(p.seed !== undefined ? { seed: p.seed } : {}),
        ...(p.response_format ? { response_format: p.response_format } : {}),
        ...(p.reasoning_effort ? { reasoning_effort: p.reasoning_effort } : {}),
      };
    },
  };
}
