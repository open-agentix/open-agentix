import { describe, expect, it } from 'vitest';
import { PROVIDER_KINDS, harnessSurface, surfaceOfProviderKind } from '../src/index.js';

describe('harness surfaces (ADR 0009 section 10)', () => {
  it('maps every provider kind to the protocol it speaks upstream', () => {
    expect(PROVIDER_KINDS.map((k) => [k, surfaceOfProviderKind(k)])).toEqual([
      ['openai', 'openai'],
      ['ollama', 'openai'],
      ['anthropic', 'anthropic'],
      ['bedrock', 'anthropic'],
      ['simulated', 'anthropic'],
    ]);
  });

  it('lets Claude Code use the Anthropic surface only and OpenCode both', () => {
    expect(harnessSurface('claude-code', 'anthropic')).toBe('anthropic');
    expect(harnessSurface('claude-code', 'bedrock')).toBe('anthropic');
    expect(harnessSurface('claude-code', 'simulated')).toBe('anthropic');
    expect(harnessSurface('claude-code', 'openai')).toBeNull();
    expect(harnessSurface('claude-code', 'ollama')).toBeNull();
    expect(harnessSurface('opencode', 'openai')).toBe('openai');
    expect(harnessSurface('opencode', 'anthropic')).toBe('anthropic');
  });
});
