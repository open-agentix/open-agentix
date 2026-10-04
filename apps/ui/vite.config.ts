import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const apiTarget = process.env.OAX_API_URL ?? 'http://localhost:8080';

/**
 * Adds a strict Content-Security-Policy to the production index.html. The UI never talks to
 * third parties: scripts, styles and fonts come from the same origin, API calls go to the same
 * origin or to the configured VITE_OAX_API_URL.
 */
function contentSecurityPolicy(): Plugin {
  return {
    name: 'oax-csp',
    apply: 'build',
    transformIndexHtml(html) {
      const api = process.env.VITE_OAX_API_URL
        ? ` ${new URL(process.env.VITE_OAX_API_URL).origin}`
        : '';
      const csp = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self'",
        "img-src 'self' data:",
        `connect-src 'self'${api}`,
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; ');
      return html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`,
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],
  server: {
    port: 5173,
    proxy: {
      '/v1': { target: apiTarget, changeOrigin: true },
      '/healthz': { target: apiTarget, changeOrigin: true },
    },
  },
  preview: {
    proxy: {
      '/v1': { target: apiTarget, changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
    modulePreload: { polyfill: false },
    reportCompressedSize: false,
  },
});
