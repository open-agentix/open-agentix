// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', 'apps/api/drizzle/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['**/*.mjs', '**/*.js', '**/*.cjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
  {
    // ADR 0011: outbound HTTP(S) clients are created by the dispatcher factory only
    // (packages/providers/src/outbound.ts). Exceptions are listed in
    // packages/providers/test/outbound-boundary.test.ts, which enforces the same rule.
    files: ['packages/*/src/**/*.ts', 'apps/api/src/**/*.ts', 'apps/worker/src/**/*.ts'],
    ignores: [
      'packages/providers/src/outbound.ts',
      'packages/providers/src/proxy.ts',
      'packages/mcp/src/connection.ts',
      'packages/mcp/src/gate-http.ts',
      'packages/events/src/change-gate.ts',
      'packages/runners/src/{http-control-plane,kube-client,container-hijack,container-engine,egress-proxy}.ts',
      'apps/api/src/auth/oidc.ts',
      'apps/api/src/services/ingest.ts',
      'apps/worker/src/http.ts',
    ],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Use createOutboundDispatcher (ADR 0011).' },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'undici', message: 'Use createOutboundDispatcher (ADR 0011).' },
            { name: 'node:http', message: 'Use createOutboundDispatcher (ADR 0011).' },
            { name: 'node:https', message: 'Use createOutboundDispatcher (ADR 0011).' },
            {
              name: '@openagentix/providers',
              importNames: ['createProxyAwareFetch'],
              message: 'Use createOutboundDispatcher (ADR 0011).',
            },
            { name: 'https-proxy-agent', message: 'Use createOutboundDispatcher (ADR 0011).' },
          ],
        },
      ],
    },
  },
  {
    files: ['**/test/**', '**/*.test.ts', 'scripts/**', '**/cli.ts'],
    rules: { 'no-console': 'off' },
  },
);
