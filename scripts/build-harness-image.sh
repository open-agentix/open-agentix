#!/usr/bin/env bash
# Builds the run-node image with the pinned Claude Code binary, pushes it to GHCR and prints the
# digest-pinned reference for OAX_CONTAINER_HARNESS_IMAGES (docs/runners.md, "Harness images").
# Needs a docker login to ghcr.io for the pushing account. Heavy job: run it under the host's gate.
# Usage: scripts/build-harness-image.sh <git-sha> [--no-push]
set -euo pipefail
SHA="${1:?usage: build-harness-image.sh <git-sha> [--no-push]}"
REPO="${OAX_IMAGE_REPO:-ghcr.io/open-agentix/open-agentix-run-node-claude-code}"
cd "$(dirname "$0")/.."
[ "$(git rev-parse HEAD)" = "$(git rev-parse "$SHA")" ] || { echo "checkout $SHA first" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "working tree is not clean" >&2; exit 1; }
TAG="$(git rev-parse --short=12 HEAD)"
docker build --target run-node-claude-code --build-arg "VERSION=${TAG}" -t "${REPO}:${TAG}" .
docker run --rm --entrypoint /opt/claude-code/bin/claude "${REPO}:${TAG}" --version
[ "${2:-}" = "--no-push" ] && { echo "built ${REPO}:${TAG} (not pushed)"; exit 0; }
docker push "${REPO}:${TAG}"
DIGEST="$(docker image inspect "${REPO}:${TAG}" --format '{{range .RepoDigests}}{{println .}}{{end}}' | grep "^${REPO}@sha256:" | head -1)"
[ -n "$DIGEST" ] || { echo "no repository digest after push" >&2; exit 1; }
echo "OAX_CONTAINER_HARNESS_IMAGES={\"claude-code\":\"${DIGEST}\"}"
