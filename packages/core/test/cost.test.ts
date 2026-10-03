import { describe, expect, it } from 'vitest';
import {
  CostModel,
  DEFAULT_PRICE_TABLE,
  PriceEntrySchema,
  microsToUsd,
  usdToMicros,
} from '../src/index.js';

const entry = (o: object) => PriceEntrySchema.parse(o);

describe('CostModel', () => {
  const model = new CostModel([
    entry({ provider: 'anthropic', model: 'claude-*', inputPerMTok: 3, outputPerMTok: 15 }),
    entry({
      provider: 'anthropic',
      model: 'claude-cheap',
      inputPerMTok: 1,
      outputPerMTok: 5,
      perToolCallUsd: 0.001,
    }),
  ]);

  it('calculates exact micro-USD', () => {
    expect(
      model.modelCall('anthropic', 'claude-x', { inputTokens: 1000, outputTokens: 200 }),
    ).toEqual({
      inputMicros: 3000,
      outputMicros: 3000,
      totalMicros: 6000,
      priced: true,
    });
  });

  it('prefers exact model entries over globs', () => {
    expect(
      model.modelCall('anthropic', 'claude-cheap', { inputTokens: 1_000_000, outputTokens: 0 })
        .totalMicros,
    ).toBe(1_000_000);
    expect(model.toolCall('anthropic', 'claude-cheap')).toBe(1000);
    expect(model.toolCall('anthropic', 'claude-x')).toBe(0);
    expect(model.toolCall('nope', 'x')).toBe(0);
  });

  it('flags unpriced models', () => {
    expect(model.modelCall('openai', 'gpt-x', { inputTokens: 5, outputTokens: 5 })).toEqual({
      inputMicros: 0,
      outputMicros: 0,
      totalMicros: 0,
      priced: false,
    });
  });

  it('includes free defaults for local providers', () => {
    expect(model.modelCall('simulated', 'sim-1', { inputTokens: 9, outputTokens: 9 }).priced).toBe(
      true,
    );
    expect(new CostModel([], false).entries()).toEqual([]);
    expect(model.entries().length).toBe(DEFAULT_PRICE_TABLE.length + 2);
  });

  it('loads price tables from JSON', () => {
    const m = CostModel.fromJson(
      JSON.stringify([
        { provider: 'openai', model: 'gpt-4o', inputPerMTok: 2.5, outputPerMTok: 10 },
      ]),
    );
    expect(m.modelCall('openai', 'gpt-4o', { inputTokens: 2, outputTokens: 1 }).totalMicros).toBe(
      15,
    );
    expect(CostModel.fromJson(undefined).entries()).toEqual(DEFAULT_PRICE_TABLE);
    expect(() => CostModel.fromJson('[{"provider":"x"}]')).toThrow();
  });

  it('converts units', () => {
    expect(microsToUsd(1_500_000)).toBe(1.5);
    expect(usdToMicros(0.0000015)).toBe(2);
  });
});
