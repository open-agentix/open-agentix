import { readFileSync } from 'node:fs';
import type { PriceEntry } from '@openagentix/core';
import { z } from 'zod';

/**
 * Model catalog from a pinned, vendored snapshot of models.dev (`catalog/models.json`) plus hand
 * maintained local models (`catalog/local.json`). Both are read from disk only - never fetched at
 * run time - and the snapshot is refreshed through reviewed pull requests
 * (`scripts/import-models-dev.mjs`, `.github/workflows/catalog-refresh.yml`).
 */
const ModelSchema = z.object({
  name: z.string(),
  limit: z
    .object({ context: z.number().int().nonnegative(), output: z.number().int().nonnegative() })
    .partial()
    .default({}),
  cost: z
    .object({ input: z.number().nonnegative(), output: z.number().nonnegative() })
    .partial()
    .optional(),
  toolCall: z.boolean().optional(),
  reasoning: z.boolean().optional(),
});

const ProvidersSchema = z.record(
  z.string(),
  z.object({ name: z.string(), models: z.record(z.string(), ModelSchema) }),
);

export const ModelCatalogSchema = z.object({
  source: z.string(),
  snapshotDate: z.string(),
  sourceUrl: z.string().optional(),
  licence: z.string().optional(),
  /** SHA-256 of the models.dev document the snapshot was generated from (provenance). */
  sha256: z.string().optional(),
  providers: ProvidersSchema,
});
export type ModelCatalog = z.infer<typeof ModelCatalogSchema>;

const LocalCatalogSchema = z.object({ providers: ProvidersSchema });

export interface CatalogModel {
  provider: string;
  providerName: string;
  id: string;
  name: string;
  contextTokens: number | null;
  outputTokens: number | null;
  inputPerMTok: number | null;
  outputPerMTok: number | null;
  toolCall: boolean | null;
  source: 'catalog' | 'override';
}

export const CATALOG_PATH = new URL('../catalog/models.json', import.meta.url);
export const LOCAL_CATALOG_PATH = new URL('../catalog/local.json', import.meta.url);

/**
 * Loads the snapshot and merges the local models (local entries add to or replace snapshot
 * entries). Pass `localPath: null` to load a snapshot file alone.
 */
export function loadModelCatalog(
  path: URL | string = CATALOG_PATH,
  localPath: URL | string | null = path === CATALOG_PATH ? LOCAL_CATALOG_PATH : null,
): ModelCatalog {
  const catalog = ModelCatalogSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  if (!localPath) return catalog;
  const local = LocalCatalogSchema.parse(JSON.parse(readFileSync(localPath, 'utf8')));
  for (const [id, p] of Object.entries(local.providers)) {
    const into = catalog.providers[id];
    catalog.providers[id] = into ? { name: p.name, models: { ...into.models, ...p.models } } : p;
  }
  return catalog;
}

/** Flattens the catalog and applies local overrides (private or self-hosted models, contract prices). */
export function catalogModels(
  catalog: ModelCatalog,
  overrides: readonly PriceEntry[] = [],
): CatalogModel[] {
  const out: CatalogModel[] = [];
  for (const [provider, p] of Object.entries(catalog.providers)) {
    for (const [id, m] of Object.entries(p.models)) {
      out.push({
        provider,
        providerName: p.name,
        id,
        name: m.name,
        contextTokens: m.limit.context ?? null,
        outputTokens: m.limit.output ?? null,
        inputPerMTok: m.cost?.input ?? null,
        outputPerMTok: m.cost?.output ?? null,
        toolCall: m.toolCall ?? null,
        source: 'catalog',
      });
    }
  }
  for (const o of overrides) {
    if (o.model.includes('*')) continue;
    const existing = out.find((m) => m.provider === o.provider && m.id === o.model);
    if (existing) {
      existing.inputPerMTok = o.inputPerMTok;
      existing.outputPerMTok = o.outputPerMTok;
      existing.source = 'override';
    } else {
      out.push({
        provider: o.provider,
        providerName: o.provider,
        id: o.model,
        name: o.model,
        contextTokens: null,
        outputTokens: null,
        inputPerMTok: o.inputPerMTok,
        outputPerMTok: o.outputPerMTok,
        toolCall: null,
        source: 'override',
      });
    }
  }
  return out.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
}

/** Price entries derived from the catalog (configured OAX_PRICE_TABLE entries take precedence). */
export function catalogPriceTable(catalog: ModelCatalog): PriceEntry[] {
  return catalogModels(catalog)
    .filter((m) => m.inputPerMTok !== null && m.outputPerMTok !== null)
    .map((m) => ({
      provider: m.provider,
      model: m.id,
      inputPerMTok: m.inputPerMTok!,
      outputPerMTok: m.outputPerMTok!,
      perToolCallUsd: 0,
    }));
}

/** Bedrock inference profiles prefix the model id with a geography (`eu.anthropic...`). */
export function stripGeoPrefix(modelId: string): string {
  return modelId.replace(/^(us|eu|apac|global|us-gov|jp|au|ca)\./, '');
}

export interface ModelProposal {
  /** The id agents use (`model:` in agents.md; for Azure the deployment name). */
  id: string;
  /** Catalog entry the proposal is based on (differs from `id` for Azure deployments). */
  catalogModel: string | null;
  name: string | null;
  contextTokens: number | null;
  outputTokens: number | null;
  inputPerMTok: number | null;
  outputPerMTok: number | null;
  toolCall: boolean | null;
  /** `catalog` = from the pinned snapshot, `local` = free of charge self-hosted, `unknown` = enter prices. */
  priceSource: 'catalog' | 'local' | 'unknown';
}

const LOCAL_PROVIDERS = new Set(['ollama', 'vllm', 'lmstudio', 'simulated']);

/**
 * Proposes costs and limits for models of a provider (shown when a connection is created; every
 * value can be overridden). `catalogModel` maps arbitrary names (Azure deployments, aliases) to a
 * catalog entry. Local providers default to free of charge.
 */
export function proposeModels(
  catalog: ModelCatalog,
  catalogProvider: string | null,
  requests: readonly { id: string; catalogModel?: string | undefined }[],
): ModelProposal[] {
  const models = catalogProvider ? (catalog.providers[catalogProvider]?.models ?? {}) : {};
  return requests.map((r) => {
    const key = r.catalogModel ?? r.id;
    const hit = models[key] ?? models[stripGeoPrefix(key)];
    const local = catalogProvider !== null && LOCAL_PROVIDERS.has(catalogProvider);
    const priced = hit?.cost?.input !== undefined && hit.cost.output !== undefined;
    return {
      id: r.id,
      catalogModel: hit ? (models[key] ? key : stripGeoPrefix(key)) : null,
      name: hit?.name ?? null,
      contextTokens: hit?.limit.context ?? null,
      outputTokens: hit?.limit.output ?? null,
      inputPerMTok: priced ? hit!.cost!.input! : local ? 0 : null,
      outputPerMTok: priced ? hit!.cost!.output! : local ? 0 : null,
      toolCall: hit?.toolCall ?? null,
      priceSource: priced ? 'catalog' : local ? 'local' : 'unknown',
    };
  });
}

/** Every catalog model of a provider as proposals (for the "pick models" step of the UI). */
export function listProposals(
  catalog: ModelCatalog,
  catalogProvider: string,
  limit = 1000,
): ModelProposal[] {
  const ids = Object.keys(catalog.providers[catalogProvider]?.models ?? {}).sort();
  return proposeModels(
    catalog,
    catalogProvider,
    ids.slice(0, limit).map((id) => ({ id })),
  );
}
