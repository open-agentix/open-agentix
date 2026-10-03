# Minimal toolbox image: only the trivy binary, non-root, read-only root fs friendly.
# Build: docker build -t ghcr.io/open-agentix/toolbox-trivy:dev toolboxes/trivy
ARG TRIVY_VERSION=0.67.2
FROM aquasec/trivy:${TRIVY_VERSION} AS trivy

FROM alpine:3.22
RUN apk upgrade --no-cache && apk add --no-cache ca-certificates \
 && addgroup -S -g 10001 toolbox && adduser -S -D -H -u 10001 -G toolbox toolbox \
 && rm -rf /sbin/apk /etc/apk /lib/apk /usr/share/apk
COPY --from=trivy /usr/local/bin/trivy /usr/local/bin/trivy
# Cache and temp live on tmpfs mounts provided by the runner (read-only root fs).
ENV TRIVY_CACHE_DIR=/tmp/trivy-cache HOME=/tmp
USER 10001:10001
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/trivy"]
