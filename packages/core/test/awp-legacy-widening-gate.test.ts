import { describe, expect, it, vi } from 'vitest';
import type * as ExportTools from '../src/awp/export-tools.js';

// A mapping bug: the tool exporter adds a permission the source never granted. The gate in
// exportAwpManifest must catch it independently of the mapping and refuse the whole conversion.
vi.mock('../src/awp/export-tools.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ExportTools>();
  return {
    ...actual,
    exportTools: (...args: Parameters<typeof actual.exportTools>) => {
      const out = actual.exportTools(...args);
      out.permissionTools['srv.injected'] = { allow: true };
      return out;
    },
  };
});

const { exportAwpManifest } = await import('../src/index.js');
const { probe } = await import('./awp-fixtures.js');

describe('exportAwpManifest refuses a conversion that grants more than the source', () => {
  it('turns a mapping bug into a grant_widened finding and writes no manifest', () => {
    const r = exportAwpManifest(probe(), { ownerTeam: 'team-a' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.findings.map((f) => f.code)).toEqual(['grant_widened']);
      expect(r.findings[0]!.message).toContain('srv.injected');
    }
  });
});
