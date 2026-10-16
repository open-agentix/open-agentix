import { describe, expect, it } from 'vitest';
import { PINNED_AWP_FEATURES } from '../src/index.js';
import { pinnedSchema } from './awp-pin.js';

describe('exporter and the pinned AWP version', () => {
  it('knows whether the pinned schema offers metadata.requiredExtensions (AEP-0011)', () => {
    const defs = pinnedSchema.$defs as Record<string, { properties: Record<string, unknown> }>;
    const offered = 'requiredExtensions' in defs.Metadata!.properties;
    // A pin upgrade that adds the field must switch the exporter on purpose (decision D3).
    expect(PINNED_AWP_FEATURES.requiredExtensions).toBe(offered);
  });
});
