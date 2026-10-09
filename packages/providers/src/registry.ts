import type { HostLookup } from './ssrf.js';
import { CLASSIFICATIONS, OaxError, type PriceEntry, type SecretResolver } from '@openagentix/core';
import { z } from 'zod';
import { AnthropicProvider } from './anthropic.js';
import { BedrockProvider, type BedrockConverseClient } from './bedrock.js';
import type { FetchLike } from './http.js';
import { OllamaProvider } from './ollama.js';
import { OpenAICompatibleProvider } from './openai.js';
import { SimulatedProvider } from './simulated.js';
import type { ModelProvider } from './types.js';

/** Price override of one model of a provider/connection (USD per million tokens). */
export const ModelEntrySchema = z.strictObject({
  /** The id agents use as `model:` (for Azure OpenAI the deployment name). */
  id: z.string().min(1).max(200),
  /** Catalog entry to take limits and the proposed price from when `id` is an alias. */
  catalogModel: z.string().min(1).max(200).optional(),
  inputPerMTok: z.number().nonnegative().optional(),
  outputPerMTok: z.number().nonnegative().optional(),
  perToolCallUsd: z.number().nonnegative().optional(),
  /** Where the price came from: the pinned catalog proposal or a manual override. */
  priceSource: z.enum(['catalog', 'local', 'override', 'unknown']).optional(),
});
export type ModelEntry = z.infer<typeof ModelEntrySchema>;

const nameField = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
/**
 * A secret *reference* (name), never the secret itself: the usual reference charset, and values
 * that look like real API keys are refused so a pasted key cannot be stored by accident.
 */
export const SecretRefSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/, 'not a valid secret reference name')
  .refine(
    (v) => !/^(sk-|sk_|AKIA[0-9A-Z]{12,}|ASIA[0-9A-Z]{12,}|ghp_|github_pat_|xox[a-z]-)/.test(v),
    'looks like a secret value; reference the secret by name instead',
  );

const common = {
  /** Instance name (env providers); connections take it from the connection. */
  name: nameField.optional(),
  clearance: z.enum(CLASSIFICATIONS).optional(),
  proxyUrl: z.string().url().optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxRetries: z.number().int().nonnegative().max(10).optional(),
  /** Models offered through this provider with optional price overrides. */
  models: z.array(ModelEntrySchema).max(500).optional(),
  /** models.dev provider id used for price proposals and lookups (derived from the kind). */
  catalogProvider: z.string().min(1).max(100).optional(),
};
/**
 * Provider settings without the instance name: the body of a `model` connection and (plus `name`)
 * an entry of `OAX_PROVIDERS`. Secrets are references only (`*Secret`, `headerSecrets`).
 */
export const ProviderSettingsSchema = z.discriminatedUnion('kind', [
  /** OpenAI (GPT). */
  z.strictObject({
    kind: z.literal('openai'),
    ...common,
    baseUrl: z.string().url().default('https://api.openai.com/v1'),
    apiKeySecret: SecretRefSchema.optional(),
    organization: z.string().max(100).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    /** Header name -> secret reference. */
    headerSecrets: z.record(z.string(), SecretRefSchema).optional(),
    query: z.string().optional(),
  }),
  /** Any OpenAI-compatible `/chat/completions` server (LiteLLM, TGI, gateways). */
  z.strictObject({
    kind: z.literal('openai-compatible'),
    ...common,
    baseUrl: z.string().url(),
    apiKeySecret: SecretRefSchema.optional(),
    headers: z.record(z.string(), z.string()).optional(),
    headerSecrets: z.record(z.string(), SecretRefSchema).optional(),
    query: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal('azure-openai'),
    ...common,
    /** `https://<resource>.openai.azure.com` */
    endpoint: z.string().url(),
    apiVersion: z.string().min(1).default('2024-10-21'),
    /** Fixed deployment; without it the agent's `model` is the deployment name. */
    deployment: z.string().min(1).optional(),
    apiKeySecret: SecretRefSchema,
  }),
  z.strictObject({
    kind: z.literal('openrouter'),
    ...common,
    baseUrl: z.string().url().default('https://openrouter.ai/api/v1'),
    apiKeySecret: SecretRefSchema,
    /** Optional attribution headers (`HTTP-Referer`, `X-Title`). */
    referer: z.string().url().optional(),
    title: z.string().max(100).optional(),
  }),
  z.strictObject({
    kind: z.literal('vllm'),
    ...common,
    baseUrl: z.string().url(),
    apiKeySecret: SecretRefSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('lmstudio'),
    ...common,
    baseUrl: z.string().url().default('http://localhost:1234/v1'),
  }),
  z.strictObject({ kind: z.literal('ollama'), ...common, baseUrl: z.string().url().optional() }),
  z.strictObject({
    kind: z.literal('anthropic'),
    ...common,
    baseUrl: z.string().url().optional(),
    apiKeySecret: SecretRefSchema,
    defaultMaxTokens: z.number().int().positive().optional(),
  }),
  z.strictObject({
    kind: z.literal('bedrock'),
    ...common,
    region: z.string().min(1),
    endpoint: z.string().url().optional(),
    /** BYOK: explicit AWS credentials by reference; default chain (IRSA, roles) when omitted. */
    accessKeyIdSecret: SecretRefSchema.optional(),
    secretAccessKeySecret: SecretRefSchema.optional(),
    sessionTokenSecret: SecretRefSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('simulated'),
    ...common,
    latencyMs: z.number().int().nonnegative().optional(),
  }),
]);
export type ProviderSettings = z.infer<typeof ProviderSettingsSchema>;
export type ProviderKindName = ProviderSettings['kind'];

/** Provider configuration (env `OAX_PROVIDERS`, JSON array): settings plus an instance name. */
export const ProviderConfigSchema = ProviderSettingsSchema.refine((p) => !!p.name, {
  message: 'name is required',
  path: ['name'],
});
export type ProviderConfig = ProviderSettings & { name: string };

/** Binds settings to an instance name (the connection name for BYOK connections). */
export function withName(settings: ProviderSettings, name: string): ProviderConfig {
  return { ...settings, name };
}

/** models.dev provider id for each kind (null = no catalog entry, prices by override only). */
export const CATALOG_PROVIDER_FOR: Record<ProviderKindName, string | null> = {
  openai: 'openai',
  'openai-compatible': null,
  'azure-openai': 'azure',
  openrouter: 'openrouter',
  vllm: 'vllm',
  lmstudio: 'lmstudio',
  ollama: 'ollama',
  anthropic: 'anthropic',
  bedrock: 'amazon-bedrock',
  simulated: 'simulated',
};

/** Which secret references a settings object uses (for scoping and validation). */
export function secretRefsOf(cfg: ProviderSettings): string[] {
  const refs: string[] = [];
  const o = cfg as Record<string, unknown>;
  for (const [k, v] of Object.entries(o))
    if (/Secret$/.test(k) && typeof v === 'string') refs.push(v);
  if (o.headerSecrets) refs.push(...Object.values(o.headerSecrets as Record<string, string>));
  return refs;
}

export const DEFAULT_PROVIDERS: ProviderConfig[] = [{ kind: 'simulated', name: 'simulated' }];

export function parseProviderConfigs(json: string | undefined): ProviderConfig[] {
  if (!json) return DEFAULT_PROVIDERS;
  const list = z.array(ProviderConfigSchema).parse(JSON.parse(json)) as ProviderConfig[];
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
  /** Tenant-controlled endpoints: refuse non-public destinations (operator `allow` list). */
  blockPrivateDestinations?: { allow?: readonly string[]; lookup?: HostLookup } | undefined;
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
  const catalogProvider = cfg.catalogProvider ?? CATALOG_PROVIDER_FOR[cfg.kind] ?? undefined;
  const secret = (ref: string | undefined) => (ref ? deps.secrets.resolve(ref) : undefined);
  const compatible = async (
    cfgBase: {
      baseUrl: string;
      apiKeySecret?: string | undefined;
      headers?: Record<string, string> | undefined;
      headerSecrets?: Record<string, string> | undefined;
      query?: string | undefined;
    },
    extra: Partial<ConstructorParameters<typeof OpenAICompatibleProvider>[0]> = {},
  ) => {
    const headers = { ...cfgBase.headers, ...extra.headers };
    for (const [h, ref] of Object.entries(cfgBase.headerSecrets ?? {}))
      headers[h] = await deps.secrets.resolve(ref);
    return new OpenAICompatibleProvider({
      ...base,
      ...clearance,
      family: cfg.kind,
      catalogProvider,
      baseUrl: cfgBase.baseUrl,
      apiKey: await secret(cfgBase.apiKeySecret),
      query: cfgBase.query,
      fetchImpl: deps.fetchImpl,
      ...extra,
      headers,
    });
  };
  switch (cfg.kind) {
    case 'openai':
      return compatible(cfg, {
        maxTokensParam: 'max_completion_tokens',
        headers: cfg.organization ? { 'openai-organization': cfg.organization } : {},
      });
    case 'openai-compatible':
      return compatible(cfg);
    case 'vllm':
      return compatible(cfg, { clearance: cfg.clearance ?? 'restricted' });
    case 'lmstudio':
      return compatible(cfg, { clearance: cfg.clearance ?? 'restricted' });
    case 'openrouter':
      return compatible(cfg, {
        headers: {
          ...(cfg.referer ? { 'http-referer': cfg.referer } : {}),
          ...(cfg.title ? { 'x-title': cfg.title } : {}),
        },
      });
    case 'azure-openai': {
      const apiKey = await deps.secrets.resolve(cfg.apiKeySecret);
      return new OpenAICompatibleProvider({
        ...base,
        ...clearance,
        family: cfg.kind,
        catalogProvider,
        baseUrl: cfg.endpoint,
        headers: { 'api-key': apiKey },
        azure: { apiVersion: cfg.apiVersion, deployment: cfg.deployment },
        maxTokensParam: 'max_completion_tokens',
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
    case 'bedrock': {
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
      return new BedrockProvider({
        name: cfg.name,
        ...clearance,
        region: cfg.region,
        endpoint: cfg.endpoint,
        proxyUrl: cfg.proxyUrl,
        blockPrivateDestinations: deps.blockPrivateDestinations,
        maxAttempts: cfg.maxRetries === undefined ? undefined : cfg.maxRetries + 1,
        credentials,
        catalogProvider,
        client: deps.bedrockClient,
      });
    }
    case 'simulated':
      return new SimulatedProvider({
        name: cfg.name,
        ...clearance,
        ...(cfg.latencyMs ? { latencyMs: cfg.latencyMs } : {}),
      });
  }
}

/** Price entries of a provider's `models` (only entries that carry both prices). */
export function modelPriceEntries(
  name: string,
  models: readonly ModelEntry[] | undefined,
): PriceEntry[] {
  return (models ?? [])
    .filter((m) => m.inputPerMTok !== undefined && m.outputPerMTok !== undefined)
    .map((m) => ({
      provider: name,
      model: m.id,
      inputPerMTok: m.inputPerMTok!,
      outputPerMTok: m.outputPerMTok!,
      perToolCallUsd: m.perToolCallUsd ?? 0,
    }));
}

export class ProviderRegistry {
  private constructor(private readonly providers: Map<string, ModelProvider>) {}

  /** Providers of `overlay` replace same-named providers of this registry. */
  with(overlay: ProviderRegistry): ProviderRegistry {
    return new ProviderRegistry(new Map([...this.providers, ...overlay.providers]));
  }

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
