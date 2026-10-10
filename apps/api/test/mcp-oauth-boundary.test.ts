import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ADR 0016 section 7.5: only the api and the trusted worker may read a token. Run nodes, harnesses
 * and models run code reachable from the run-node entry point (`apps/worker/src/run-node-cli.ts`)
 * and from `packages/*`; none of it may reach the credentials module, the key service or the token
 * tables, directly or through imports.
 */
const ROOT = join(import.meta.dirname, '../../..');
const FORBIDDEN_NAMES =
  /mcp-oauth|mcpOauthTokens|mcpOauthClients|tenantDataKeys|McpCredentials|KeyService/;
const API_IMPORT = /(?:from|import)\s*\(?\s*['"]@openagentix\/api['"]/;
const FORBIDDEN = { test: (text: string) => FORBIDDEN_NAMES.test(text) || API_IMPORT.test(text) };

const IMPORT = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

/** Source file behind an import specifier, or null for node builtins and third-party packages. */
function resolveImport(from: string, spec: string): string | null {
  if (spec.startsWith('.')) {
    const base = resolve(dirname(from), spec.replace(/\.js$/, ''));
    for (const c of [`${base}.ts`, join(base, 'index.ts')]) if (existsSync(c)) return c;
    return null;
  }
  const pkg = /^@openagentix\/([\w-]+)/.exec(spec);
  return pkg ? join(ROOT, 'packages', pkg[1] as string, 'src/index.ts') : null;
}

/** Every source file reachable from `entry`, following relative and workspace imports. */
function reachable(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const todo = [entry];
  while (todo.length > 0) {
    const file = todo.pop() as string;
    if (seen.has(file) || !existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    seen.set(file, text);
    for (const m of text.matchAll(IMPORT)) {
      const next = resolveImport(file, m[1] as string);
      if (next) todo.push(next);
    }
  }
  return seen;
}

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
  it('the run-node entry point reaches no module that can read or decrypt a token', () => {
    const graph = reachable(join(ROOT, 'apps/worker/src/run-node-cli.ts'));
    expect(graph.size).toBeGreaterThan(20); // the walk really followed the imports
    const hits = [...graph].filter(([, text]) => FORBIDDEN.test(text)).map(([f]) => f);
    expect(hits).toEqual([]);
  });

  it('the walker would see a violation (self-test with a planted import)', () => {
    const planted = new Map([
      ['x.ts', `import { McpCredentials } from '../api/src/mcp-oauth/index.js';`],
    ]);
    expect([...planted].filter(([, t]) => FORBIDDEN.test(t))).toHaveLength(1);
  });

  it.each(['packages', 'apps/ui', 'toolboxes'])(
    '%s never references the credentials or key service',
    (dir) => {
      if (!existsSync(join(ROOT, dir))) return;
      const hits = sources(join(ROOT, dir)).filter((f) => FORBIDDEN.test(readFileSync(f, 'utf8')));
      expect(hits).toEqual([]);
    },
  );

  it('the worker app touches the key service and the token tables only through createServices', () => {
    const files = sources(join(ROOT, 'apps/worker/src')).filter((f) =>
      /mcp-oauth|tenantDataKeys|mcpOauthTokens|mcpOauthClients|McpCredentials|KeyService/.test(
        readFileSync(f, 'utf8'),
      ),
    );
    expect(files).toEqual([]);
  });
});
