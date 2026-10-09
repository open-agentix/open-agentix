#!/usr/bin/env bash
# Builds the run-node image with the pinned Claude Code binary, smoke-tests it, pushes it to a PRIVATE
# GHCR package, verifies the package is private and prints the digest-pinned reference for
# OAX_CONTAINER_HARNESS_IMAGES (docs/runners.md, "Harness images").
#
# The Claude Code binary is proprietary: the image must never be public. Therefore
#  - the image carries no `org.opencontainers.image.source` label (GHCR would link the package to the
#    public repository and inherit its visibility); this script refuses to continue if the label exists,
#  - before the push it checks that `gh` can read the package visibility (refuses to push otherwise),
#  - after the push it re-reads the visibility and aborts loudly when the package is not private.
# Needs: docker login to ghcr.io (write:packages) and GH_TOKEN with read:packages for `gh api`.
# Heavy job: run it under the host's gate (see AGENTS.md "Betrieb").
# Builds for the host platform only. Multi-platform (amd64 + arm64) would need
#   docker buildx build --platform linux/amd64,linux/arm64 --push ...
# and would push an image index; both SHA-512 build args exist, the smoke test would then have to run
# per platform. Not done here on purpose (no emulated runs of the proprietary binary in CI).
# Usage: scripts/build-harness-image.sh <git-sha> [--no-push]
set -euo pipefail
SHA="${1:?usage: build-harness-image.sh <git-sha> [--no-push]}"
MODE="${2:-}"
REPO="${OAX_IMAGE_REPO:-ghcr.io/open-agentix/open-agentix-run-node-claude-code}"
BASE="${OAX_NODE_BASE:-node:22-alpine}"
cd "$(dirname "$0")/.."
[ "$(git rev-parse HEAD)" = "$(git rev-parse "$SHA")" ] || { echo "checkout $SHA first" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "working tree is not clean" >&2; exit 1; }
TAG="$(git rev-parse --short=12 HEAD)"

# Package visibility via the GitHub API: prints public|private|internal, fails if it cannot be read.
visibility() {
  local rest owner name out
  rest="${REPO#ghcr.io/}"
  owner="${rest%%/*}"
  name="${rest#*/}"
  name="${name//\//%2F}"
  for kind in orgs users; do
    if out="$(gh api "/${kind}/${owner}/packages/container/${name}" --jq .visibility 2>/dev/null)" && [ -n "$out" ]; then
      printf '%s\n' "$out"
      return 0
    fi
  done
  return 1
}

if [ "$MODE" != "--no-push" ]; then
  command -v gh >/dev/null || { echo "REFUSING TO PUSH: gh is needed to verify the package visibility" >&2; exit 1; }
  gh auth status >/dev/null 2>&1 || { echo "REFUSING TO PUSH: gh is not authenticated (set GH_TOKEN with read:packages)" >&2; exit 1; }
  # The visibility can only be read with a token that has a packages scope: without it a 404 would be
  # indistinguishable from "package does not exist yet", so this is checked before anything is pushed.
  gh api -i /user 2>/dev/null | grep -i '^x-oauth-scopes:' | grep -Eiq '(read|write):packages' \
    || { echo "REFUSING TO PUSH: the token has no read:packages scope, the package visibility cannot be verified" >&2; exit 1; }
  # If the package already exists it must already be private; a new package is checked after the push.
  if V="$(visibility)"; then
    [ "$V" = "private" ] || { echo "REFUSING TO PUSH: package ${REPO} is ${V}, it must be private" >&2; exit 1; }
  fi
fi

# Pin the base image by digest (the Dockerfile default is a moving tag): resolved from the registry now.
if [ -n "${OAX_NODE_IMAGE:-}" ]; then
  NODE_IMAGE="$OAX_NODE_IMAGE"
else
  NODE_DIGEST="$(docker buildx imagetools inspect "$BASE" --format '{{println .Manifest.Digest}}' | head -1 | tr -d '[:space:]')"
  printf '%s' "$NODE_DIGEST" | grep -Eq '^sha256:[a-f0-9]{64}$' || { echo "cannot resolve the digest of ${BASE}: '${NODE_DIGEST}'" >&2; exit 1; }
  NODE_IMAGE="${BASE}@${NODE_DIGEST}"
fi
echo "base image: ${NODE_IMAGE}"
docker build --target run-node-claude-code --build-arg "VERSION=${TAG}" --build-arg "NODE_IMAGE=${NODE_IMAGE}" -t "${REPO}:${TAG}" .
if [ "$(docker image inspect "${REPO}:${TAG}" --format '{{index .Config.Labels "org.opencontainers.image.source"}}')" != "" ]; then
  echo "image carries org.opencontainers.image.source: GHCR would link it to the public repository" >&2
  exit 1
fi
scripts/test-harness-image.sh "${REPO}:${TAG}"
[ "$MODE" = "--no-push" ] && { echo "built ${REPO}:${TAG} (not pushed)"; exit 0; }
docker push "${REPO}:${TAG}"
V="$(visibility)" || { echo "ABORT: pushed ${REPO}:${TAG} but cannot read the package visibility; check it and set it to private NOW" >&2; exit 1; }
[ "$V" = "private" ] || { echo "ABORT: package ${REPO} is ${V}: the proprietary Claude Code binary is exposed. Set it to private NOW (package settings) and delete the version." >&2; exit 1; }
DIGEST="$(docker image inspect "${REPO}:${TAG}" --format '{{range .RepoDigests}}{{println .}}{{end}}' | grep -F "${REPO}@sha256:" | head -1)"
printf '%s' "$DIGEST" | grep -Eq "^${REPO}@sha256:[a-f0-9]{64}\$" || { echo "no repository digest after push" >&2; exit 1; }
echo "OAX_CONTAINER_HARNESS_IMAGES={\"claude-code\":\"${DIGEST}\"}"
