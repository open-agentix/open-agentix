# Kubernetes Job runner

The `kubernetes-job` runner executes **one run node per step** as a Kubernetes Job (plan item W1-4,
[ADR 0008](adr/0008-agents-md-data-flow-and-isolation-contract.md) section 3.5). Nothing runs on
Kubernetes unless you enable it: `OAX_RUNNERS_ENABLED` contains `kubernetes-job` **and**
`OAX_K8S_JOB_ENABLED=true` (see [configuration](configuration.md#runners-and-toolboxes-v02-contract-feature-flagged-off)).

## What is created per step

All objects live in the run namespace (`OAX_K8S_NAMESPACE`) and are named `oax-step-<nodeId>`:

| Object | Purpose |
| --- | --- |
| `Job` | `backoffLimit: 0`, `activeDeadlineSeconds` (step timeout, capped by `OAX_K8S_ACTIVE_DEADLINE_SECONDS`), `ttlSecondsAfterFinished`. Created **suspended**, unsuspended last. |
| `NetworkPolicy` | Selects the Pod by `openagentix.io/node-id`; **no ingress**; egress only to DNS (kube-dns), the control node and the allowlist. Owner: the Job. |
| `Secret` | Immutable, holds **only the step-scoped run token**, mounted read-only at `/run/oax/token` (mode 0400). Owner: the Job. |

Order: Job (suspended) -> NetworkPolicy -> Secret -> unsuspend. No Pod can start before the policy
and the token exist, and a failed start removes everything again. When the step ends (success,
failure, cancel, timeout, lease loss) `stop()` deletes the Job (Pods in the background), the
Secret and the NetworkPolicy; the owner references let Kubernetes garbage-collect them even if the
worker dies, and the Job TTL removes finished Jobs.

## Pod hardening

Non-root (`runAsUser` 65532), read-only root filesystem, `allowPrivilegeEscalation: false`,
capabilities `drop: [ALL]`, seccomp `RuntimeDefault`, no host namespaces, no service links,
`automountServiceAccountToken: false` (switch on only with `automountServiceAccountToken`; EKS IRSA
does not need it), CPU/memory requests = limits (from the step limits), `ephemeral-storage` limit,
a 64 MiB in-memory `/tmp`, no secrets in `env` (only ids, URLs and the token **file path**). The
namespace should enforce PodSecurity `restricted`. Step credentials are not part of the Job:
the run node pulls them from the control node (credential broker, W1-3a).

## Egress

The effective allowlist is the cluster-wide `OAX_K8S_EGRESS` plus the step's `runtime.egress`
(already narrowed by the orchestrator). **CIDR entries** become `ipBlock` rules. **Host names
cannot be expressed in a NetworkPolicy** and are therefore not opened (fail closed); they are
passed to the node as `OAX_EGRESS_ALLOW` for an egress gateway/proxy and a warning is logged.
`/0` CIDRs are refused. The control node is reachable through `controlPlane` (pod/namespace
selector, CIDRs, ports) in the runner config; with an empty `controlPlane` and `dnsEgress: false`
the Pod is completely isolated.

## Images

Only images under `OAX_TOOLBOX_REGISTRY`, **pinned by digest**, are started. `toolbox-<name>`
images must be in `OAX_TOOLBOX_ALLOWLIST` (empty = any toolbox); other images (the worker image
that provides `oax run-node`) must be listed in the runner's `runNodeImages`.

## RBAC

Namespaced Role in the run namespace only: Jobs `create/get/patch/delete`, Secrets
`create/delete`, NetworkPolicies `create/delete`. No cluster-wide rights, no Pods, no list/watch.
A ready-to-apply manifest is in
[`examples/kubernetes-job-runner-rbac.yaml`](examples/kubernetes-job-runner-rbac.yaml). The Helm
chart (open-agentix-helm) renders the same rules; that work is tracked there.

## Limitations (v0.2)

- Job completion is polled (default every 2 s), not watched; the exit code is not read (it would
  need Pod access), so a failed Job reports `exitCode: null` with reason `failed` or `timeout`.
  The step result always comes from the control node.
- No PID limit per Pod (a kubelet setting); `limits.pids` is accepted but not enforced here.
- Orphans from a worker crash between Job creation and unsuspension are suspended Jobs without
  Pods; they carry the labels `app.kubernetes.io/name=openagentix-run-node` for a sweeper.
- The runner is driven through `startNode()` of the isolating-runner contract. The orchestrator
  seam (`dispatchStep`), sessions, the step-scoped token and the `runnode.*` audit entries belong
  to W1-3a; `execute()` of a whole run is intentionally unsupported.

## Tests

Unit tests use an in-memory Kubernetes client and a local HTTP server (no cluster needed). The
opt-in end-to-end test runs against a real cluster: `OAX_TEST_KIND=1 OAX_TEST_KUBE_API=http://127.0.0.1:8001
OAX_TEST_IMAGE=ghcr.io/open-agentix/openagentix-worker@sha256:... pnpm vitest run packages/runners/test/kubernetes-job.e2e.test.ts`
(with `kubectl proxy` against a kind cluster).
