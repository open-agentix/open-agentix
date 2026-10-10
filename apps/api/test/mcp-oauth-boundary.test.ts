import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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
/** The api package by its bare name, any subpath of it, and the same through `require` or `import()`. */
const API_IMPORT =
  /(?:from\s*['"]|import\s*['"]|(?:import|require)\s*\(\s*['"`])@openagentix\/api(?:\/[^'"`]*)?['"`]/;
const FORBIDDEN = { test: (text: string) => FORBIDDEN_NAMES.test(text) || API_IMPORT.test(text) };

const IMPORT = /(?:from\s*['"]|import\s*['"]|(?:import|require)\s*\(\s*['"`])([^'"`]+)['"`]/g;

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

  it('the walker follows a planted chain and flags every way of reaching the api package', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oax-boundary-'));
    try {
      const flagged = (name: string, body: string) => {
        writeFileSync(join(dir, `${name}-leaf.ts`), body);
        writeFileSync(join(dir, `${name}.ts`), `import './${name}-leaf.js';\n`);
        return [...reachable(join(dir, `${name}.ts`))].filter(([, t]) => FORBIDDEN.test(t));
      };
      expect(flagged('bare', `import { x } from '@openagentix/api';`)).toHaveLength(1);
      expect(
        flagged('subpath', `import { x } from '@openagentix/api/dist/mcp-oauth/index.js';`),
      ).toHaveLength(1);
      expect(
        flagged('require', `const x = require('@openagentix/api/dist/index.js');`),
      ).toHaveLength(1);
      expect(flagged('dynamic', `const x = await import('@openagentix/api');`)).toHaveLength(1);
      expect(flagged('template', 'const x = await import(`@openagentix/api`);')).toHaveLength(1);
      expect(flagged('named', `export const k = new McpCredentials();`)).toHaveLength(1);
      expect(flagged('clean', `import { y } from '@openagentix/core';`)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
