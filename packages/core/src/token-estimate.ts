/**
 * Pure token estimators for the model proxy (ADR 0009, sections 4.1 and 4.3). No tokenizer
 * dependency: the reservation bound relies on the fact that a byte-level BPE tokenizer never
 * produces more tokens than UTF-8 bytes, so the byte length of everything the provider will
 * tokenise (plus fixed overheads) is a true upper bound for text.
 */

/** Tokens added per message for role markers and separators (generous on purpose). */
export const MESSAGE_OVERHEAD_TOKENS = 16;
/** Tokens added per tool definition (wrapper text of the provider's tool prompt). */
export const TOOL_OVERHEAD_TOKENS = 32;
/** Fixed per-request overhead (system wrapper, tool preamble, framing). */
export const REQUEST_OVERHEAD_TOKENS = 64;
/** Fallback upper bound per image when the catalog has none. */
export const DEFAULT_IMAGE_TOKENS = 6000;

export interface EstimateToolCall {
  id: string;
  name: string;
  args: unknown;
}

/** Structural subset of `ChatRequest` (packages/providers), so a `ChatRequest` is assignable. */
export interface EstimateRequest {
  system?: string;
  messages: ReadonlyArray<{
    role: string;
    content: string;
    toolCallId?: string;
    name?: string;
    toolCalls?: readonly EstimateToolCall[];
  }>;
  tools?: ReadonlyArray<{ name: string; description?: string; inputSchema: unknown }>;
}

export interface EstimateLimits {
  /** Model context window from the catalog; the bound is clamped to it. */
  contextTokens?: number | null;
  /** Upper bound per image; defaults to {@link DEFAULT_IMAGE_TOKENS}. */
  imageTokens?: number | null;
  /** Number of images in the request. */
  images?: number;
  /** Multiplier for models whose tokenizer is not byte-level BPE (connection `tokenBoundFactor`, >= 1). */
  tokenBoundFactor?: number;
}

const encoder = new TextEncoder();

/** UTF-8 byte length of a string. */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

function jsonBytes(value: unknown): number {
  const text = JSON.stringify(value);
  return text === undefined ? 0 : utf8Bytes(text);
}

/**
 * Upper bound of the input tokens of a request. Counts every string the provider can tokenise:
 * system, message contents, tool call names/ids/arguments, tool result names/ids, tool names,
 * descriptions and serialized schemas. A non-finite or sub-1 `tokenBoundFactor` is treated as 1
 * (the bound is never lowered).
 */
export function estimateInputUpperBound(
  request: EstimateRequest,
  limits: EstimateLimits = {},
): number {
  let bytes = request.system ? utf8Bytes(request.system) : 0;
  for (const m of request.messages) {
    bytes += utf8Bytes(m.role) + utf8Bytes(m.content);
    if (m.toolCallId) bytes += utf8Bytes(m.toolCallId);
    if (m.name) bytes += utf8Bytes(m.name);
    for (const c of m.toolCalls ?? [])
      bytes += utf8Bytes(c.id) + utf8Bytes(c.name) + jsonBytes(c.args);
  }
  for (const t of request.tools ?? [])
    bytes += utf8Bytes(t.name) + utf8Bytes(t.description ?? '') + jsonBytes(t.inputSchema);
  const factor =
    limits.tokenBoundFactor !== undefined && Number.isFinite(limits.tokenBoundFactor)
      ? Math.max(1, limits.tokenBoundFactor)
      : 1;
  const images = Math.max(0, Math.floor(limits.images ?? 0));
  const perImage =
    limits.imageTokens && limits.imageTokens > 0 ? limits.imageTokens : DEFAULT_IMAGE_TOKENS;
  const overhead =
    REQUEST_OVERHEAD_TOKENS +
    request.messages.length * MESSAGE_OVERHEAD_TOKENS +
    (request.tools?.length ?? 0) * TOOL_OVERHEAD_TOKENS;
  const bound = Math.ceil(bytes * factor) + overhead + images * perImage;
  const context = limits.contextTokens;
  return context && context > 0 ? Math.min(bound, context) : bound;
}

/** Fallback output estimate when the provider reports no usage: `ceil(bytes / 3)`. */
export function estimateOutputTokens(text: string): number {
  return Math.ceil(utf8Bytes(text) / 3);
}

/** Lower bound against endpoints that under-report: `ceil(bytes / 8)` (honest providers exceed it). */
export function outputFloor(text: string): number {
  return Math.ceil(utf8Bytes(text) / 8);
}
