# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased – UI]

### Added

- Web UI of the control node (`apps/ui`): React 19, Vite, TanStack Router/Query, typed API client
  generated from `openapi.yaml` (`pnpm gen:api`).
- Sign-in with OIDC (redirect), LDAP and local accounts; session expiry handling.
- Dashboard: runs today, success/failure, costs this month vs. team budgets, pending approvals,
  active policies, recent audit events, runners and providers.
- Agents: list, overview with runtime/toolbox/tools, `agents.md` editor with live validation,
  optimistic draft saves, version history, diff between versions, publish with confirmation,
  test runs with an example event.
- Workflow wizard for business users ("when … / check, do … / reply as …") that creates a draft
  `agents.md` for review and shows who must approve.
- Events & sources (webhook URLs, HMAC secret references, Kafka topics, cron schedules, mail-in,
  recent events), runs (filters, keyset pagination, virtualised table), live run detail over SSE
  with audit-gate decisions, costs, tokens, approvals and cancel.
- Connections (secrets by reference only), policies (bundles, audit-gate tester, budgets), audit
  trail (search, hash-chain verification, NDJSON export, checkpoints), costs, users/teams/RBAC
  matrix, API tokens, settings (providers, runners, Bedrock VPC endpoint/proxy configuration).
- English and German, light/dark theme, responsive layout, axe checks in tests, coverage gate
  80 %, bundle budget (initial JS < 200 KB gzip) and a third-party request scan of `dist/`.
