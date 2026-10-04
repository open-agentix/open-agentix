import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { catalogModels, catalogPriceTable, loadModelCatalog } from '../src/index.js';

describe('model catalog', () => {
  it('loads the pinned snapshot and derives prices', () => {
    const c = loadModelCatalog();
    expect(c.snapshotDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const models = catalogModels(c);
    expect(models.find((m) => m.id === 'claude-opus-5-5')).toMatchObject({
      provider: 'anthropic',
      inputPerMTok: 4,
      outputPerMTok: 20,
      contextTokens: 1_000_000,
    });
    expect(catalogPriceTable(c).find((p) => p.model === 'claude-sonnet-5-5')).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      inputPerMTok: 2,
      outputPerMTok: 10,
      perToolCallUsd: 0,
    });
  });

  it('applies local overrides and adds private models', () => {
    const c = loadModelCatalog();
    const models = catalogModels(c, [
      {
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        inputPerMTok: 3,
        outputPerMTok: 15,
        perToolCallUsd: 0,
      },
      { provider: 'vllm', model: 'acme-7b', inputPerMTok: 0, outputPerMTok: 0, perToolCallUsd: 0 },
      { provider: 'openai', model: '*', inputPerMTok: 1, outputPerMTok: 1, perToolCallUsd: 0 },
    ]);
    expect(models.find((m) => m.id === 'claude-opus-5-5')).toMatchObject({
      inputPerMTok: 3,
      source: 'override',
    });
    expect(models.find((m) => m.id === 'acme-7b')).toMatchObject({
      provider: 'vllm',
      contextTokens: null,
      source: 'override',
    });
    expect(models.some((m) => m.id === '*')).toBe(false);
  });

  it('validates snapshot files and skips models without prices', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oax-catalog-'));
    const file = join(dir, 'm.json');
    writeFileSync(
      file,
      JSON.stringify({
        source: 's',
        snapshotDate: 'd',
        providers: { x: { name: 'X', models: { m: { name: 'M' } } } },
      }),
    );
    const c = loadModelCatalog(file);
    expect(catalogModels(c)[0]).toMatchObject({ contextTokens: null, inputPerMTok: null });
    expect(catalogPriceTable(c)).toEqual([]);
    writeFileSync(file, '{"providers":1}');
    expect(() => loadModelCatalog(file)).toThrow();
  });
});
