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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { listProposals, proposeModels, stripGeoPrefix, CATALOG_PATH } from '../src/index.js';

describe('vendored models.dev snapshot', () => {
  const raw = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as {
    sha256: string;
    sourceUrl: string;
    licence: string;
    providers: Record<string, { models: Record<string, { name: string }> }>;
  };

  it('carries provenance and covers every regular provider', () => {
    expect(raw.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(raw.sourceUrl).toBe('https://models.dev/api.json');
    expect(raw.licence).toMatch(/MIT/);
    for (const p of ['anthropic', 'openai', 'azure', 'amazon-bedrock', 'openrouter'])
      expect(Object.keys(raw.providers[p]?.models ?? {}).length).toBeGreaterThan(5);
  });

  it('only contains safe ids and names (the input is untrusted data)', () => {
    for (const p of Object.values(raw.providers))
      for (const [id, m] of Object.entries(p.models)) {
        expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/);
        expect([...m.name].every((ch) => ch.charCodeAt(0) >= 32 && !'<>`'.includes(ch))).toBe(true);
        expect(m.name.length).toBeLessThanOrEqual(120);
      }
  });

  it('merges local models (Ollama, vLLM, simulated) into the catalog', () => {
    const c = loadModelCatalog();
    expect(Object.keys(c.providers)).toEqual(
      expect.arrayContaining(['anthropic', 'ollama', 'vllm', 'lmstudio', 'simulated']),
    );
  });

  it('is exactly what the importer produces from its input', async () => {
    const importer = (await import(
      fileURLToPath(new URL('../../../scripts/import-models-dev.mjs', import.meta.url))
    )) as {
      convert: (api: unknown, wanted?: string[]) => Record<string, unknown>;
    };
    const out = importer.convert(
      {
        anthropic: {
          name: 'Anthropic',
          models: {
            good: {
              name: 'Good\n<b>',
              limit: { context: 10, output: 5 },
              cost: { input: 1, output: 2 },
              tool_call: true,
            },
            '~alias': { name: 'x' },
            pricey: { name: 'P', cost: { input: 1e9, output: 1 } },
          },
        },
        evil: { name: 'E', models: {} },
      },
      ['anthropic', 'missing'],
    ) as { anthropic: { models: Record<string, unknown> } };
    expect(Object.keys(out)).toEqual(['anthropic']);
    expect(out.anthropic.models).toEqual({
      good: {
        name: 'Goodb',
        limit: { context: 10, output: 5 },
        cost: { input: 1, output: 2 },
        toolCall: true,
      },
      pricey: { name: 'P', limit: {} },
    });
  });
});

describe('price proposals', () => {
  const c = loadModelCatalog();
  it('proposes catalog prices and limits', () => {
    const [p] = proposeModels(c, 'anthropic', [{ id: 'claude-opus-5-5' }]);
    expect(p).toMatchObject({
      priceSource: 'catalog',
      inputPerMTok: 4,
      outputPerMTok: 20,
      catalogModel: 'claude-opus-5-5',
    });
  });
  it('maps aliases such as Azure deployments and Bedrock inference profiles to catalog entries', () => {
    const azure = proposeModels(c, 'azure', [
      { id: 'prod-deployment', catalogModel: 'gpt-4.1' },
    ])[0]!;
    expect(azure).toMatchObject({ id: 'prod-deployment', catalogModel: 'gpt-4.1' });
    const bedrock = proposeModels(c, 'amazon-bedrock', [
      { id: 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0' },
    ])[0]!;
    expect(bedrock).toMatchObject({
      priceSource: 'catalog',
      catalogModel: expect.stringContaining('anthropic.claude-sonnet-4-5-20250929-v1:0'),
    });
    expect(stripGeoPrefix('eu.x')).toBe('x');
  });
  it('defaults local providers to free and flags unknown models for manual prices', () => {
    expect(proposeModels(c, 'vllm', [{ id: 'my-7b' }])[0]).toMatchObject({
      priceSource: 'local',
      inputPerMTok: 0,
    });
    expect(proposeModels(c, 'openai', [{ id: 'not-a-model' }])[0]).toMatchObject({
      priceSource: 'unknown',
      inputPerMTok: null,
    });
    expect(proposeModels(c, null, [{ id: 'x' }])[0]).toMatchObject({ priceSource: 'unknown' });
  });
  it('lists every model of a provider', () => {
    expect(listProposals(c, 'anthropic').length).toBeGreaterThan(5);
    expect(listProposals(c, 'nope')).toEqual([]);
    expect(listProposals(c, 'openrouter', 3)).toHaveLength(3);
  });
});
