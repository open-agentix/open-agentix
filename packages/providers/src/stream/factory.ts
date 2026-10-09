import { OaxError, type SecretResolver } from '@openagentix/core';
import { toAnthropicBody } from '../anthropic.js';
import type { FetchLike, GuardedFetchOptions } from '../http.js';
import { toOpenAIBody } from '../openai.js';
import type { HostLookup } from '../ssrf.js';
import type { ProviderConfig } from '../registry.js';
import type { ChatRequest } from '../types.js';
import type { StreamSurface } from './aggregate.js';
import { AnthropicStreamTransport } from './anthropic.js';
import { BedrockStreamTransport, type BedrockStreamClient } from './bedrock.js';
import { OpenAIStreamTransport } from './openai.js';
import type { StreamLimits, StreamingTransport } from './types.js';

export interface StreamPlanDeps {
  secrets: SecretResolver;
  fetchImpl?: FetchLike | undefined;
  /** Tenant-controlled endpoints: refuse private destinations (operator `allow` list). */
  blockPrivateDestinations?: { allow?: readonly string[]; lookup?: HostLookup } | undefined;
  outbound?: GuardedFetchOptions['outbound'];
  bedrockClient?: BedrockStreamClient | undefined;
}

export interface StreamPlanOptions {
  /** The model the call is for (decides whether a Bedrock model speaks the Anthropic body). */
  model: string;
  limits?: Partial<StreamLimits> | undefined;
}

/** Everything needed to run one streaming call against a configured provider. */
export interface StreamPlan {
  surface: StreamSurface;
  transport: StreamingTransport;
  /** Builds the upstream body from the validated request (fresh object, nothing forwarded raw). */
  buildBody(req: ChatRequest): Record<string, unknown>;
  /** Resolved secret values of the provider, for scrubbing error text (never logged). */
  secrets: string[];
  /** OpenAI surface: the name of the output bound parameter this provider understands. */
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens' | undefined;
}

const ANTHROPIC_ON_BEDROCK = /(^|\.)anthropic\./;

/**
 * Streaming counterpart of `createProvider`: resolves the provider's secrets on the control node
 * and builds the matching streaming transport. Returns `null` for providers without a streaming
 * transport (`simulated`, Bedrock models that do not speak the Anthropic body); the caller then
 * uses the non-streaming adapter.
 */
export async function createStreamPlan(
  cfg: ProviderConfig,
  deps: StreamPlanDeps,
  opts: StreamPlanOptions,
): Promise<StreamPlan | null> {
  const secret = (ref: string | undefined) => (ref ? deps.secrets.resolve(ref) : undefined);
  const common = {
    proxyUrl: cfg.proxyUrl,
    outbound: deps.outbound,
    fetchImpl: deps.fetchImpl,
    blockPrivateDestinations: deps.blockPrivateDestinations,
    limits: opts.limits,
    // No retries: a retry would be a second billed call under one reservation. The node retries
    // with a NEW reservation.
    maxRetries: 0,
  };
  const openai = async (o: {
    baseUrl: string;
    apiKey?: string | undefined;
    headers?: Record<string, string>;
    headerSecrets?: Record<string, string> | undefined;
    query?: string | undefined;
    azure?: { apiVersion: string; deployment?: string | undefined };
    maxTokensParam: 'max_tokens' | 'max_completion_tokens';
  }): Promise<StreamPlan> => {
    const headers: Record<string, string> = { ...o.headers };
    for (const [h, ref] of Object.entries(o.headerSecrets ?? {}))
      headers[h] = await deps.secrets.resolve(ref);
    const secrets = [o.apiKey, ...Object.values(headers)].filter((s): s is string => !!s);
    return {
      surface: 'openai',
      transport: new OpenAIStreamTransport({
        ...common,
        baseUrl: o.baseUrl,
        apiKey: o.apiKey,
        headers,
        query: o.query,
        azure: o.azure,
        secrets,
      }),
      buildBody: (req) => toOpenAIBody(req, o.maxTokensParam),
      secrets,
      maxTokensParam: o.maxTokensParam,
    };
  };
  switch (cfg.kind) {
    case 'openai':
      return openai({
        baseUrl: cfg.baseUrl,
        apiKey: await secret(cfg.apiKeySecret),
        headers: {
          ...cfg.headers,
          ...(cfg.organization ? { 'openai-organization': cfg.organization } : {}),
        },
        headerSecrets: cfg.headerSecrets,
        query: cfg.query,
        maxTokensParam: 'max_completion_tokens',
      });
    case 'openai-compatible':
      return openai({
        baseUrl: cfg.baseUrl,
        apiKey: await secret(cfg.apiKeySecret),
        ...(cfg.headers ? { headers: cfg.headers } : {}),
        headerSecrets: cfg.headerSecrets,
        query: cfg.query,
        maxTokensParam: 'max_tokens',
      });
    case 'vllm':
    case 'lmstudio':
      return openai({
        baseUrl: cfg.baseUrl,
        apiKey: await secret(cfg.kind === 'vllm' ? cfg.apiKeySecret : undefined),
        maxTokensParam: 'max_tokens',
      });
    case 'openrouter':
      return openai({
        baseUrl: cfg.baseUrl,
        apiKey: await secret(cfg.apiKeySecret),
        headers: {
          ...(cfg.referer ? { 'http-referer': cfg.referer } : {}),
          ...(cfg.title ? { 'x-title': cfg.title } : {}),
        },
        maxTokensParam: 'max_tokens',
      });
    case 'azure-openai': {
      const apiKey = await deps.secrets.resolve(cfg.apiKeySecret);
      return openai({
        baseUrl: cfg.endpoint,
        headers: { 'api-key': apiKey },
        azure: { apiVersion: cfg.apiVersion, deployment: cfg.deployment },
        maxTokensParam: 'max_completion_tokens',
      });
    }
    case 'ollama':
      // Ollama's OpenAI-compatible endpoint; the native /api/chat adapter is non-streaming only.
      return openai({
        baseUrl: `${(cfg.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '')}/v1`,
        maxTokensParam: 'max_tokens',
      });
    case 'anthropic': {
      const apiKey = await deps.secrets.resolve(cfg.apiKeySecret);
      return {
        surface: 'anthropic',
        transport: new AnthropicStreamTransport({
          ...common,
          baseUrl: cfg.baseUrl ?? 'https://api.anthropic.com',
          apiKey,
          secrets: [apiKey],
        }),
        buildBody: (req) => ({ ...toAnthropicBody(req, cfg.defaultMaxTokens) }),
        secrets: [apiKey],
      };
    }
    case 'bedrock': {
      if (!ANTHROPIC_ON_BEDROCK.test(opts.model)) return null;
      if (!cfg.accessKeyIdSecret !== !cfg.secretAccessKeySecret)
        throw new OaxError(
          'config_invalid',
          'bedrock needs both accessKeyIdSecret and secretAccessKeySecret (or neither)',
        );
      const credentials =
        cfg.accessKeyIdSecret && cfg.secretAccessKeySecret
          ? {
              accessKeyId: await deps.secrets.resolve(cfg.accessKeyIdSecret),
              secretAccessKey: await deps.secrets.resolve(cfg.secretAccessKeySecret),
              sessionToken: await secret(cfg.sessionTokenSecret),
            }
          : undefined;
      const secrets = credentials
        ? [credentials.accessKeyId, credentials.secretAccessKey, credentials.sessionToken].filter(
            (s): s is string => !!s,
          )
        : [];
      return {
        surface: 'anthropic',
        transport: new BedrockStreamTransport({
          region: cfg.region,
          endpoint: cfg.endpoint,
          proxyUrl: cfg.proxyUrl,
          outbound: deps.outbound,
          blockPrivateDestinations: deps.blockPrivateDestinations,
          maxAttempts: 1,
          credentials,
          limits: opts.limits,
          secrets,
          client: deps.bedrockClient,
        }),
        buildBody: (req) => ({ ...toAnthropicBody(req, undefined) }),
        secrets,
      };
    }
    case 'simulated':
      return null;
  }
}
