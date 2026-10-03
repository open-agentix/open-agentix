# Toolbox images

A **toolbox** is the minimal container image a worker node runs in (ADR 0006). An agent declares
it in `agents.md`:

```yaml
runtime:
  runner: kubernetes-job   # v0.2
  toolbox: trivy           # or "git+node", "jira-cli"
  egress: [ghcr.io]
```

Spawning worker nodes from toolboxes ships in v0.2; this catalog defines the conventions now.

## Rules

- Base: `alpine` or distroless; only the binaries the toolbox is named after (plus the
  openagentix worker entrypoint, added in v0.2).
- Runs as a non-root user with a **read-only root file system**; writable paths are `tmpfs`
  mounts (`/tmp`, `/work`).
- No shell where possible; no package manager in the final image.
- Versions of every binary are pinned (`ARG`), images are referenced **by digest** in
  `catalog.yaml`.
- Egress is denied by default and allowlisted per agent (`runtime.egress`).

## Supply chain (CI, v0.2)

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/open-agentix/toolbox-trivy:<version> toolboxes/trivy
syft ghcr.io/open-agentix/toolbox-trivy:<version> -o spdx-json > sbom.spdx.json   # SBOM
trivy image --exit-code 1 --severity CRITICAL,HIGH ghcr.io/open-agentix/toolbox-trivy:<version>
cosign sign --yes ghcr.io/open-agentix/toolbox-trivy@sha256:<digest>                # keyless (OIDC)
cosign attest --yes --type spdxjson --predicate sbom.spdx.json ghcr.io/open-agentix/toolbox-trivy@sha256:<digest>
```

Worker nodes verify the signature (`cosign verify` / admission policy such as Kyverno or
sigstore policy-controller) before a toolbox image may run.
