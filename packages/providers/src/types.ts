import type { Classification, SimulatedResponse } from '@openagentix/core';

export const PROVIDER_KINDS = ['openai', 'ollama', 'anthropic', 'bedrock', 'simulated'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export interface ToolSpec {
  /** Model-facing tool name (`^[a-zA-Z0-9_-]{1,64}$`). */
  name: string;
  description?: string;
  /** JSON Schema of the arguments. */
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError?: boolean };

export interface ChatRequest {
  model: string;
  system?: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
  /** Provider specific hints; real providers ignore them. */
  hints?: {
    simulation?: readonly SimulatedResponse[];
    /** Values available to `{{path}}` templates of simulated responses. */
    context?: Record<string, unknown>;
  };
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Prompt cache tokens, when the provider reports them (priced separately). */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  stopReason: StopReason;
  model: string;
}

export interface CompleteOptions {
  signal?: AbortSignal;
}

/** One interface for every LLM backend. */
export interface ModelProvider {
  readonly name: string;
  readonly kind: ProviderKind;
  /** Configured provider family (`azure-openai`, `openrouter`, `vllm`, ...); defaults to `kind`. */
  readonly family?: string;
  /** Model catalog provider id used for price lookups when no price exists under `name`. */
  readonly catalogProvider?: string;
  /** Highest data classification that may be sent to this provider. */
  readonly clearance: Classification;
  complete(req: ChatRequest, opts?: CompleteOptions): Promise<ChatResponse>;
}
