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
| `NetworkPolicy` | Selects the Pod by `openagentix.io/node-id`; **no ingress**; egress only to DNS (kube-dns), the control node and the allowlist. **No owner reference** (explicit delete only, labelled for a sweeper). |
| `Secret` | Immutable, holds **only the step-scoped run token**, mounted read-only at `/run/oax/token` (mode 0400). Owner: the Job. |

Order: Job (suspended) -> NetworkPolicy -> Secret -> unsuspend. No Pod can start before the policy
and the token exist. A failed start removes **only what this call created** (tracked by uid; a
`409` on create deletes nothing; deletes carry a uid precondition so a same-named foreign object is
never touched). Node ids must be UUIDs and are never slugified, so two nodes can never share a name.

When the step ends (success, failure, cancel, timeout, lease loss) `stop()` deletes the Job with
**Foreground** propagation (the Job object only disappears after its Pods), then the Secret, waits
until the Job is gone and deletes the **NetworkPolicy last**. If the Pods are not confirmed gone
in time the policy is kept (owner GC removes it later) and `stop()` reports an error and can be
retried. The NetworkPolicy deliberately has **no owner reference**: with Foreground deletion the
garbage collector would otherwise remove it in parallel with the Pods' termination and defeat the
ordering. Only the Secret is owned by the Job (without `blockOwnerDeletion`, so no
`jobs/finalizers` RBAC is needed); the Job TTL removes finished Jobs. A policy left behind by a
worker crash is found by its labels (sweeper: follow-up) and is harmless: it only narrows access.

### Prerequisites

- A CNI that **enforces NetworkPolicy**. Without one all policies are ignored and Pods have open
  egress; the runner cannot detect that.
- A static namespace-wide **default-deny** (ingress+egress, `podSelector: {}`) in the run
  namespace, shipped in `examples/kubernetes-job-runner-rbac.yaml` (the Helm chart should render
  it). Per-step policies are then purely additive, so a terminating Pod or a garbage-collected
  policy never leaves a Pod with more access.
- **Checked at every start**: the runner reads the default-deny policy (`defaultDenyPolicy`, default
  `default-deny-all`; RBAC `get` on exactly that name) and refuses to start a step if it is missing
  or not a real deny-all (ingress+egress, empty selector, no rules).
- The step ServiceAccount (`OAX_K8S_SERVICE_ACCOUNT`, default `openagentix-run-node`) and the run
  namespace must differ from the worker's; the runner refuses equal values (set
  `OAX_K8S_WORKER_SERVICE_ACCOUNT` / `OAX_K8S_WORKER_NAMESPACE`).
- Signature verification of toolbox images is **not** done by this runner. With
  `OAX_TOOLBOX_REQUIRE_SIGNATURE=true` (default) the control node refuses to start the runner
  unless `OAX_K8S_SIGNATURES_VERIFIED_BY_ADMISSION=true` confirms that an admission policy
  (Kyverno, sigstore policy-controller) verifies cosign signatures.

## Pod hardening

Non-root (`runAsUser` 65532), read-only root filesystem, `allowPrivilegeEscalation: false`,
capabilities `drop: [ALL]`, seccomp `RuntimeDefault`, no host namespaces, no service links,
`automountServiceAccountToken: false` (switch on only with `automountServiceAccountToken`; EKS IRSA
does not need it; one shared step ServiceAccount means one IRSA role for all steps of the runner), CPU/memory requests = limits (from the step limits), `ephemeral-storage` limit,
a 64 MiB in-memory `/tmp`, no secrets in `env` (only ids, URLs and the token **file path**). The
namespace should enforce PodSecurity `restricted`. Step credentials are not part of the Job:
the run node pulls them from the control node (credential broker, W1-3a).

## Egress

`OAX_K8S_EGRESS` is the operator's **upper bound**, not a default: a step opens nothing unless it
declares `runtime.egress`, and every CIDR it declares must lie inside one operator CIDR (the step
can only narrow). Further rules, all enforced when the Job is built:

- minimum prefix `/8` (IPv4) and `/32` (IPv6), for operator and step entries (no `/1` splits);
- always-denied ranges are never reachable: `169.254.0.0/16` (IMDS and link-local),
  `127.0.0.0/8`, `::1/128`, `fe80::/10`, `fd00:ec2::254/128`, `fd20:ce::254/128`, `168.63.129.16/32`, `100.100.100.200/32`, the IPv4-mapped (`::ffff:`) and NAT64 (`64:ff9b::`) forms of link-local and loopback, plus `OAX_K8S_DENY_CIDRS` (set your
  pod, service and node CIDRs, and the Kubernetes API address). An allowed CIDR containing such a
  range gets an `ipBlock.except` entry, a CIDR inside one is refused;
- with `OAX_AIRGAPPED=true` a step may not declare any egress;
- **host names cannot be expressed in a NetworkPolicy** and are not opened (fail closed); they are
  passed as `OAX_EGRESS_ALLOW` for an egress gateway/proxy and a warning is logged.

The control node is reachable through `controlPlane` (non-empty pod/namespace selectors, prefer
`kubernetes.io/metadata.name`; CIDRs; ports). DNS goes to kube-dns (see follow-ups). With an empty
`controlPlane` and `dnsEgress: false` the Pod is completely isolated.

## Images

Only images under `OAX_TOOLBOX_REGISTRY`, **pinned by digest**, are started, compared by their
exact repository path (case-insensitive). `toolbox-<name>` images must be in
`OAX_TOOLBOX_ALLOWLIST`; other images (the worker image that provides `oax run-node`) must be
listed in `OAX_K8S_RUN_NODE_IMAGES`. **An empty allowlist allows nothing** (fail closed), and the
control node refuses to start the runner with both lists empty.

## Resources

Step limits are clamped into `[50m / 32Mi, OAX_K8S_RESOURCES_CPU / OAX_K8S_RESOURCES_MEMORY]`
(requests = limits); non-finite or non-positive step values are refused and operator ceilings below
`50m` / `32Mi` are rejected at config load and in the runner constructor, so a limit is never `0`. Add the
`LimitRange` and `ResourceQuota` of the example manifest to bound concurrency (the runner starts
one Job per step and does not cap parallel Jobs itself).

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
- `controlUrl` and the API server URL must be `https`.
- The runner is driven through `startNode()` of the isolating-runner contract. The orchestrator
  seam (`dispatchStep`), sessions, the step-scoped token and the `runnode.*` audit entries belong
  to W1-3a; `execute()` of a whole run is intentionally unsupported.

## Tests

Unit tests use an in-memory Kubernetes client and a local HTTP server (no cluster needed). The
opt-in end-to-end test runs against a real cluster: `OAX_TEST_KIND=1 OAX_TEST_KUBE_API=http://127.0.0.1:8001
OAX_TEST_IMAGE=ghcr.io/open-agentix/openagentix-worker@sha256:... pnpm vitest run packages/runners/test/kubernetes-job.e2e.test.ts`
(with `kubectl proxy` against a kind cluster).

## Known follow-ups

- DNS is an exfiltration channel (queries to kube-dns reach upstream resolvers); needs a
  filtering resolver or DNS policy (Cilium/CoreDNS).
- No per-step ServiceAccount/IRSA role yet (one shared ServiceAccount).
- Host-name egress needs an egress gateway; there is no built-in proxy.
- Wire `controlPlane`, `dnsEgress` and `automountServiceAccountToken` to env settings (until then a step cannot reach the control node; W1-3a integration), default `denyCidrs`.
- Orphan sweeper for suspended Jobs after a worker crash; Job status is polled, not watched.
- Pod Security Admission, image signature checks and the CNI prerequisite are cluster
  responsibilities (documented above, not verified by the runner).
