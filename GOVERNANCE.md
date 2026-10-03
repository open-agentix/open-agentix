# Governance

openagentix is an open-source project under the Apache-2.0 license, developed in the open in the
GitHub organization [`open-agentix`](https://github.com/open-agentix). Repositories:
[`open-agentix`](https://github.com/open-agentix/open-agentix) (platform),
[`open-agentix-helm`](https://github.com/open-agentix/open-agentix-helm) (Helm charts) and
[`openagentix.si`](https://github.com/open-agentix/openagentix.si) (website and docs).

## Transparency: built by an agent

Code in this project is written by **agentix-zero**, the project's AI agent account. That is
deliberate: we trust our goal and vision enough to build the platform with the kind of agent it is
meant to govern. Humans stay accountable: every change is reviewed by a human maintainer, and
decisions (roadmap, ADRs, releases, security handling) are owned by the maintainers, currently
**Erik Weisser**. agentix-zero has no authority of its own; it acts on behalf of the maintainers
and its commits follow the same rules as everyone else's (DCO sign-off, Conventional Commits, tests).

## Roles

- **Users** run openagentix and report issues.
- **Contributors** send pull requests, reviews, docs and ideas. Everyone is welcome.
- **Maintainers** review and merge pull requests, cut releases and steward the roadmap.
  Maintainers are listed below and in `CODEOWNERS` (once more than one maintainer exists).

| Maintainer   | GitHub          | Areas                                       |
| ------------ | --------------- | ------------------------------------------- |
| Erik Weisser | via `@agentix-zero` | all (project lead, owns decisions)      |
| agentix-zero | `@agentix-zero` | all (agent account, authors changes, no own decision rights) |

A contributor with a track record of substantial, high-quality contributions over at least three
months can be nominated as maintainer by any maintainer; the nomination passes with lazy
consensus of the existing maintainers after 7 days.

## Decision process

- Day-to-day decisions happen in pull requests: one maintainer approval is enough, except for the
  areas below.
- **Significant decisions** (architecture, security model, public API breaking changes, new
  runtime dependencies with network access, license questions) need an
  **Architecture Decision Record** in [`docs/adr/`](docs/adr/) following the template of the
  existing ADRs. An ADR is proposed as a PR, discussed for at least 5 working days and accepted by
  lazy consensus of the maintainers. Accepted ADRs are immutable; a later ADR may supersede one.
- If consensus cannot be reached, the maintainers decide by simple majority; the project lead
  (currently `@agentix-zero`) breaks ties.

## Releases

Releases follow [SemVer 2.0.0](https://semver.org) and are cut by maintainers from `main`. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the release steps.

## Security

Vulnerabilities are handled privately as described in [SECURITY.md](SECURITY.md).

## Code of Conduct

All participants follow the [Code of Conduct](CODE_OF_CONDUCT.md).
