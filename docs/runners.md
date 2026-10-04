# Runners, run nodes and the credential broker

A **runner** decides where the steps of a run execute. Every runner uses the same step executor, so
the policy gate, approvals, budgets, costs and the audit hash chain behave identically
([ADR 0005](adr/0005-runners-and-external-harnesses.md)). This page covers the isolating runner that
ships in v0.2 (`container`), the run node it starts and the per-step credential broker
([ADR 0008](adr/0008-agents-md-data-flow-and-isolation-contract.md), sections 2 and 3).

| Runner | Status | Where steps run |
| --- | --- | --- |
| `in-process` | available | inside the worker process (default) |
| `local` | available | the CLI (`oax run`) |
| `container` | available, opt-in (this page) | one short-lived, hardened container per isolated step |
| `kubernetes-job` | planned (W1-4) | one Job per step |
| `aws-lambda`, `github-actions`, `gitlab-ci` | planned (v0.3) | typed stubs |

## What is isolated

In an `agents.md` file the runner is chosen per pipeline (`runtime.runner`) and can be overridden
per step (`agents[].runtime.runner`); a step's `runtime.egress` can only **narrow** the pipeline's.
A step whose effective runner is not `in-process`/`local` is **never** run inline: if the runner is
not available on the worker the run fails with `runner_unavailable` (fail closed).

```yaml
runtime:
  runner: in-process
  egress: [jira.example.com, crm.example.com]
agents:
  - id: research            # runs in the worker process
    ...
  - id: action              # runs in its own container
    runtime: { runner: container, egress: [jira.example.com] }
    credentials:
      - { secret: jira-bot-token, env: JIRA_TOKEN }
    tools:
      - { server: jira, tool: add_comment }
```

The worker stays the **orchestrator**: it evaluates `when`, assembles and validates handovers,
checks budgets and cancellation, and validates the node's output against `output.schema` again
(authoritative; the node validates too, so it can retry once). The **run node** is the untrusted
process inside the container. It executes exactly one step with the same executor, talks only to the
control node through the worker API with a step-scoped run token, and never connects to PostgreSQL
or Valkey (its module graph does not contain the database client; a test enforces it).

## Lifecycle of one isolated step

1. The orchestrator creates a **session** (`run_node_sessions`) and a **step-scoped run token**
   (claims `runId`, node id, `sid`, `steps`; lifetime at most step timeout + 60 s, capped by
   `OAX_RUN_TOKEN_TTL_SECONDS`). Audit: `runnode.started`.
2. The container runner starts the node. The token is written **once to the container's stdin**
   (line 1; line 2 is the node's account at the egress proxy), never to the environment, the command
   line or the create options (all readable through `inspect`). Docker refuses to copy files into a
   container with a read-only root filesystem, which rules out a token file.
3. The node fetches its **handover** (`GET /v1/worker/runs/{id}/handover?agentId=`: its own step spec
   without `when`/`credentials`, its input, the resolved output schema, the step's MCP connections
   with secret references stripped, and a few run facts) and then its **credentials** (below).
4. It runs the step: policy gate, steps, approvals, budget and cancellation checks all go to the
   control node. It posts the final output with `POST /v1/worker/runs/{id}/handover/result`, or a
   `failure` (status, code, message) when the step did not succeed; a policy block stays a policy
   block.
5. The orchestrator **revokes the session first**, then stops and removes the container, then reads
   the result. A missing result, a non-zero exit code or a timeout fails the run (`run_node_failed`,
   `control_timeout`). Cancellation (checked every two seconds) and timeouts revoke the session and
   kill the container. Audit: `credential.revoked` (`step_end`, `cancelled`, `timeout`,
   `run_completed`), `runnode.stopped`.

A token with a revoked or expired session is dead for **every** worker endpoint immediately, long
before its own expiry. A node token can only act for the agents in its `steps` claim and can never
complete a run (`403`).

## Credential broker

`POST /v1/worker/runs/{id}/credentials` with body `{ "agentId": "..." }` and a step-scoped token.

- Hands out the values of exactly the references the step declares (`agents[].credentials`) plus the
  secret references of the MCP connections the step holds grants for (`envSecrets` of stdio servers,
  `headerSecrets` of HTTP servers): `{ credentials: [{ secret, env, value }], connections: [{ server,
  env?, headers? }], expiresAt }`. Never another step's secrets.
- **Once per step and session** (`409 credential_already_issued` afterwards, audited). A restarted
  node gets a new session. The issue is recorded before the values are resolved, so a failure never
  leaves a second chance on the same session.
- Only references the tenant allows: `tenants.secret_refs`, a list of globs (`*` is the only
  wildcard). The default tenant is migrated to `["*"]`; **every other tenant starts with an empty
  list and gets no secret at all** (`403 credential_scope`, audited `credential.denied`). Platform
  operators change it with `PATCH /v1/tenants/{id}` (`secretRefs`).
- Response is `Cache-Control: no-store`. Values live in the node's memory and reach tool processes
  as their environment and HTTP headers, nothing else. They are registered for redaction on the
  control node, so step records and audit payloads of the run never contain them. Audit entries
  (`credential.issued`, `credential.denied`) carry names and ids only.
- Sources: v0.2 ships the `static` source (the existing env/file secret resolver). A source can
  implement `revoke(handle)` for real revocation; a static secret value itself cannot be recalled,
  only the session, node and token are destroyed.

## Container runner

Opt-in: nothing isolating runs by default. Enable it with `OAX_RUNNERS_ENABLED=in-process,container`
**and** `OAX_CONTAINER_RUNNER_ENABLED=true` on the control node and the worker.

| Variable | Meaning |
| --- | --- |
| `OAX_CONTAINER_ENGINE_URL` | required. Rootless Podman `unix:///run/user/1000/podman/podman.sock`, or a Docker socket proxy `http://socket-proxy:2375`. The Docker daemon's own socket (`/var/run/docker.sock`) is **refused** unless `OAX_CONTAINER_ALLOW_RAW_SOCKET=true` (logs a warning, audit `runner.unsafe_socket`). |
| `OAX_CONTAINER_IMAGE` | required. Run node image **pinned by digest** (`name@sha256:<64 hex>`); tags are refused. Build target `run-node` of the repository `Dockerfile`. |
| `OAX_CONTAINER_TOOLBOX_IMAGES` | JSON map toolbox name -> digest-pinned image. A step with an unknown toolbox fails closed (`toolbox_image_unknown`). Toolbox build, signing and verification are W2-1. |
| `OAX_CONTAINER_NETWORK` | required. A pre-created network with `internal: true`; the runner inspects it before every start and refuses anything else (`network_not_internal`). |
| `OAX_NODE_CONTROL_URL` | required. Base URL of the control node **as seen from the node** (on the internal network), not the public URL. |
| `OAX_CONTAINER_EGRESS_PROXY_LISTEN` / `_URL` | where the worker's egress proxy listens (`0.0.0.0:3128`) and the URL nodes use; set both or neither. Without a proxy no step can declare egress hosts. |
| `OAX_CONTAINER_MAX_CPUS`, `_MAX_MEMORY_MB`, `_MAX_PIDS` | upper bounds (defaults 1, 512, 256); a step's limits are clamped to them. |
| `OAX_CONTAINER_ENGINE`, `OAX_CONTAINER_ALLOW_RAW_SOCKET` | `docker` (default) or `podman`; the unsafe-socket switch. |

Hardening of every node container (checked again by `assertSafeCreateBody` before each create, which
refuses privileged mode, bind mounts, devices, added capabilities, host namespaces, host/bridge
networks, writable root filesystems, unconfined security options, missing limits, root users, tag-only
images and tokens in the environment):

- numeric non-root user (`10001`), read-only root filesystem, `cap-drop ALL`,
  `no-new-privileges`, default seccomp profile, `init`, private IPC, no restart;
- CPU, memory (no swap) and PID limits; `/tmp` and `/run/oax` are size-limited `noexec,nosuid,nodev`
  tmpfs mounts, `/run/oax` mode `0700`;
- no host mounts and no engine socket inside; the worker reaches the engine only through the socket
  proxy or a rootless Podman socket;
- one container per step, named `oax-node-<node id>`, labelled `io.openagentix.run-node`, removed
  (force, with volumes) when the step ends in every outcome.

### Egress

Nodes sit on an internal network: no route to the internet, only the control node and the **egress
proxy**. The proxy (`EgressProxy`, runs inside the worker process) is an HTTP `CONNECT` allowlist:
each node authenticates with its own ephemeral account (delivered on stdin) and may reach exactly the
hosts of its step's `runtime.egress` (`host`, `*.suffix`, IP, CIDR, optional port). Deny by default: a
step without `egress` reaches nothing; unknown or unregistered nodes get `407`. Loopback, link-local,
unspecified and multicast targets are refused even when listed, and every address a name resolves to
is checked (no mixing a public and a local answer). Plain HTTP requests get `405`. In **air-gapped
mode** the process-wide `OAX_AIRGAPPED_ALLOW` policy applies on top of the step list, so a node can
never reach more than the platform itself could.

### Docker Compose

`docker-compose.yml` has an opt-in profile that runs the worker with the container runner behind a
socket proxy (`tecnativa/docker-socket-proxy`, only container and network calls allowed; pin it by
digest for production):

```bash
# .env
OAX_RUNNERS_ENABLED=in-process,container
OAX_CONTAINER_RUNNER_ENABLED=true
OAX_CONTAINER_IMAGE=ghcr.io/open-agentix/open-agentix-run-node@sha256:<digest>

docker compose --profile container-runner up --scale worker=0
```

Scale the plain `worker` to 0: a run that needs isolation must not be claimed by a worker without a
container runner (it would fail closed, but only one worker should serve the queue). The images must
exist on the engine host (the runner never pulls). The networks `openagentix-nodes` and `socket` are
`internal: true`.

## Not in this version

- **Model proxy (W1-3b).** Run nodes call models only through the control node
  (`POST /v1/worker/runs/{id}/model`) so that provider keys, egress rules and cost measurement stay on
  the control node. Until it lands, a node has **no** model access: every provider except the keyless
  `simulated` provider fails the step with `model_proxy_unavailable`
  (`packages/runners/src/model-proxy.ts` documents the interface). Usage and cost are therefore
  reported by the node (trusted for budgeting only; the monthly budgets are still enforced by the
  control node from the recorded steps).
- Step groups (one node for several steps), dynamic credential sources with real revocation (Vault,
  STS), mTLS between nodes and the control node (W2-2), signed and scanned toolbox images (W2-1),
  the Kubernetes Job runner (W1-4).

## Testing

Unit tests use a fake engine API and run everywhere. The opt-in integration test
(`packages/runners/test/container.integration.test.ts`) runs against a real Docker or Podman engine:

```bash
OAX_TEST_DOCKER=1 OAX_TEST_IMAGE=alpine@sha256:<local digest> \
  OAX_TEST_ALLOW_RAW_SOCKET=1 pnpm vitest run packages/runners/test/container.integration.test.ts
```

It proves inside the node: non-root, read-only root filesystem, no engine socket, token only on
stdin and not in the environment, another node's token not readable, no egress on the internal
network, dropped capabilities; and outside: the container is gone afterwards, a node that outlives its
timeout is killed, and a non-internal network is refused.
