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

describe('CostModel cache prices', () => {
  const usage = {
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 2000,
    cacheWriteTokens: 400,
  };

  it('falls back to input price for reads and 1.25 x input for writes', () => {
    const m = new CostModel([
      entry({ provider: 'p', model: 'm', inputPerMTok: 4, outputPerMTok: 20 }),
    ]);
    expect(m.modelCall('p', 'm', usage)).toEqual({
      inputMicros: 4000,
      outputMicros: 2000,
      cacheMicros: 8000 + 2000,
      totalMicros: 4000 + 2000 + 10_000,
      priced: true,
    });
  });

  it('uses explicit cache prices when present (including zero)', () => {
    const m = new CostModel([
      entry({
        provider: 'p',
        model: 'm',
        inputPerMTok: 4,
        outputPerMTok: 20,
        cacheReadPerMTok: 0.4,
        cacheWritePerMTok: 5,
      }),
      entry({
        provider: 'p',
        model: 'free',
        inputPerMTok: 4,
        outputPerMTok: 20,
        cacheReadPerMTok: 0,
        cacheWritePerMTok: 0,
      }),
    ]);
    expect(m.modelCall('p', 'm', usage).cacheMicros).toBe(800 + 2000);
    expect(m.modelCall('p', 'free', usage).cacheMicros).toBe(0);
  });

  it('keeps the old shape without cache tokens and ignores negative counts', () => {
    const m = new CostModel([
      entry({ provider: 'p', model: 'm', inputPerMTok: 4, outputPerMTok: 20 }),
    ]);
    expect(m.modelCall('p', 'm', { inputTokens: 10, outputTokens: 1 })).not.toHaveProperty(
      'cacheMicros',
    );
    expect(
      m.modelCall('p', 'm', { inputTokens: 0, outputTokens: 0, cacheReadTokens: -5 }),
    ).not.toHaveProperty('cacheMicros');
  });

  it('an unpriced model stays unpriced with cache tokens', () => {
    expect(new CostModel().modelCall('x', 'y', usage)).toEqual({
      inputMicros: 0,
      outputMicros: 0,
      totalMicros: 0,
      priced: false,
    });
  });
});
