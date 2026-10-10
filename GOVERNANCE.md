# Governance

openagentix is an open-source project under the Apache-2.0 license, developed in the open in the
GitHub organization [`open-agentix`](https://github.com/open-agentix). Repositories:
[`open-agentix`](https://github.com/open-agentix/open-agentix) (platform),
[`open-agentix-helm`](https://github.com/open-agentix/open-agentix-helm) (Helm charts) and
[`openagentix.si`](https://github.com/open-agentix/openagentix.si) (website and docs).

## Transparency: built by an agent

Code in this project is written by **agentix-zero**, the project's AI agent account. That is
deliberate: we trust our goal and vision enough to build the platform with the kind of agent it is
meant to govern. The maintainers stay accountable: they set the direction and own the decisions
(roadmap, ADRs, releases, security handling), currently **the project lead** (see the table
below). agentix-zero has no authority of its own; it acts on behalf of the maintainers and its
commits follow the same rules as everyone else's (DCO sign-off, Conventional Commits, tests).

## How changes are reviewed

The platform is built mostly by AI agents under the maintainer's direction.

- Pull requests are authored by agents (the implementation model).
- A second, independent review agent (a stronger model) reviews each pull request. For
  security-relevant changes this is a dedicated adversarial security review with a fix round and
  real test runs.
- The lead agent merges (squash merge) under the maintainer's standing authorisation.
- There is **no guarantee that a human reads every change before it is merged.**
- The maintainer sets the direction, answers design questions, can inspect, revert and block
  changes at any time, and decides on releases.
- External contributions from people are reviewed by the maintainer.

Requiring a human approval for sensitive paths (for example authentication, tenancy, runners and
migrations) through `CODEOWNERS` and branch protection is possible and planned as an optional
governance setting. It is not enforced today.

This is about how this repository is developed. The runtime approval of agent actions
(approval steps in `agents.md`) is a separate product feature and is unchanged.

**How to verify:** the pull request history shows who authored, reviewed and merged each change
and keeps the review comments; the [ADRs](docs/adr/) record the significant decisions; the
[CHANGELOG](CHANGELOG.md) lists what shipped in each release.

## Roles

- **Users** run openagentix and report issues.
- **Contributors** send pull requests, reviews, docs and ideas. Everyone is welcome.
- **Maintainers** set the direction, review pull requests from people, cut releases and steward
  the roadmap.
  Maintainers are listed below and in `CODEOWNERS` (once more than one maintainer exists).

| Maintainer   | GitHub          | Areas                                       |
| ------------ | --------------- | ------------------------------------------- |
| Project lead | via `@agentix-zero` | all (owns decisions)                    |
| agentix-zero | `@agentix-zero` | all (agent account, authors changes, no own decision rights) |

A contributor with a track record of substantial, high-quality contributions over at least three
months can be nominated as maintainer by any maintainer; the nomination passes with lazy
consensus of the existing maintainers after 7 days.

## Decision process

- Day-to-day decisions happen in pull requests (see [How changes are reviewed](#how-changes-are-reviewed));
  one approval is enough, except for the areas below.
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
