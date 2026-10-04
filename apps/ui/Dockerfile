# syntax=docker/dockerfile:1.7
# Web UI image: static build served by unprivileged nginx on 8080 (uid 101).
#   docker build -f apps/ui/Dockerfile -t ghcr.io/open-agentix/open-agentix-ui:dev .
ARG NODE_IMAGE=node:22-alpine
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.29-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /src
ENV CI=true
RUN npm install -g pnpm@10.34.6
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/providers/package.json packages/providers/
COPY packages/events/package.json packages/events/
COPY packages/mcp/package.json packages/mcp/
COPY packages/runners/package.json packages/runners/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/ui/package.json apps/ui/
RUN pnpm install --frozen-lockfile --filter @openagentix/ui
COPY packages/core/src packages/core/src
COPY apps/ui apps/ui
# Optional absolute API origin (default: same origin, routed by the ingress).
ARG VITE_OAX_API_URL=
ENV VITE_OAX_API_URL=${VITE_OAX_API_URL}
RUN pnpm --filter @openagentix/ui build

FROM ${NGINX_IMAGE} AS ui
ARG VERSION=0.0.0-dev
LABEL org.opencontainers.image.title="open-agentix-ui" \
      org.opencontainers.image.source="https://github.com/open-agentix/open-agentix" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}"
COPY apps/ui/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build --chown=101:101 /src/apps/ui/dist /usr/share/nginx/html
USER 101
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
