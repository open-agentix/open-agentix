# apps/ui (placeholder)

The web UI (React 19, Vite, TanStack Router/Query, i18n en/de with browser language detection,
accessible and responsive) is built in a separate step against the API contract:

- OpenAPI 3.1: [`/openapi.yaml`](../../openapi.yaml) (also served at `GET /openapi.json`)
- Configuration and UI integration notes: [`docs/configuration.md`](../../docs/configuration.md#what-the-ui-needs)

This directory intentionally contains no package yet, so the workspace builds without it.
