import type { Classification } from '@openagentix/core';
import { createGuardedFetch, parseToolArgs, postJson, type FetchLike } from './http.js';
import type {
  ChatRequest,
  ChatResponse,
  CompleteOptions,
  ModelProvider,
  StopReason,
} from './types.js';

export interface OpenAICompatibleOptions {
  name: string;
  /** e.g. https://api.openai.com/v1, http://vllm:8000/v1, Azure deployment URL. */
  baseUrl: string;
  apiKey?: string | undefined;
  /** Extra headers, e.g. `{ "api-key": "..." }` for Azure OpenAI. */
  headers?: Record<string, string> | undefined;
  /** Extra query string, e.g. `api-version=2024-10-21` for Azure OpenAI. */
  query?: string | undefined;
  /**
   * Azure OpenAI: requests go to `<baseUrl>/openai/deployments/<deployment>/chat/completions`.
   * Without a fixed `deployment` the agent's `model` is the deployment name.
   */
  azure?: { apiVersion: string; deployment?: string | undefined } | undefined;
  /** Newer OpenAI models reject `max_tokens`; most compatible servers still expect it. */
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens' | undefined;
  /** Registry metadata (provider family and catalog id for price lookups). */
  family?: string | undefined;
  catalogProvider?: string | undefined;
  clearance?: Classification;
  proxyUrl?: string | undefined;
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
  fetchImpl?: FetchLike | undefined;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAIResponse {
  model?: string;
  choices: {
    message: { content: string | null; tool_calls?: OpenAIToolCall[] };
    finish_reason: string;
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

const FINISH: Record<string, StopReason> = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  length: 'max_tokens',
  content_filter: 'refusal',
};

/** Covers OpenAI, Azure OpenAI, vLLM, LM Studio and other `/chat/completions` servers. */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly kind = 'openai' as const;
  readonly name: string;
  readonly clearance: Classification;
  readonly family: string;
  readonly catalogProvider: string | undefined;
  private readonly fetch: FetchLike;

  constructor(private readonly opts: OpenAICompatibleOptions) {
    this.name = opts.name;
    this.clearance = opts.clearance ?? 'internal';
    this.family = opts.family ?? 'openai';
    this.catalogProvider = opts.catalogProvider;
    this.fetch = createGuardedFetch({
      allowedOrigins: [opts.baseUrl],
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
          content: m.content || null,
          ...(m.toolCalls?.length
            ? {
                tool_calls: m.toolCalls.map((c) => ({
                  id: c.id,
                  type: 'function',
                  function: { name: c.name, arguments: JSON.stringify(c.args) },
                })),
              }
            : {}),
        });
      } else messages.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    }
    const body: Record<string, unknown> = { model: req.model, messages };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description ?? '', parameters: t.inputSchema },
      }));
    }
    if (req.maxTokens !== undefined) body[this.opts.maxTokensParam ?? 'max_tokens'] = req.maxTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    return body;
  }

  async complete(req: ChatRequest, opts: CompleteOptions = {}): Promise<ChatResponse> {
    const base = this.opts.baseUrl.replace(/\/$/, '');
    const azure = this.opts.azure;
    const path = azure
      ? `/openai/deployments/${encodeURIComponent(azure.deployment ?? req.model)}/chat/completions`
      : '/chat/completions';
    const query = [
      azure ? `api-version=${encodeURIComponent(azure.apiVersion)}` : '',
      this.opts.query ?? '',
    ]
      .filter(Boolean)
      .join('&');
    const url = `${base}${path}${query ? `?${query}` : ''}`;
    const headers: Record<string, string> = { ...this.opts.headers };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    const res = await postJson<OpenAIResponse>(this.fetch, url, this.toRequestBody(req), {
      headers,
      signal: opts.signal,
      timeoutMs: this.opts.timeoutMs,
      maxRetries: this.opts.maxRetries,
    });
    const choice = res.choices[0];
    return {
      text: choice?.message.content ?? '',
      toolCalls: (choice?.message.tool_calls ?? []).map((c) => ({
        id: c.id,
        name: c.function.name,
        args: parseToolArgs(c.function.arguments),
      })),
      usage: {
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
      },
      stopReason: FINISH[choice?.finish_reason ?? ''] ?? 'other',
      model: res.model ?? req.model,
    };
  }
}
