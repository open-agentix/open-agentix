import type { Classification } from '@openagentix/core';
import { createGuardedFetch, parseToolArgs, postJson, type FetchLike } from './http.js';
import type { ChatRequest, ChatResponse, CompleteOptions, ModelProvider } from './types.js';

export interface OllamaOptions {
  name: string;
  baseUrl?: string;
  clearance?: Classification;
  proxyUrl?: string | undefined;
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
  fetchImpl?: FetchLike | undefined;
}

interface OllamaResponse {
  model?: string;
  message: { content?: string; tool_calls?: { function: { name: string; arguments: unknown } }[] };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

/** Ollama `/api/chat` (non-streaming). Local models default to clearance `restricted`. */
export class OllamaProvider implements ModelProvider {
  readonly kind = 'ollama' as const;
  readonly family = 'ollama';
  readonly catalogProvider = 'ollama';
  readonly name: string;
  readonly clearance: Classification;
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;

  constructor(private readonly opts: OllamaOptions) {
    this.name = opts.name;
    this.baseUrl = (opts.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '');
    this.clearance = opts.clearance ?? 'restricted';
    this.fetch = createGuardedFetch({
      allowedOrigins: [this.baseUrl],
      proxyUrl: opts.proxyUrl,
      fetchImpl: opts.fetchImpl,
    });
  }

  toRequestBody(req: ChatRequest): Record<string, unknown> {
    const messages: unknown[] = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    for (const m of req.messages) {
      if (m.role === 'user') messages.push({ role: 'user', content: m.content });
      else if (m.role === 'assistant') {
        messages.push({
          role: 'assistant',
          content: m.content,
          ...(m.toolCalls?.length
            ? {
                tool_calls: m.toolCalls.map((c) => ({
                  function: { name: c.name, arguments: c.args },
                })),
              }
            : {}),
        });
      } else messages.push({ role: 'tool', content: m.content, tool_name: m.name });
    }
    const options: Record<string, unknown> = {};
    if (req.temperature !== undefined) options.temperature = req.temperature;
    if (req.maxTokens !== undefined) options.num_predict = req.maxTokens;
    return {
      model: req.model,
      messages,
      stream: false,
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              type: 'function',
              function: {
                name: t.name,
                description: t.description ?? '',
                parameters: t.inputSchema,
              },
            })),
          }
        : {}),
      ...(Object.keys(options).length ? { options } : {}),
    };
  }

  async complete(req: ChatRequest, opts: CompleteOptions = {}): Promise<ChatResponse> {
    const res = await postJson<OllamaResponse>(
      this.fetch,
      `${this.baseUrl}/api/chat`,
      this.toRequestBody(req),
      {
        signal: opts.signal,
        timeoutMs: this.opts.timeoutMs,
        maxRetries: this.opts.maxRetries,
      },
    );
    const toolCalls = (res.message.tool_calls ?? []).map((c, i) => ({
      id: `call_${i}`,
      name: c.function.name,
      args: parseToolArgs(c.function.arguments),
    }));
    return {
      text: res.message.content ?? '',
      toolCalls,
      usage: { inputTokens: res.prompt_eval_count ?? 0, outputTokens: res.eval_count ?? 0 },
      stopReason:
        toolCalls.length > 0
          ? 'tool_use'
          : res.done_reason === 'length'
            ? 'max_tokens'
            : 'end_turn',
      model: res.model ?? req.model,
    };
  }
}
