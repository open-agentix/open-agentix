import { describe, expect, it } from 'vitest';
import { ModelProxyUnavailableProvider } from '../src/index.js';

describe('model proxy placeholder (W1-3b)', () => {
  it('fails closed: a run node has no model access until the proxy exists', async () => {
    const p = new ModelProxyUnavailableProvider('anthropic');
    expect(p.name).toBe('anthropic');
    expect(p.clearance).toBe('restricted');
    await expect(p.complete()).rejects.toMatchObject({ code: 'model_proxy_unavailable' });
    await expect(p.complete()).rejects.toThrow(/W1-3b/);
  });
});
