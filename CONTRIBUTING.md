# Contributing to openagentix

Thanks for helping! This document explains how we work. By participating you agree to the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Ground rules

- **English** for code, comments, commit messages, issues and PRs.
- **Small, reviewable commits**: one concern per commit. A reviewer should be able to follow the
  history commit by commit.
- **Tests ship with the code they cover** (same commit). The coverage gate is **>= 80 %** for
  lines, branches, functions and statements and is enforced in `vitest.config.ts` and CI.
- **No outbound calls at run time** except to configured providers, MCP servers and event sources.
  Never add code that downloads prompts, skills, rules or tools from the internet at run time.
- **Secrets never go into prompts, agent files, logs or audit payloads.** Use secret references.

## Developer Certificate of Origin (DCO)

All commits must be signed off. The sign-off certifies that you wrote the patch or otherwise have
the right to submit it under the Apache-2.0 license
([developercertificate.org](https://developercertificate.org/)):

```bash
git commit -s -m "feat(core): add argument constraint for enums"
```

This adds `Signed-off-by: Your Name <you@example.com>` to the message. PRs with unsigned commits
cannot be merged.

## Conventional Commits 1.0.0

Commit subjects (and PR titles) follow
[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>(<scope>)<!>: <description in imperative mood, max. 100 chars>
```

- Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- Scopes: `core`, `providers`, `events`, `mcp`, `runners`, `api`, `worker`, `ui`, `deps`, `docker`, `ci`.
- Breaking change: `!` after the type/scope or a `BREAKING CHANGE:` footer.
- Dependency updates: `build(deps): ...`, security fixes `fix(deps): ...`.

## Semantic Versioning 2.0.0

The project version (root `package.json`) follows [SemVer](https://semver.org):
`fix` -> PATCH, `feat` -> MINOR, breaking change -> MAJOR. Before 1.0.0 breaking changes may land in
a MINOR release and are flagged in the changelog. A release bumps the version, updates
[CHANGELOG.md](CHANGELOG.md) (Keep a Changelog), creates the tag `vX.Y.Z` and a GitHub release.

## Running locally

Requirements: Node.js 22 LTS (20.19+ works), pnpm 10 (`corepack enable` or a pinned install),
Docker only if you want to run the full stack.

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test:coverage     # unit + integration tests, PGlite embedded Postgres, no Docker needed
pnpm build
```

Run the stack:

```bash
docker compose up --build            # postgres + api + worker
docker compose --profile ollama up   # additionally a local Ollama
```

Run an agent file on your machine without any server:

```bash
pnpm build
node packages/runners/dist/cli.js run examples/cve-triage.agents.md --event examples/events/trivy-finding.json
```

If you change an API route, regenerate the OpenAPI document (a test fails when it is stale):

```bash
pnpm --filter @openagentix/api openapi
```

If you change the database schema, add a migration:

```bash
pnpm --filter @openagentix/api db:generate
```

## Pull requests

1. Fork, branch from `main` (`feat/<short-name>`), keep the PR focused.
2. Fill in the PR template, link issues, describe risk and rollback.
3. CI must be green: lint, typecheck, tests with coverage gate, build, container image build.
4. Architectural decisions get an ADR in [`docs/adr/`](docs/adr/) (see [GOVERNANCE.md](GOVERNANCE.md)).
5. A maintainer reviews and squash-merges with a Conventional Commit title.

## Adding dependencies

- Exact versions only (`save-exact=true`), committed `pnpm-lock.yaml`, CI uses `--frozen-lockfile`.
- Prefer small, well-maintained packages; no packages that fetch code or instructions at run time.
- Packages with install scripts must be added to `onlyBuiltDependencies` in `pnpm-workspace.yaml`
  with a justification in the PR.
