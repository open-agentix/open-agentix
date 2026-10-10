import { describe, expect, it } from 'vitest';
import { mayFlow, type Classification } from '../src/classification.js';

describe('mayFlow', () => {
  it('allows equal or lower data classification', () => {
    expect(mayFlow('public', 'internal')).toBe(true);
    expect(mayFlow('internal', 'internal')).toBe(true);
    expect(mayFlow('confidential', 'internal')).toBe(false);
  });

  it('fails closed for an unknown level on either side', () => {
    const bogus = 'secret' as Classification;
    expect(mayFlow(bogus, 'restricted')).toBe(false);
    expect(mayFlow('public', bogus)).toBe(false);
    expect(mayFlow(bogus, bogus)).toBe(false);
  });
});
