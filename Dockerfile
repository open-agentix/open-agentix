# syntax=docker/dockerfile:1.7
# Multi-target image build for the control node (api) and the worker.
#   docker build --target api -t ghcr.io/open-agentix/open-agentix-api:dev .
#   docker build --target worker -t ghcr.io/open-agentix/open-agentix-worker:dev .
#   docker build --target run-node -t ghcr.io/open-agentix/open-agentix-run-node:dev .
#   docker build --target run-node-claude-code -t ghcr.io/open-agentix/open-agentix-run-node-claude-code:dev .
ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS base
WORKDIR /src
# Non-interactive, pinned package manager; no other tools are downloaded at build or run time.
ENV CI=true
RUN npm install -g pnpm@10.34.6
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json tsconfig.build.json ./
COPY packages/core/package.json packages/core/
COPY packages/providers/package.json packages/providers/
COPY packages/events/package.json packages/events/
COPY packages/mcp/package.json packages/mcp/
COPY packages/runners/package.json packages/runners/
COPY packages/workspace/package.json packages/workspace/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps/api apps/api
COPY apps/worker apps/worker
RUN pnpm build

# Production dependencies only, installed in their own stage (fast hardlinks, no dev tooling).
FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod

FROM ${NODE_IMAGE} AS runtime
# Patch the base image and drop the package managers from the runtime image.
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /src /app
COPY --from=build /src/packages/core/dist /app/packages/core/dist
COPY --from=build /src/packages/providers/dist /app/packages/providers/dist
COPY --from=build /src/packages/providers/catalog /app/packages/providers/catalog
COPY --from=build /src/packages/events/dist /app/packages/events/dist
COPY --from=build /src/packages/mcp/dist /app/packages/mcp/dist
COPY --from=build /src/packages/runners/dist /app/packages/runners/dist
COPY --from=build /src/apps/api/dist /app/apps/api/dist
COPY --from=build /src/apps/api/drizzle /app/apps/api/drizzle

FROM runtime AS api
ARG VERSION=0.0.0-dev
LABEL org.opencontainers.image.title="open-agentix-api" \
      org.opencontainers.image.source="https://github.com/open-agentix/open-agentix" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}"
WORKDIR /app/apps/api
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "dist/main.js"]

FROM runtime AS worker
ARG VERSION=0.0.0-dev
LABEL org.opencontainers.image.title="open-agentix-worker" \
      org.opencontainers.image.source="https://github.com/open-agentix/open-agentix" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}"
COPY --from=build /src/apps/worker/dist /app/apps/worker/dist
WORKDIR /app/apps/worker
USER node
EXPOSE 9090
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:9090/healthz >/dev/null || exit 1
CMD ["node", "dist/main.js"]

# Run node: executes ONE isolated step in a short-lived container started by the container runner
# (docs/runners.md). It reads a step-scoped run token from a file, talks only to the control node and
# never connects to PostgreSQL. Started by the worker with a read-only root filesystem, a numeric
# non-root user and no capabilities; the image must be referenced by digest.
FROM runtime AS run-node
ARG VERSION=0.0.0-dev
LABEL org.opencontainers.image.title="open-agentix-run-node" \
      org.opencontainers.image.source="https://github.com/open-agentix/open-agentix" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}"
COPY --from=build /src/apps/worker/dist /app/apps/worker/dist
WORKDIR /app/apps/worker
USER 10001:10001
CMD ["node", "dist/run-node-cli.js"]

# Claude Code binary for harness steps (DOG-1, docs/dogfooding-phase-1.md section 3 D8). The native
# musl build is fetched at BUILD time only from the npm registry and verified against the SHA-512 of
# the registry metadata (`npm view @anthropic-ai/claude-code-<platform>@<version> dist.integrity`,
# converted to hex). A mismatch fails the build; nothing is downloaded when the image runs. To move
# to another version, change the version and both digests together (see docs/runners.md).
FROM ${NODE_IMAGE} AS claude-code-bin
ARG TARGETARCH
ARG CLAUDE_CODE_VERSION=2.1.295
ARG CLAUDE_CODE_SHA512_AMD64=4bf70c9f893cbb3ba631830f0136f1d22d78a284a2f1c2c5aff58cc9f14a41cf07fc544c85a678ad60a60499edb563f6b3ddd8894e4ab0089f61fdf7db80ed16
ARG CLAUDE_CODE_SHA512_ARM64=6a8f24ca81d2f975c8bba422794b616f956295b904b5b0811336da9bdedf585ffaeefcd9ae88095ff46224c84b65baca5fd2f96afa3bb21f9e2ba93ce410cf94
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) pkg=linux-x64-musl; sha="${CLAUDE_CODE_SHA512_AMD64}" ;; \
      arm64) pkg=linux-arm64-musl; sha="${CLAUDE_CODE_SHA512_ARM64}" ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    wget -q -O /tmp/claude.tgz "https://registry.npmjs.org/@anthropic-ai/claude-code-${pkg}/-/claude-code-${pkg}-${CLAUDE_CODE_VERSION}.tgz"; \
    echo "${sha}  /tmp/claude.tgz" | sha512sum -c -; \
    mkdir /out; \
    tar -xzf /tmp/claude.tgz -C /out --strip-components=1 package/claude package/LICENSE.md; \
    chmod 0555 /out/claude; \
    /out/claude --version | grep -F "${CLAUDE_CODE_VERSION}"

# Run node with the pinned Claude Code binary. Same hardening as `run-node` (numeric non-root user,
# read-only root filesystem compatible: it writes only to /tmp and /run/oax, both tmpfs mounts of the
# container runner). `git` is pinned by version (offline use for diffs only, it needs no network) and
# the package manager is removed afterwards, so the image cannot install anything. The binary is
# proprietary (Anthropic): keep the resulting image in a PRIVATE registry package. It also carries the
# `oax-workspace` MCP server (packages/workspace, DOG-2): `node /app/packages/workspace/dist/main.js`.
FROM runtime AS run-node-claude-code
ARG VERSION=0.0.0-dev
ARG CLAUDE_CODE_VERSION=2.1.295
ARG GIT_VERSION=2.54.0-r0
# No `org.opencontainers.image.source` label on purpose: GHCR links a package to the repository named
# there, and a linked package inherits the (public) visibility of the repository. This image contains
# the proprietary Claude Code binary and must stay in a private package (scripts/build-harness-image.sh
# verifies that after the push).
LABEL org.opencontainers.image.title="open-agentix-run-node-claude-code" \
      org.opencontainers.image.licenses="Apache-2.0 AND LicenseRef-Anthropic-Claude-Code" \
      org.opencontainers.image.version="${VERSION}" \
      io.openagentix.harness="claude-code" \
      io.openagentix.claude-code.version="${CLAUDE_CODE_VERSION}"
USER root
RUN apk add --no-cache git="${GIT_VERSION}" || { \
      echo "ERROR: git=${GIT_VERSION} is not available in the Alpine repositories of this base image." >&2; \
      echo "Alpine drops old package revisions. Available now: $(apk list git 2>/dev/null | tr '\n' ' ')" >&2; \
      echo "Fix: rebuild with --build-arg GIT_VERSION=<one of the versions above> (and update the default here)." >&2; \
      exit 1; } \
 && rm -rf /sbin/apk /etc/apk /var/cache/apk /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=claude-code-bin /out/claude /opt/claude-code/bin/claude
COPY --from=claude-code-bin /out/LICENSE.md /opt/claude-code/LICENSE.md
COPY --from=build /src/packages/workspace/dist /app/packages/workspace/dist
COPY --from=build /src/apps/worker/dist /app/apps/worker/dist
ENV OAX_CLAUDE_BIN=/opt/claude-code/bin/claude
WORKDIR /app/apps/worker
USER 10001:10001
CMD ["node", "dist/run-node-cli.js"]

# Egress proxy for run nodes (docs/runners.md): its own service, attached to the internal node network
# and an egress network only. Stateless; verifies signed per-node grants.
FROM runtime AS egress-proxy
ARG VERSION=0.0.0-dev
LABEL org.opencontainers.image.title="open-agentix-egress-proxy" \
      org.opencontainers.image.source="https://github.com/open-agentix/open-agentix" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}"
COPY --from=build /src/apps/worker/dist /app/apps/worker/dist
WORKDIR /app/apps/worker
USER 10001:10001
EXPOSE 3128
CMD ["node", "dist/egress-proxy-cli.js"]

# Optional demo worker with the Claude Code CLI (OAX_DEMO_LLM=claude-code, see docs/demo.md).
# Pinned version; the CLI is installed at build time only, nothing is downloaded at run time.
FROM base AS claude-cli
ARG CLAUDE_CODE_VERSION=2.1.289
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

FROM worker AS worker-claude
USER root
COPY --from=claude-cli /usr/local/lib/node_modules/@anthropic-ai/claude-code /opt/claude-code
RUN ln -s /opt/claude-code/bin/claude.exe /usr/local/bin/claude
USER node
