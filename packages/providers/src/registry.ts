import { CLASSIFICATIONS, OaxError, type SecretResolver } from '@openagentix/core';
import { z } from 'zod';
import { AnthropicProvider } from './anthropic.js';
import { BedrockProvider, type BedrockConverseClient } from './bedrock.js';
import type { FetchLike } from './http.js';
import { OllamaProvider } from './ollama.js';
import { OpenAICompatibleProvider } from './openai.js';
import { SimulatedProvider } from './simulated.js';
import type { ModelProvider } from './types.js';

const common = {
  name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  clearance: z.enum(CLASSIFICATIONS).optional(),
  proxyUrl: z.string().url().optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxRetries: z.number().int().nonnegative().max(10).optional(),
};

/** Provider configuration (env `OAX_PROVIDERS`, JSON array). Secrets are references only. */
export const ProviderConfigSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('openai'),
    ...common,
    baseUrl: z.string().url(),
    apiKeySecret: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    /** Header name -> secret reference (e.g. Azure `api-key`). */
    headerSecrets: z.record(z.string(), z.string()).optional(),
    query: z.string().optional(),
  }),
  z.strictObject({ kind: z.literal('ollama'), ...common, baseUrl: z.string().url().optional() }),
  z.strictObject({
    kind: z.literal('anthropic'),
    ...common,
    baseUrl: z.string().url().optional(),
    apiKeySecret: z.string(),
    defaultMaxTokens: z.number().int().positive().optional(),
  }),
  z.strictObject({
    kind: z.literal('bedrock'),
    ...common,
    region: z.string().min(1),
    endpoint: z.string().url().optional(),
  }),
  z.strictObject({
    kind: z.literal('simulated'),
    ...common,
    latencyMs: z.number().int().nonnegative().optional(),
  }),
]);
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const DEFAULT_PROVIDERS: ProviderConfig[] = [{ kind: 'simulated', name: 'simulated' }];

export function parseProviderConfigs(json: string | undefined): ProviderConfig[] {
  if (!json) return DEFAULT_PROVIDERS;
  const list = z.array(ProviderConfigSchema).parse(JSON.parse(json));
  const names = new Set<string>();
  for (const p of list) {
    if (names.has(p.name))
      throw new OaxError('config_invalid', `duplicate provider name "${p.name}"`);
    names.add(p.name);
  }
  return list;
}

export interface RegistryDeps {
  secrets: SecretResolver;
  fetchImpl?: FetchLike;
  bedrockClient?: BedrockConverseClient;
}

export async function createProvider(
  cfg: ProviderConfig,
  deps: RegistryDeps,
): Promise<ModelProvider> {
  const base = {
    name: cfg.name,
    proxyUrl: cfg.proxyUrl,
    timeoutMs: cfg.timeoutMs,
    maxRetries: cfg.maxRetries,
  };
  const clearance = cfg.clearance ? { clearance: cfg.clearance } : {};
  switch (cfg.kind) {
    case 'openai': {
      const headers = { ...cfg.headers };
      for (const [h, ref] of Object.entries(cfg.headerSecrets ?? {}))
        headers[h] = await deps.secrets.resolve(ref);
      return new OpenAICompatibleProvider({
        ...base,
        ...clearance,
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKeySecret ? await deps.secrets.resolve(cfg.apiKeySecret) : undefined,
        headers,
        query: cfg.query,
        fetchImpl: deps.fetchImpl,
      });
    }
    case 'ollama':
      return new OllamaProvider({
        ...base,
        ...clearance,
        baseUrl: cfg.baseUrl,
        fetchImpl: deps.fetchImpl,
      });
    case 'anthropic':
      return new AnthropicProvider({
        ...base,
        ...clearance,
        baseUrl: cfg.baseUrl,
        apiKey: await deps.secrets.resolve(cfg.apiKeySecret),
        defaultMaxTokens: cfg.defaultMaxTokens,
        fetchImpl: deps.fetchImpl,
      });
    case 'bedrock':
      return new BedrockProvider({
        name: cfg.name,
        ...clearance,
        region: cfg.region,
        endpoint: cfg.endpoint,
        proxyUrl: cfg.proxyUrl,
        maxAttempts: cfg.maxRetries === undefined ? undefined : cfg.maxRetries + 1,
        client: deps.bedrockClient,
      });
    case 'simulated':
      return new SimulatedProvider({
        name: cfg.name,
        ...clearance,
        ...(cfg.latencyMs ? { latencyMs: cfg.latencyMs } : {}),
      });
  }
}

export class ProviderRegistry {
  private constructor(private readonly providers: Map<string, ModelProvider>) {}

  static async create(
    configs: readonly ProviderConfig[],
    deps: RegistryDeps,
  ): Promise<ProviderRegistry> {
    const map = new Map<string, ModelProvider>();
    for (const c of configs) map.set(c.name, await createProvider(c, deps));
    return new ProviderRegistry(map);
  }

  static of(providers: readonly ModelProvider[]): ProviderRegistry {
    return new ProviderRegistry(new Map(providers.map((p) => [p.name, p])));
  }

  get(name: string): ModelProvider {
    const p = this.providers.get(name);
    if (!p) throw new OaxError('provider_unknown', `provider "${name}" is not configured`);
    return p;
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }

  names(): string[] {
    return [...this.providers.keys()];
  }
}
