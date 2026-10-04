import { describe, expect, it } from 'vitest';
import { UsageMeter } from '../../src/index.js';

describe('UsageMeter', () => {
  it('uses provider usage for a complete stream', () => {
    const m = new UsageMeter();
    m.report({ inputTokens: 100, outputTokens: 1, cacheReadTokens: 40, cacheWriteTokens: 5 });
    m.report({ outputTokens: 50 });
    m.addOutput('x'.repeat(150));
    const s = m.settle(true, 999);
    expect(s).toMatchObject({
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 40, cacheWriteTokens: 5 },
      source: 'provider',
      usageReported: true,
      floorApplied: false,
      outputBytes: 150,
    });
  });

  it('flags missing usage for the estimator fallback (input estimate, output from bytes)', () => {
    const m = new UsageMeter();
    m.addOutput('é'.repeat(30)); // 60 bytes
    const s = m.settle(true, 321);
    expect(s.usageReported).toBe(false);
    expect(s.source).toBe('estimated');
    expect(s.usage).toMatchObject({ inputTokens: 321, outputTokens: 20 });
  });

  it('settles a cut stream at least at the estimate, never below what streamed', () => {
    const m = new UsageMeter();
    m.report({ inputTokens: 10, outputTokens: 2 }); // message_start counters
    m.addOutput('y'.repeat(300));
    const s = m.settle(false);
    expect(s.source).toBe('estimated');
    expect(s.usageReported).toBe(false);
    expect(s.usage.outputTokens).toBe(100);
    expect(s.usage.inputTokens).toBe(10);
  });

  it('applies the floor against implausibly low reported output', () => {
    const m = new UsageMeter();
    m.report({ inputTokens: 5, outputTokens: 1 });
    m.addOutput('z'.repeat(800));
    const s = m.settle(true);
    expect(s).toMatchObject({ source: 'floor', floorApplied: true });
    expect(s.usage.outputTokens).toBe(100);
  });

  it('is estimated when only output was reported', () => {
    const m = new UsageMeter();
    m.report({ outputTokens: 7 });
    expect(m.settle(true, 12)).toMatchObject({ source: 'estimated', usage: { inputTokens: 12 } });
  });

  it('ignores negative, fractional, huge and non-numeric values', () => {
    const m = new UsageMeter();
    m.report({
      inputTokens: -1,
      outputTokens: 1.5,
      cacheReadTokens: '9',
      cacheWriteTokens: Number.MAX_SAFE_INTEGER + 10,
    });
    expect(m.snapshot()).toEqual({
      outputBytes: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      usageReported: false,
    });
    m.addOutput('');
    expect(m.outputBytes).toBe(0);
  });
});
