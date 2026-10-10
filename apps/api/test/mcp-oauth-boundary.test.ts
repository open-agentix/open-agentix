import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ADR 0016 section 7.5: only the api and the trusted worker may read a token. Run nodes, harnesses
 * and models run code from `packages/*` and the node entry points; none of it may import the
 * credentials module, the key service or the token tables.
 */
const ROOT = join(import.meta.dirname, '../../..');
const FORBIDDEN =
  /mcp-oauth|mcpOauthTokens|mcpOauthClients|tenantDataKeys|McpCredentials|KeyService/;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', 'test', 'tests'].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

describe('token boundary', () => {
  it.each(['packages', 'apps/ui', 'toolboxes'])(
    '%s never references the credentials or key service',
    (dir) => {
      if (!existsSync(join(ROOT, dir))) return;
      const files = sources(join(ROOT, dir));
      const hits = files.filter((f) => FORBIDDEN.test(readFileSync(f, 'utf8')));
      expect(hits).toEqual([]);
    },
  );

  it('the worker app does not import the key service or the token tables', () => {
    const files = sources(join(ROOT, 'apps/worker/src')).filter((f) =>
      /mcp-oauth|tenantDataKeys|mcpOauthTokens/.test(readFileSync(f, 'utf8')),
    );
    expect(files).toEqual([]);
  });
});
