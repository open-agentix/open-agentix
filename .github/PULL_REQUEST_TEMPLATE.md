## What and why

<!-- One concern per PR. Title follows Conventional Commits, e.g. `feat(core): add enum argument constraint`. -->

## How was it tested?

- [ ] Unit/integration tests added or updated in the same commit as the code
- [ ] `pnpm lint && pnpm typecheck && pnpm test:coverage` pass locally (coverage >= 80 %)
- [ ] `openapi.yaml` regenerated if routes changed (`UPDATE_OPENAPI=1 pnpm vitest run apps/api/test/routes.test.ts`)

## Risk and rollback

<!-- Data migrations? Security impact (policy engine, audit, RBAC, secrets)? How do we roll back? -->

## Checklist

- [ ] Commits are signed off (DCO: `git commit -s`)
- [ ] CHANGELOG.md updated under "Unreleased" for user-visible changes
- [ ] ADR added in `docs/adr/` for significant decisions
- [ ] No secrets, prompts or tools are fetched from the internet at run time
