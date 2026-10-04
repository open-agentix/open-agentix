import { readFileSync } from 'node:fs';
import type { PriceEntry } from '@openagentix/core';
import { z } from 'zod';

/**
 * Model catalog from a pinned, vendored snapshot (models.dev schema subset). It is read from disk
 * only - never fetched at run time - and refreshed through reviewed pull requests.
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
});

export const ModelCatalogSchema = z.object({
  source: z.string(),
  snapshotDate: z.string(),
  providers: z.record(
    z.string(),
    z.object({ name: z.string(), models: z.record(z.string(), ModelSchema) }),
  ),
});
export type ModelCatalog = z.infer<typeof ModelCatalogSchema>;

export interface CatalogModel {
  provider: string;
  providerName: string;
  id: string;
  name: string;
  contextTokens: number | null;
  outputTokens: number | null;
  inputPerMTok: number | null;
  outputPerMTok: number | null;
  source: 'catalog' | 'override';
}

export const CATALOG_PATH = new URL('../catalog/models.json', import.meta.url);

export function loadModelCatalog(path: URL | string = CATALOG_PATH): ModelCatalog {
  return ModelCatalogSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
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
