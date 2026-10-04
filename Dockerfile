# syntax=docker/dockerfile:1.7
# Multi-target image build for the control node (api) and the worker.
#   docker build --target api -t ghcr.io/open-agentix/open-agentix-api:dev .
#   docker build --target worker -t ghcr.io/open-agentix/open-agentix-worker:dev .
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
