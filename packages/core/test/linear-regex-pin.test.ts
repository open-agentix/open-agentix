import { describe, expect, it, vi } from 'vitest';

// The program size comes from a field that is internal to re2js. If a version does not have it, nothing
// may compile (everything denies): the check must fail closed, not run unbounded programs.
vi.mock('re2js', () => ({
  RE2JS: {
    CASE_INSENSITIVE: 2,
    compile: () => ({ matcher: () => ({ find: () => false }) }),
  },
}));

const { compileLinear } = await import('../src/agents/linear-regex.js');

describe('compileLinear without a readable program size', () => {
  it('refuses every pattern', () => {
    expect(compileLinear('a')).toBeNull();
    expect(compileLinear('^x$', true, false)).toBeNull();
  });
});
