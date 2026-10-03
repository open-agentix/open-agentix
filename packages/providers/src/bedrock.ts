import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type Message,
} from '@aws-sdk/client-bedrock-runtime';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { Classification } from '@openagentix/core';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type {
  ChatRequest,
  ChatResponse,
  CompleteOptions,
  ModelProvider,
  StopReason,
} from './types.js';

/** Minimal client surface used by the adapter (injectable for tests). */
export interface BedrockConverseClient {
  send(
    command: ConverseCommand,
    options?: { abortSignal?: AbortSignal | undefined },
  ): Promise<ConverseCommandOutput>;
}

export interface BedrockOptions {
  name: string;
  region: string;
  /**
   * Custom endpoint, e.g. a VPC interface endpoint
   * `https://vpce-0abc-xyz.bedrock-runtime.eu-central-1.vpce.amazonaws.com`.
   */
  endpoint?: string | undefined;
  /** HTTPS proxy for environments without direct egress. */
  proxyUrl?: string | undefined;
  clearance?: Classification;
  maxAttempts?: number | undefined;
  client?: BedrockConverseClient | undefined;
}

const STOP: Record<string, StopReason> = {
  end_turn: 'end_turn',
  stop_sequence: 'end_turn',
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
  guardrail_intervened: 'refusal',
  content_filtered: 'refusal',
};

/**
 * Builds the SDK client. Credentials use the AWS default provider chain, so IRSA
 * (AWS_WEB_IDENTITY_TOKEN_FILE + AWS_ROLE_ARN), ECS/EC2 roles, SSO and env vars work unchanged.
 */
export function createBedrockClient(
  opts: Pick<BedrockOptions, 'region' | 'endpoint' | 'proxyUrl' | 'maxAttempts'>,
): BedrockRuntimeClient {
  return new BedrockRuntimeClient({
    region: opts.region,
    ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    ...(opts.maxAttempts ? { maxAttempts: opts.maxAttempts } : {}),
    ...(opts.proxyUrl
      ? { requestHandler: new NodeHttpHandler({ httpsAgent: new HttpsProxyAgent(opts.proxyUrl) }) }
      : {}),
  });
}

/** AWS Bedrock via the Converse API (works for Anthropic, Amazon, Meta, Mistral models). */
export class BedrockProvider implements ModelProvider {
  readonly kind = 'bedrock' as const;
  readonly name: string;
  readonly clearance: Classification;
  private readonly client: BedrockConverseClient;

  constructor(opts: BedrockOptions) {
    this.name = opts.name;
    this.clearance = opts.clearance ?? 'confidential';
    this.client = opts.client ?? createBedrockClient(opts);
  }

  toCommandInput(req: ChatRequest): ConverseCommandInput {
    const messages: Message[] = [];
    for (const m of req.messages) {
      if (m.role === 'user') messages.push({ role: 'user', content: [{ text: m.content }] });
      else if (m.role === 'assistant') {
        const content: ContentBlock[] = [];
        if (m.content) content.push({ text: m.content });
        for (const c of m.toolCalls ?? []) {
          content.push({ toolUse: { toolUseId: c.id, name: c.name, input: c.args as never } });
        }
        messages.push({ role: 'assistant', content });
      } else {
        const block: ContentBlock = {
          toolResult: {
            toolUseId: m.toolCallId,
            content: [{ text: m.content }],
            status: m.isError ? 'error' : 'success',
          },
        };
        const last = messages.at(-1);
        if (last?.role === 'user' && last.content?.every((b) => 'toolResult' in b && b.toolResult))
          last.content.push(block);
        else messages.push({ role: 'user', content: [block] });
      }
    }
    const input: ConverseCommandInput = { modelId: req.model, messages };
    if (req.system) input.system = [{ text: req.system }];
    const inference: NonNullable<ConverseCommandInput['inferenceConfig']> = {};
    if (req.maxTokens !== undefined) inference.maxTokens = req.maxTokens;
    if (req.temperature !== undefined) inference.temperature = req.temperature;
    if (Object.keys(inference).length) input.inferenceConfig = inference;
    if (req.tools?.length) {
      input.toolConfig = {
        tools: req.tools.map((t) => ({
          toolSpec: {
            name: t.name,
            description: t.description ?? t.name,
            inputSchema: { json: t.inputSchema as never },
          },
        })),
      };
    }
    return input;
  }

  async complete(req: ChatRequest, opts: CompleteOptions = {}): Promise<ChatResponse> {
    const out = await this.client.send(new ConverseCommand(this.toCommandInput(req)), {
      abortSignal: opts.signal,
    });
    let text = '';
    const toolCalls: ChatResponse['toolCalls'] = [];
    for (const b of out.output?.message?.content ?? []) {
      if (b.text) text += b.text;
      if (b.toolUse) {
        toolCalls.push({
          id: b.toolUse.toolUseId ?? `call_${toolCalls.length}`,
          name: b.toolUse.name ?? '',
          args: (b.toolUse.input ?? {}) as Record<string, unknown>,
        });
      }
    }
    return {
      text,
      toolCalls,
      usage: {
        inputTokens: out.usage?.inputTokens ?? 0,
        outputTokens: out.usage?.outputTokens ?? 0,
      },
      stopReason: STOP[out.stopReason ?? ''] ?? 'other',
      model: req.model,
    };
  }
}
