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
  'packages/providers/src/network-guard.ts':
    'egress guard: patches net.Socket, creates no connection',
  'packages/mcp/src/gate-http.ts': 'HTTP server (node:http createServer)',
  'apps/worker/src/http.ts': 'HTTP server (node:http createServer)',
  'apps/worker/src/git/relay.ts':
    'loopback CONNECT relay server for the git child; upstream connections use dispatcher.dial',
  'packages/runners/src/kube-client.ts': 'Kubernetes API of the cluster, fixed in-cluster endpoint',
  'packages/runners/src/container-hijack.ts': 'container engine socket (local)',
  'packages/runners/src/container-engine.ts': 'container engine socket (local)',
  'packages/runners/src/egress-proxy.ts': 'run-node egress proxy server (upstream proxy: #103)',
};

const CLIENT_MODULES = '(?:undici|https?|node:https?|node:http2|http2|https-proxy-agent)';
const FORBIDDEN = [
  /(^|[^.\w$])fetch\(/,
  /\bglobalThis\.fetch\b/,
  new RegExp(`from '${CLIENT_MODULES}'`),
  new RegExp(`require\\(\\s*'${CLIENT_MODULES}'\\s*\\)`),
  // dynamic import() hides the client from the static import checks
  new RegExp(`import\\(\\s*['"\`]${CLIENT_MODULES}['"\`]\\s*\\)`),
  /\bcreateProxyAwareFetch\b/,
];

/** Names of node:net / node:tls that are address helpers or constants, not socket clients. */
const SAFE_NET_TLS = new Set(['isIP', 'isIPv4', 'isIPv6', 'rootCertificates', 'TLSSocket', 'type']);

/** True when the file imports a socket client (connect, Socket, default/namespace) from net/tls. */
export function importsSocketClient(text: string): boolean {
  const re =
    /import\s+([^;]*?)\s+from\s+'(?:node:)?(?:net|tls)'|import\(\s*'(?:node:)?(?:net|tls)'\s*\)|require\(\s*'(?:node:)?(?:net|tls)'\s*\)/g;
  for (const m of text.matchAll(re)) {
    const clause = m[1];
    if (clause === undefined) return true; // dynamic import / require
    if (/^type\s/.test(clause)) continue;
    const named = /^\{([^}]*)\}$/.exec(clause.trim());
    if (!named) return true; // default or namespace import
    const names = (named[1] ?? '')
      .split(',')
      .map(
        (n) =>
          n
            .trim()
            .replace(/^type\s+/, '')
            .split(/\s+as\s+/)[0] ?? '',
      )
      .filter(Boolean);
    if (names.some((n) => !SAFE_NET_TLS.has(n))) return true;
  }
  return false;
}

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
  it('recognises the client patterns it forbids', () => {
    const bad = [
      "const u = await import('undici');",
      'const h = await import("node:https");',
      "const h = require('http');",
      "import http2 from 'node:http2';",
      "import { connect } from 'node:tls';",
      "import * as net from 'node:net';",
      "import net from 'net';",
      "const { Socket } = await import('node:net');",
    ];
    for (const code of bad)
      expect(FORBIDDEN.some((re) => re.test(code)) || importsSocketClient(code), code).toBe(true);
    const good = [
      "import { isIP } from 'node:net';",
      "import { rootCertificates, type TLSSocket } from 'node:tls';",
      "import type { Socket } from 'node:net';",
    ];
    for (const code of good)
      expect(FORBIDDEN.some((re) => re.test(code)) || importsSocketClient(code), code).toBe(false);
  });

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
          else if (importsSocketClient(text)) offenders.push(`${rel} (node:net/node:tls client)`);
        }
      }
    }
    expect(offenders, 'use createOutboundDispatcher or document an exception').toEqual([]);
  });

  it('lists only files that still exist and still need the exception', () => {
    for (const rel of Object.keys(ALLOWED)) {
      const text = readFileSync(path.join(root, rel), 'utf8');
      expect(
        FORBIDDEN.some((re) => re.test(text)) || importsSocketClient(text),
        `${rel} no longer needs its exception`,
      ).toBe(true);
    }
  });
});
