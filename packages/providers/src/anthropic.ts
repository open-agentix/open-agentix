import Anthropic from '@anthropic-ai/sdk';
import type { Classification } from '@openagentix/core';
import { createGuardedFetch, type FetchLike, type GuardedFetchOptions } from './http.js';
import type {
  ChatRequest,
  ChatResponse,
  CompleteOptions,
  ModelProvider,
  StopReason,
} from './types.js';

/** Minimal surface of the Anthropic SDK client that the adapter uses (injectable for tests). */
export interface AnthropicMessagesClient {
  messages: {
    create(
      body: Anthropic.MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal | undefined },
    ): PromiseLike<Anthropic.Message>;
  };
}

export interface AnthropicOptions {
  name: string;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  clearance?: Classification;
  proxyUrl?: string | undefined;
  outbound?: GuardedFetchOptions['outbound'];
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
  /** Default max output tokens when the agent does not set one. */
  defaultMaxTokens?: number | undefined;
  client?: AnthropicMessagesClient | undefined;
  fetchImpl?: FetchLike | undefined;
}

const STOP: Record<string, StopReason> = {
  end_turn: 'end_turn',
  stop_sequence: 'end_turn',
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
  refusal: 'refusal',
};

/**
 * Builds the Messages API body of a chat request. Pure: shared by the non-streaming adapter and the
 * streaming proxy transports (no network, no key).
 */
export function toAnthropicBody(
  req: ChatRequest,
  defaultMaxTokens?: number | undefined,
): Anthropic.MessageCreateParamsNonStreaming {
  const messages: Anthropic.MessageParam[] = [];
  for (const m of req.messages) {
    if (m.role === 'user') {
      messages.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const content: Anthropic.ContentBlockParam[] = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls ?? [])
        content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
      messages.push({ role: 'assistant', content });
    } else {
      const block: Anthropic.ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: m.content,
        ...(m.isError ? { is_error: true } : {}),
      };
      // All tool results of one turn go into a single user message.
      const last = messages.at(-1);
      if (last && last.role === 'user' && Array.isArray(last.content)) last.content.push(block);
      else messages.push({ role: 'user', content: [block] });
    }
  }
  const body: Anthropic.MessageCreateParamsNonStreaming = {
    model: req.model,
    max_tokens: req.maxTokens ?? defaultMaxTokens ?? 16_000,
    messages,
  };
  if (req.system) body.system = req.system;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: { type: 'object', ...t.inputSchema } as Anthropic.Tool.InputSchema,
    }));
  }
  return body;
}

/** Anthropic Messages API via the official SDK; network goes through the guarded fetch. */
export class AnthropicProvider implements ModelProvider {
  readonly kind = 'anthropic' as const;
  readonly name: string;
  readonly clearance: Classification;
  readonly family = 'anthropic';
  readonly catalogProvider = 'anthropic';
  private readonly client: AnthropicMessagesClient;

  constructor(private readonly opts: AnthropicOptions) {
    this.name = opts.name;
    this.clearance = opts.clearance ?? 'internal';
    const baseURL = opts.baseUrl ?? 'https://api.anthropic.com';
    this.client =
      opts.client ??
      new Anthropic({
        apiKey: opts.apiKey ?? null,
        baseURL,
        timeout: opts.timeoutMs ?? 600_000,
        maxRetries: opts.maxRetries ?? 2,
        fetch: createGuardedFetch({
          allowedOrigins: [baseURL],
          proxyUrl: opts.proxyUrl,
          outbound: opts.outbound,
          fetchImpl: opts.fetchImpl,
        }) as unknown as typeof fetch,
      });
  }

  toRequestBody(req: ChatRequest): Anthropic.MessageCreateParamsNonStreaming {
    return toAnthropicBody(req, this.opts.defaultMaxTokens);
  }

  async complete(req: ChatRequest, opts: CompleteOptions = {}): Promise<ChatResponse> {
    const res = await this.client.messages.create(this.toRequestBody(req), { signal: opts.signal });
    let text = '';
    const toolCalls: ChatResponse['toolCalls'] = [];
    for (const block of res.content) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          args: (block.input ?? {}) as Record<string, unknown>,
        });
      }
    }
    return {
      text,
      toolCalls,
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
      stopReason: STOP[res.stop_reason ?? ''] ?? 'other',
      model: res.model,
    };
  }
}
