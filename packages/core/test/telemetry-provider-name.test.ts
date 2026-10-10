import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTE_SPECS,
  genAiProviderName,
  sanitizeAttributes,
  ContextGuard,
} from '../src/index.js';

describe('genAiProviderName', () => {
  it('maps the adapter family to the convention value', () => {
    expect(genAiProviderName('openai', 'azure-openai')).toBe('azure.ai.openai');
    expect(genAiProviderName('bedrock', 'bedrock')).toBe('aws.bedrock');
    expect(genAiProviderName('openai', 'openrouter')).toBe('openrouter');
    expect(genAiProviderName('openai', 'vllm')).toBe('vllm');
    expect(genAiProviderName('anthropic')).toBe('anthropic');
    expect(genAiProviderName('simulated', 'simulated')).toBe('simulated');
  });

  it('falls back to the closed adapter kind for an unknown family, never echoes input', () => {
    expect(genAiProviderName('openai', 'my-connection-name')).toBe('openai');
    expect(genAiProviderName('openai', '__proto__')).toBe('openai');
    expect(genAiProviderName('something-new', 'also-new')).toBe('other');
    expect(genAiProviderName('constructor')).toBe('other');
  });

  it('always yields a value the allowlist accepts', () => {
    for (const [kind, family] of [
      ['openai', 'azure-openai'],
      ['x', 'y'],
      ['bedrock', undefined],
    ] as const) {
      const r = sanitizeAttributes(
        'chat',
        { 'gen_ai.provider.name': genAiProviderName(kind, family) },
        new ContextGuard(),
      );
      expect(r.dropped).toEqual({});
    }
  });
});

describe('executor event attributes', () => {
  it('are on the agent span and bounded', () => {
    const r = sanitizeAttributes(
      'invoke_agent',
      {
        'oax.control.action': 'kill',
        'oax.control.rules': ['budget_cost', 'Not A Rule!', 'x'.repeat(40)],
        'oax.guard.source': 'tool_result',
        'oax.guard.secret_kinds': ['private-key', 'sk-LEAK-LIKE-VALUE-123456789'],
        'oax.validation.violations': 3,
        'oax.control.message': 'free text is not a key',
      },
      new ContextGuard(),
    );
    expect(r.attributes['oax.control.rules']).toEqual(['budget_cost']);
    expect(r.attributes['oax.guard.secret_kinds']).toEqual(['private-key']);
    expect(r.dropped.unknown).toBe(1);
    expect(Object.keys(ATTRIBUTE_SPECS)).toContain('oax.validation.attempt');
  });
});
