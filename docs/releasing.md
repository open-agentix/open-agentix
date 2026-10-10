# Releasing and running workflows on demand

## Running CI on demand

`ci.yml` has a `workflow_dispatch` trigger next to `push` (main) and `pull_request`. It runs the full
pipeline (lint, typecheck, tests with the coverage gate, build, container image builds without push)
against the ref you choose; the `pr-title` job only runs for pull requests and is skipped.

A maintainer starts it with:

```sh
gh workflow run ci.yml --ref <branch>
gh run list --workflow ci.yml --branch <branch> --limit 3
gh run watch <run-id>
```

The same works in the GitHub UI (Actions, CI, "Run workflow", pick the branch). This is the path to
use when push and pull request events do not start runs (for example when the author account cannot
run Actions): the author pushes the branch, a maintainer dispatches CI for it and reports the result
on the pull request. Runs of the same ref cancel each other (`concurrency`), so dispatch once per push.

`catalog-refresh.yml` (weekly model catalog refresh) can be started the same way:
`gh workflow run catalog-refresh.yml`. Dependabot runs are managed by GitHub.

## Release flow

Releases are tag driven. A tag `vX.Y.Z` (or `vX.Y.Z-rc.1`) on a commit of `main` starts `release.yml`:
images `api`, `worker` and `ui` are built, pushed to GHCR, signed with cosign (keyless), get an SBOM
attestation and provenance, then the GitHub release is created from the `CHANGELOG.md` section.

1. Prepare the release pull request: bump the version, move `[Unreleased]` entries to
   `## [X.Y.Z] - YYYY-MM-DD`, update the compare links (commit `chore(release): X.Y.Z`), merge it.
2. Tag the merge commit on `main` and push the tag (`git tag -s vX.Y.Z`, then push that one tag).
3. If the tag push did not start the workflow, a maintainer starts it manually (below).

Pre-release tags (`vX.Y.Z-rc.1`) never get the `latest` or `X.Y` image tags and are marked as
pre-release on GitHub.

### Manual dispatch of a release

```sh
gh workflow run release.yml --ref main -f tag=vX.Y.Z
```

The workflow never creates or moves tags. The `verify` job runs first and fails the run before
anything is built or published unless all of these hold:

- the tag matches `vX.Y.Z` or `vX.Y.Z-pre`,
- the tag exists in the repository,
- the tagged commit is an ancestor of `main` (dispatch only),
- no GitHub release for the tag exists yet (dispatch only),
- `CHANGELOG.md` at the tagged commit contains a `## [X.Y.Z]` section (also for tag pushes).

All build and release jobs check out the tag, not the branch the workflow was started from, and use
the tag as the `VERSION` build argument and for the image tags. A dispatch can publish signed images
and a release, so only maintainers should run it, and only for tags that passed review. Rollback of a
bad release: delete the GitHub release, publish a fixed patch version; do not reuse a published tag.
