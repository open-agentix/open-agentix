import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type Message,
} from '@aws-sdk/client-bedrock-runtime';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { Transform, type Readable } from 'node:stream';
import type { Classification, NetworkPurpose, RouteScope } from '@openagentix/core';
import { ProviderError } from './http.js';
import { createOutboundDispatcher, type OutboundDispatcher } from './outbound.js';
import type { Env } from './proxy.js';
import { assertPublicDestination, type HostLookup } from './ssrf.js';
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
  /** Outbound dispatcher factory and scope (ADR 0011); default: legacy proxy environment. */
  outbound?:
    { dispatcher: OutboundDispatcher; purpose?: NetworkPurpose; scope?: RouteScope } | undefined;
  clearance?: Classification;
  maxAttempts?: number | undefined;
  /** Explicit credentials (BYOK); without them the AWS default provider chain applies. */
  credentials?:
    { accessKeyId: string; secretAccessKey: string; sessionToken?: string | undefined } | undefined;
  catalogProvider?: string | undefined;
  client?: BedrockConverseClient | undefined;
  /**
   * Tenant-controlled endpoint: refuse non-public destinations (checked before each request, and
   * pinned at connect time through a validating lookup) and bound the response size.
   * `allow` is the operator list (`OAX_MODEL_PROXY_PRIVATE_ALLOW`).
   */
  blockPrivateDestinations?: { allow?: readonly string[]; lookup?: HostLookup } | undefined;
  /** Largest response body (default 16 MiB) when `blockPrivateDestinations` is set. */
  maxResponseBytes?: number | undefined;
}

const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** NodeHttpHandler that fails the response body once it exceeds `max` bytes. */
class LimitedNodeHttpHandler extends NodeHttpHandler {
  constructor(
    opts: ConstructorParameters<typeof NodeHttpHandler>[0],
    private readonly max: number,
  ) {
    super(opts);
  }

  override async handle(
    ...args: Parameters<NodeHttpHandler['handle']>
  ): ReturnType<NodeHttpHandler['handle']> {
    const out = await super.handle(...args);
    const body = out.response.body as Readable | undefined;
    if (!body || typeof body.pipe !== 'function') return out;
    let seen = 0;
    const limit = new Transform({
      transform: (chunk: Buffer, _enc, cb) => {
        seen += chunk.byteLength;
        if (seen > this.max) cb(new ProviderError('provider response is too large', null, false));
        else cb(null, chunk);
      },
    });
    body.on('error', (e) => limit.destroy(e));
    out.response.body = body.pipe(limit);
    return out;
  }
}

/** Refuses a non-public Bedrock endpoint (call before each request). */
export async function assertBedrockDestination(
  opts: Pick<BedrockOptions, 'region' | 'endpoint' | 'blockPrivateDestinations'>,
): Promise<void> {
  if (!opts.blockPrivateDestinations) return;
  const target = opts.endpoint ?? `https://bedrock-runtime.${opts.region}.amazonaws.com`;
  await assertPublicDestination(new URL(target).hostname, opts.blockPrivateDestinations);
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
  opts: Pick<
    BedrockOptions,
    | 'region'
    | 'endpoint'
    | 'proxyUrl'
    | 'outbound'
    | 'maxAttempts'
    | 'credentials'
    | 'blockPrivateDestinations'
    | 'maxResponseBytes'
  >,
  env: Env = process.env,
): BedrockRuntimeClient {
  // The AWS SDK ignores HTTPS_PROXY: routing, proxy and DNS pinning come from the outbound
  // dispatcher factory (NO_PROXY honoured, e.g. for VPC endpoints). Behind a proxy the proxy
  // resolves the name (pre-request check only); otherwise the connect step pins the address.
  const target = opts.endpoint ?? `https://bedrock-runtime.${opts.region}.amazonaws.com`;
  const guard = opts.blockPrivateDestinations;
  const dispatcher =
    opts.outbound?.dispatcher ?? createOutboundDispatcher({ env, allowPlainHttpForPlatform: true });
  const agents = dispatcher.nodeAgents(target, {
    purpose: opts.outbound?.purpose ?? 'model',
    scope: {
      ...opts.outbound?.scope,
      ...(opts.proxyUrl && !opts.outbound?.scope?.proxyUrl
        ? { proxyUrl: opts.proxyUrl, proxyUrlGrandfathered: true }
        : {}),
    },
    ...(guard ? { pin: guard } : {}),
  });
  const proxied = agents.route.decision === 'proxy';
  return new BedrockRuntimeClient({
    region: opts.region,
    ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    ...(opts.maxAttempts ? { maxAttempts: opts.maxAttempts } : {}),
    ...(opts.credentials ? { credentials: opts.credentials } : {}),
    ...(guard
      ? {
          requestHandler: new LimitedNodeHttpHandler(
            {
              httpsAgent: agents.httpsAgent,
              ...(agents.httpAgent ? { httpAgent: agents.httpAgent } : {}),
            },
            opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
          ),
        }
      : proxied
        ? { requestHandler: new NodeHttpHandler({ httpsAgent: agents.httpsAgent }) }
        : {}),
  });
}

/** AWS Bedrock via the Converse API (works for Anthropic, Amazon, Meta, Mistral models). */
export class BedrockProvider implements ModelProvider {
  readonly kind = 'bedrock' as const;
  readonly name: string;
  readonly clearance: Classification;
  readonly family = 'bedrock';
  readonly catalogProvider: string | undefined;
  private readonly client: BedrockConverseClient;
  private readonly destination: Pick<
    BedrockOptions,
    'region' | 'endpoint' | 'blockPrivateDestinations'
  >;

  constructor(opts: BedrockOptions) {
    this.name = opts.name;
    this.clearance = opts.clearance ?? 'confidential';
    this.catalogProvider = opts.catalogProvider ?? 'amazon-bedrock';
    this.destination = opts;
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
    await assertBedrockDestination(this.destination);
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
