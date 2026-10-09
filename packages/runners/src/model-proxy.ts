import { OaxError, type Classification } from '@openagentix/core';
import type {
  ChatRequest,
  ChatResponse,
  CompleteOptions,
  ModelProvider,
  ProviderKind,
  WorkerModelRequest,
  WorkerModelResponse,
} from '@openagentix/providers';

/**
 * Client side of the control node's model proxy (ADR 0009): a run node calls models only through
 * `POST /v1/worker/runs/{id}/model`. Provider keys, egress and air-gapped rules, token usage and
 * cost stay on the control node; an untrusted node can neither read a provider key nor misreport
 * usage.
 */
export interface ModelProxyClient {
  modelCall(
    runId: string,
    req: WorkerModelRequest,
    opts?: CompleteOptions,
  ): Promise<WorkerModelResponse>;
}

export interface ModelProxyProviderOptions {
  /** Provider name of the step (as published). */
  name: string;
  runId: string;
  /** The step this node runs; the proxy checks it against the token. */
  agentId: string;
  client: ModelProxyClient;
  /** Adapter kind, for display only; the proxy resolves the real provider. */
  kind?: ProviderKind;
}

/**
 * The only model provider of a run node. Every call goes to the control node, which resolves the
 * provider, reserves the worst-case cost, forwards the call and records it (`metered`).
 */
export class ModelProxyProvider implements ModelProvider {
  readonly name: string;
  readonly kind: ProviderKind;
  /** The proxy enforces the classification check; the node cannot know the provider's clearance. */
  readonly clearance: Classification = 'restricted';
  readonly metered = true;

  constructor(private readonly opts: ModelProxyProviderOptions) {
    this.name = opts.name;
    this.kind = opts.kind ?? 'openai';
  }

  async complete(req: ChatRequest, opts: CompleteOptions = {}): Promise<ChatResponse> {
    // `simulation` is taken from the published definition on the control node, never from the node;
    // the wire schema is strict, so only the allowed fields are sent.
    const context = req.hints?.context;
    const res = await this.opts.client.modelCall(
      this.opts.runId,
      {
        agentId: this.opts.agentId,
        request: {
          model: req.model,
          ...(req.system !== undefined ? { system: req.system } : {}),
          messages: req.messages,
          ...(req.tools?.length ? { tools: req.tools } : {}),
          ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(context ? { hints: { context } } : {}),
        },
      },
      opts,
    );
    if (!res || typeof res !== 'object' || !res.response)
      throw new OaxError('model_proxy_invalid', 'the model proxy answered with an unusable body');
    const { cacheReadTokens, cacheWriteTokens } = res.usage;
    return {
      text: res.response.text,
      toolCalls: res.response.toolCalls as ChatResponse['toolCalls'],
      usage: {
        inputTokens: res.usage.inputTokens,
        outputTokens: res.usage.outputTokens,
        ...(cacheReadTokens ? { cacheReadTokens } : {}),
        ...(cacheWriteTokens ? { cacheWriteTokens } : {}),
      },
      stopReason: res.response.stopReason,
      model: res.response.model,
      metered: {
        callId: res.callId,
        costMicros: res.costMicros,
        priced: res.priced,
        remaining: res.remaining,
      },
    };
  }
}
