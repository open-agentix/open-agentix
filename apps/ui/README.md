# @openagentix/ui – control node web UI

React 19 + Vite + TypeScript (strict) + TanStack Router/Query. English and German, light and dark
theme, responsive down to phone width, WCAG 2.2 AA as the target. The UI never talks to third
parties: fonts and icons are bundled, the production build ships a strict Content-Security-Policy.

## Run

```sh
pnpm install                       # from the repository root
pnpm --filter @openagentix/ui dev  # http://localhost:5173, proxies /v1 to OAX_API_URL
```

The dev server proxies `/v1` to `OAX_API_URL` (default `http://localhost:8080`). For a control node
on another origin set `VITE_OAX_API_URL` at build time and add the UI origin to
`OAX_CORS_ORIGINS` on the API. For OIDC set `OAX_UI_URL` on the API to the UI origin; the API
redirects to `<OAX_UI_URL>/auth/callback#token=…`.

## Scripts

| Script               | What it does                                                                |
| -------------------- | --------------------------------------------------------------------------- |
| `pnpm gen:api`       | Regenerates `src/api/schema.d.ts` from `../../openapi.yaml` (`OPENAPI_FILE`) |
| `pnpm typecheck`     | `tsc --noEmit` (strict)                                                     |
| `pnpm test:coverage` | vitest + Testing Library + MSW + axe; coverage gate 80 % (all metrics)      |
| `pnpm build`         | Type-check and production build to `dist/`                                  |
| `pnpm size`          | Fails when the initial JS exceeds 200 KB gzip (`UI_JS_BUDGET_KB`)           |
| `pnpm check:offline` | Fails when `dist/` references any third-party host                          |

## Structure

- `src/api` – generated OpenAPI types, typed `openapi-fetch` client, query definitions.
- `src/auth` – session (sessionStorage), `/v1/me` permissions, `useCan`/`<Can>` for RBAC in the UI
  (the API stays the authority).
- `src/i18n` – tiny typed i18n; `locales/en.json` is the source of truth, `de.json` must have the
  same keys (tested). Browser language detection with a remembered manual choice.
- `src/components`, `src/layout`, `src/styles` – design tokens (CSS variables), primitives,
  virtualised table, dialogs, toasts, app shell.
- `src/features/*` – one lazily loaded chunk per screen. Routes prefetch code and data on hover.
