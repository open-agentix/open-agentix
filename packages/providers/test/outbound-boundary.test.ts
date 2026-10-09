import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Boundary test (ADR 0011, amendment 3): outbound HTTP(S) clients are created in ONE place, the
 * dispatcher factory `packages/providers/src/outbound.ts`. A new direct `fetch(`, `undici` import
 * or Node http(s) client in production code fails this test. Keep this list in sync with the
 * `no-restricted-*` override in `eslint.config.js`.
 *
 * Allowed exceptions (each with its reason); the first group is scheduled to move to the factory
 * with the remaining clients (issue #100), the second group are servers or local-socket clients.
 */
export const ALLOWED: Record<string, string> = {
  // --- to be migrated to the factory (#100) ---
  'packages/providers/src/proxy.ts': 'legacy proxy-aware fetch, used by the clients below',
  'packages/mcp/src/connection.ts': 'MCP client transports use createProxyAwareFetch (#100)',
  'packages/events/src/change-gate.ts': 'change-gate webhook call (#100)',
  'packages/runners/src/http-control-plane.ts': 'run-node control plane client (#103)',
  'apps/api/src/auth/oidc.ts': 'OIDC discovery/token via createProxyAwareFetch (#100)',
  'apps/api/src/services/ingest.ts': 'ingest probe via createProxyAwareFetch (#100)',
  // --- not outbound clients to arbitrary destinations ---
  'packages/mcp/src/gate-http.ts': 'HTTP server (node:http createServer)',
  'apps/worker/src/http.ts': 'HTTP server (node:http createServer)',
  'packages/runners/src/kube-client.ts': 'Kubernetes API of the cluster, fixed in-cluster endpoint',
  'packages/runners/src/container-hijack.ts': 'container engine socket (local)',
  'packages/runners/src/container-engine.ts': 'container engine socket (local)',
  'packages/runners/src/egress-proxy.ts': 'run-node egress proxy server (upstream proxy: #103)',
};

const FORBIDDEN = [
  /(^|[^.\w$])fetch\(/,
  /\bglobalThis\.fetch\b/,
  /from 'undici'/,
  /require\('undici'\)/,
  /from 'node:https?'/,
  /from 'https?'/,
  /from 'https-proxy-agent'/,
  /\bcreateProxyAwareFetch\b/,
];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* sources(full);
    else if (/\.(ts|mjs|js)$/.test(name) && !name.endsWith('.d.ts')) yield full;
  }
}

describe('outbound boundary', () => {
  it('has no direct fetch/undici/http(s) client outside the factory', () => {
    const offenders: string[] = [];
    for (const area of ['packages', 'apps']) {
      for (const pkg of readdirSync(path.join(root, area))) {
        if (pkg === 'ui') continue; // browser code
        const src = path.join(root, area, pkg, 'src');
        try {
          statSync(src);
        } catch {
          continue;
        }
        for (const file of sources(src)) {
          const rel = path.relative(root, file).split(path.sep).join('/');
          if (rel === 'packages/providers/src/outbound.ts' || rel in ALLOWED) continue;
          const text = readFileSync(file, 'utf8');
          const hit = FORBIDDEN.find((re) => re.test(text));
          if (hit) offenders.push(`${rel} (${hit})`);
        }
      }
    }
    expect(offenders, 'use createOutboundDispatcher or document an exception').toEqual([]);
  });

  it('lists only files that still exist and still need the exception', () => {
    for (const rel of Object.keys(ALLOWED)) {
      const text = readFileSync(path.join(root, rel), 'utf8');
      expect(
        FORBIDDEN.some((re) => re.test(text)),
        `${rel} no longer needs its exception`,
      ).toBe(true);
    }
  });
});
