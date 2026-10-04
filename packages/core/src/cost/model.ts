import { z } from 'zod';
import { globMatch } from '../policy/engine.js';

/**
 * Cost model. Amounts are integer micro-USD (1 USD = 1_000_000) to avoid floating point drift;
 * conveniently, `tokens * pricePerMillionTokens` is exactly micro-USD.
 */

export const PriceEntrySchema = z.strictObject({
  provider: z.string().min(1),
  /** Model id or glob (`claude-*`). */
  model: z.string().min(1),
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
  /** Optional flat price per tool call (e.g. paid APIs behind MCP). */
  perToolCallUsd: z.number().nonnegative().default(0),
});
export type PriceEntry = z.infer<typeof PriceEntrySchema>;
export const PriceTableSchema = z.array(PriceEntrySchema);

/** Built-in prices for local/simulated providers. Commercial prices come from configuration. */
export const DEFAULT_PRICE_TABLE: PriceEntry[] = [
  { provider: 'simulated', model: '*', inputPerMTok: 0, outputPerMTok: 0, perToolCallUsd: 0 },
  { provider: 'ollama', model: '*', inputPerMTok: 0, outputPerMTok: 0, perToolCallUsd: 0 },
];

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface CostBreakdown {
  inputMicros: number;
  outputMicros: number;
  totalMicros: number;
  /** False when no price entry matched (cost counted as 0 and flagged). */
  priced: boolean;
}

const GEO_PREFIX = /^(us|eu|apac|global|us-gov|jp|au|ca)\./;

export class CostModel {
  private readonly table: PriceEntry[];

  /** Later entries override earlier ones; configured entries override the defaults. */
  constructor(entries: readonly PriceEntry[] = [], includeDefaults = true) {
    this.table = [...(includeDefaults ? DEFAULT_PRICE_TABLE : []), ...entries];
  }

  static fromJson(json: string | undefined): CostModel {
    if (!json) return new CostModel();
    return new CostModel(PriceTableSchema.parse(JSON.parse(json)));
  }

  /** Exact matches win over globs; among equals, the last entry wins. */
  find(provider: string, model: string): PriceEntry | undefined {
    const candidates = this.table.filter(
      (e) => e.provider === provider && globMatch(e.model, model),
    );
    const exact = candidates.filter((e) => e.model === model);
    const hit = (exact.length > 0 ? exact : candidates).at(-1);
    if (hit) return hit;
    // Bedrock inference profiles carry a geography prefix (`eu.anthropic.claude-...`).
    const bare = model.replace(GEO_PREFIX, '');
    return bare === model ? undefined : this.find(provider, bare);
  }

  modelCall(provider: string, model: string, usage: Usage): CostBreakdown {
    const p = this.find(provider, model);
    if (!p) return { inputMicros: 0, outputMicros: 0, totalMicros: 0, priced: false };
    const inputMicros = Math.round(usage.inputTokens * p.inputPerMTok);
    const outputMicros = Math.round(usage.outputTokens * p.outputPerMTok);
    return { inputMicros, outputMicros, totalMicros: inputMicros + outputMicros, priced: true };
  }

  toolCall(provider: string, model: string): number {
    return Math.round((this.find(provider, model)?.perToolCallUsd ?? 0) * 1_000_000);
  }

  entries(): readonly PriceEntry[] {
    return this.table;
  }
}

export function microsToUsd(micros: number): number {
  return micros / 1_000_000;
}

export function usdToMicros(usd: number): number {
  return Math.round(usd * 1_000_000);
}
