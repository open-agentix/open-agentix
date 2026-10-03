# ADR 0006: Control node and worker nodes

- Status: Accepted
- Date: 2026-10-03

## Context

Tool execution is where risk lives (file systems, credentials, network). The component holding
the audit trail, RBAC and policies must not be the one executing untrusted tool calls.

## Decision

- **Control node** (control plane, `apps/api`): API, UI backend, auth/RBAC, agent registry,
  event ingest, scheduler/queue, policy engine (audit gate + control agent), audit trail, cost
  ledger, metrics. **It never executes tools.**
- **Worker nodes** (data plane): each run is executed by a worker spawned by a runner (process,
  container, Kubernetes Job/EKS, Lambda, CI). Workers authenticate with a **signed, short-lived run
  token** (`oaxrt.<claims>.<hmac>`; bound to run id and worker id, checked against the run lease)
  and use the worker API: `/v1/worker/runs/{id}/gate|steps|approvals|status|complete`. Every tool
  call is decided by the control node's gate first.
- The MVP in-process worker already uses this contract (`ControlPlaneService.forToken`), so remote
  workers are a transport change (`HttpControlPlane`).
- **Toolbox images**: each agent declares `runtime.toolbox` (e.g. `git+node`, `trivy`,
  `jira-cli`) and `runtime.egress`. Toolboxes are minimal images from the catalog in `toolboxes/`
  (alpine/distroless, only the listed binaries, non-root, read-only root fs), pinned by digest,
  signed with cosign, with an SBOM (syft) and a vulnerability scan (trivy) in CI; egress is
  allowlisted (NetworkPolicy / container network). Secrets are injected per run, scoped and
  revoked afterwards.
- Spawning worker nodes from toolbox images is v0.2 (container, Kubernetes Job); Lambda and CI
  runners are v0.3.

## Consequences

- A compromised tool cannot read other runs, the audit key or the database credentials.
- Run tokens must be short-lived and never logged (redaction covers `oaxrt.` tokens via the
  bearer pattern); mTLS between nodes is an option for v0.2.

## Alternatives considered

- Single process (control + execution): simplest, but violates the isolation goal; kept only as
  the in-process runner for small installs.
