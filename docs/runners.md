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
- Only references the tenant allows: `tenants.secret_refs`, a list of lower case patterns with at most
  one trailing `*` after a separator (`acme.*`; a bare `*` or `acme*` is refused). **Every tenant,
  the default tenant included, starts with an empty list and gets no secret at all** (`403
  credential_scope`, audited `credential.denied`); platform operators set it with
  `PATCH /v1/tenants/{id}` (`secretRefs`). References are compared in their **canonical form**
  (lower case, every character outside `[a-z0-9]` becomes `_`), because that is what the default
  resolver does (`OAX_SECRET_<NAME>`): `acme.corp.db-password` and `acme-corp.db-password` are the
  same secret. For the same reason tenants whose slugs overlap in canonical form (`acme`,
  `acme-corp`) cannot coexist, and the prefix rule for tenant connections (`<slug>.` ...) compares
  canonically.
- **Platform secrets are never delivered**, whatever a tenant allows: references of provider keys
  (environment providers and every model connection), event source secrets (webhook signing, Kafka
  credentials) and the secrets of platform-scope connections are refused (`credential.denied`,
  reason `platform_secret`). A platform connection that needs a secret therefore only works for
  in-process steps.
- **The same allowlist applies in-process**: the worker's tool gateway resolves a tenant's MCP
  connection secrets through a tenant-scoped resolver (`tenants.secret_refs`). Only servers of
  platform-scope connections use the unrestricted, operator-chosen resolver (chosen per server, so a
  tenant connection cannot borrow a secret by naming the same reference). Existing installations must set `secretRefs` for tenants
  whose connections use secrets (breaking, pre-1.0).
- Response is `Cache-Control: no-store`. Values live in the node's memory and reach tool processes
  as their environment and HTTP headers, nothing else. Nothing secret is kept in the control node's
  memory: for scrubbing, the values a run's nodes received are re-resolved from the secret store
  (static source only). A node may only report steps of kind `model_call`, `tool_call`, `output` and `error`; others are ignored, so it cannot create entries like `step.skipped`, `condition.error` or `handover.invalid`, and its records carry provenance (`run_steps.reported_by`, audit actor `node:<id>`). Step records, gate and approval arguments, audit payloads, the node's
  result (content, JSON, failure message) are scrubbed with them, and the result is deleted once the
  orchestrator read it. **This is a net for accidental leaks only**: a compromised node holds the
  plain values and can encode them, send them through allowed egress or into tool arguments.
  Audit entries (`credential.issued`, `credential.denied`) carry names and ids only.
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
| `OAX_CONTAINER_HARNESS_IMAGES` | JSON map harness (`claude-code`, `opencode`) -> digest-pinned image. A step with `runtime.harness` runs **only** on the image of its harness; an unknown harness fails closed (`harness_image_unknown`), a tag is refused at start. See Harness images below. |
| `OAX_CONTAINER_TMP_MB` | size of `/tmp` (tmpfs, default 64) of an ordinary node. |
| `OAX_CONTAINER_HARNESS_MEMORY_MB`, `OAX_CONTAINER_HARNESS_TMP_MB` | memory (default 2048, clamped to `OAX_CONTAINER_MAX_MEMORY_MB`) and `/tmp` size (default 256) of a **harness step's** node: Claude Code plus a repository checkout do not fit into 512 MiB / 64 MiB. tmpfs pages count against the memory limit, so startup refuses a `/tmp` that is not smaller than the node memory. |
| `OAX_HARNESS_EGRESS_ALLOWED` | default `false`. A harness step must publish with `runtime.egress: []` ("control node only"); publish refuses declared hosts, the runner refuses them again at start (`harness_egress_denied`). `true` lifts both checks. |
| `OAX_CONTAINER_NETWORK` | required. A pre-created network with `internal: true`; the runner inspects it before every start and refuses anything else (`network_not_internal`). |
| `OAX_NODE_CONTROL_URL` | required. Base URL of the control node **as seen from the node** (on the internal network), not the public URL. |
| `OAX_CONTAINER_INSTANCE_ID` | installation id (default `default`); containers are labelled with it and the orphan reaper only touches its own installation's containers. Set a distinct value per installation on a shared engine. |
| `OAX_CONTAINER_EGRESS_PROXY_URL`, `_GRANT_SECRET`, `_ALLOW`, `_PRIVATE_ALLOW` | the separate egress proxy, see Egress below; without URL and secret no step can declare egress. |
| `OAX_CONTAINER_MAX_CPUS`, `_MAX_MEMORY_MB`, `_MAX_PIDS` | upper bounds (defaults 1, 512, 256); a step's limits are clamped to them. |
| `OAX_CONTAINER_ENGINE`, `OAX_CONTAINER_ALLOW_RAW_SOCKET` | `docker` (default) or `podman`; the unsafe-socket switch. |

### Harness images (DOG-1)

A harness step needs the harness binary inside the node. The Dockerfile target
`run-node-claude-code` (derived from `run-node`) contains Claude Code `2.1.295`:

- **Pinned and verified.** The native musl package (`@anthropic-ai/claude-code-linux-x64-musl`, `-arm64-musl`)
  is fetched at **build time** from the npm registry and checked against the SHA-512 recorded in the
  Dockerfile (`CLAUDE_CODE_SHA512_AMD64|ARM64`, taken from `npm view <pkg>@<version> dist.integrity`, converted to
  hex); a mismatch or a wrong `claude --version` fails the build. Nothing is downloaded when the image
  runs, there are no install scripts, no package manager (`apk`, `npm`, `yarn`, `corepack` are removed)
  and `OAX_CLAUDE_BIN=/opt/claude-code/bin/claude` is set in the image. To change the version, change
  `CLAUDE_CODE_VERSION` and both digests in one commit and re-run the verification
  ([claude-code-harness](verification/claude-code-harness.md)).
- **Hardening unchanged.** Numeric non-root user `10001`, no capabilities, read-only root file system
  (Claude Code writes only below `HOME=/tmp`), no `managed-settings.json`, no `/etc/claude-code`, no
  `CLAUDE_CONFIG_DIR`. `git` (pinned by Alpine package version, `GIT_VERSION`) is included for offline use
  such as diffs. Reproducibility: pin the base image as well, `--build-arg NODE_IMAGE=node:22-alpine@sha256:...`
  (the Alpine package pin fails the build when the base moves, which is intended).
- **Licence.** The Claude Code binary is proprietary (Anthropic). Keep the pushed image in a
  **private** registry package; it is not a project release artifact.
- **Digest rule.** `OAX_CONTAINER_HARNESS_IMAGES` accepts only `name@sha256:<manifest digest>`. A locally
  built image has no repository digest until it is pushed, so the flow is: build, push, take the digest
  of the push, configure it, make sure the engine host has pulled it (the runner never pulls).
  `scripts/build-harness-image.sh <git-sha>` does build, push and prints the variable line. Only keys
  of the known harness kinds are accepted (the allowlist), and the image of a harness step must be the one
  configured for that harness: another allowed image is refused (`image_not_allowed`).
- **Limits.** Harness steps get `OAX_CONTAINER_HARNESS_MEMORY_MB` (2048) and `OAX_CONTAINER_HARNESS_TMP_MB`
  (256); the operator maximum `OAX_CONTAINER_MAX_MEMORY_MB` still caps the memory, so raise it (for example 2048)
  on installations that run harness steps.
- **Egress.** The node network is `internal`; a harness step has no egress grant, so it reaches the
  control node only (verified from inside a node, [verification](verification/claude-code-harness.md#run-node-image-dog-1)).

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
proxy**. The proxy is its **own service** (image target `egress-proxy`, `egress-proxy-cli.js`),
attached to the internal node network and an egress network and to nothing else; it is never part of
the worker process, which is attached to the engine socket network. It is an HTTP `CONNECT`
proxy and stateless: the runner mints a signed, expiring **grant** per node (node id, the step's
egress entries, expiry; HMAC with `OAX_CONTAINER_EGRESS_GRANT_SECRET`) that the node presents as its
proxy password. Per connection the proxy applies, in this order:

1. the **operator ceiling** `OAX_CONTAINER_EGRESS_ALLOW` (intersection, never a union; empty = no
   step gets any egress). The same check runs at publish, at node start and in the proxy;
2. the grant's rules: `host`, `host:port`, `*.suffix` (two labels at least), an IP or a CIDR no wider
   than `/8` (IPv4) or `/32` (IPv6; `0.0.0.0/1` style splits are refused). **No port means 443 only**;
3. the **resolved address**: loopback, link-local, metadata (`169.254.0.0/16`, `fd00:ec2::254`,
   `100.100.100.200`, `168.63.129.16`) and unspecified addresses are never reachable. Private
   destinations (RFC 1918 incl. the Docker bridges and their gateways, `100.64.0.0/10`,
   `198.18.0.0/15`, `fc00::/7`, NAT64 `64:ff9b::/96`, 6to4, multicast) are refused, and so is any IPv6
   address that embeds an IPv4 one (mapped, compatible, SIIT, in any spelling) when the embedded
   address is private, loopback, link-local or metadata; the check is numeric (CIDR), not textual are refused unless an **operator** opened that range in
   `OAX_CONTAINER_EGRESS_PRIVATE_ALLOW` (CIDRs); an `agents.md` can never open them, so an author
   cannot reach `socket-proxy:2375`, `postgres:5432` or `172.17.0.1` by naming them. Every address a
   name resolves to must pass;
4. in **air-gapped mode** the process-wide `OAX_AIRGAPPED_ALLOW` policy on top.

The grant secret must differ from `OAX_RUN_TOKEN_SECRET` (refused at startup) and is passed to the worker and the proxy only, never to the control node. Plain HTTP requests get `405`. Limits: connections, concurrent tunnels per node (8), a short header
timeout for silent clients, an idle timeout per tunnel.

### Docker Compose (evaluation only)

`docker-compose.yml` has an opt-in profile `container-runner`: a socket proxy, the worker with the
container runner and the egress proxy as a separate service.

```bash
# .env
OAX_RUNNERS_ENABLED=in-process,container
OAX_CONTAINER_RUNNER_ENABLED=true
OAX_CONTAINER_IMAGE=ghcr.io/open-agentix/open-agentix-run-node@sha256:<digest>
OAX_CONTAINER_EGRESS_GRANT_SECRET=<random, at least 32 characters>
OAX_CONTAINER_EGRESS_ALLOW=jira.example.com,*.corp.example   # empty = no step egress

docker compose --profile container-runner up --scale worker=0
```

Scale the plain `worker` to 0 so that a run that needs isolation is never claimed by a worker without
a container runner. The images must exist on the engine host (the runner never pulls). `nodes` and
`socket` are `internal: true`; the egress proxy is on `nodes` and `egress` only, the worker on
`default` and `socket` only.

**The socket proxy is root-equivalent.** `tecnativa/docker-socket-proxy` filters by URL, not by
request body: whoever can reach it can still create a privileged container with a host bind mount.
The runner's own create options are hardened and double-checked, but a compromised worker is not
contained by it. For anything but evaluation use rootless Podman or a body-filtering proxy, and pin
the proxy image by digest.

## Model proxy (W1-3b-3, W1-3b-4)

With `OAX_MODEL_PROXY_ENABLED=true` the control node serves two routes for run nodes
([ADR 0009](adr/0009-model-proxy.md); settings in [configuration.md](configuration.md)):

- `POST /v1/worker/runs/{id}/model-token` with `{ "agentId": "..." }` and the node's step-scoped run
  token: returns `{ token, expiresAt, protocol, baseUrl, model }` (`Cache-Control: no-store`). The
  model token (`oaxmt.`) is bound to run, session, node, step agent and one `jti` that is stored in
  `run_node_sessions.model_token_jti`; it can be issued **once per step and session** (`409
  model_token_already_issued`), expires with the session and dies the moment the session is revoked.
  It uses a different key and prefix than the run token, so neither verifies as the other, and it
  opens the model endpoint only (not the gate, approvals, credentials or handover).
- `POST /v1/worker/runs/{id}/model` with the model token (or the step's run token): the body is a
  strict `WorkerModelRequest` (`agentId`, `request.{model, system, messages, tools, maxTokens,
  temperature, hints.context}`), the answer a `WorkerModelResponse` (`callId`, `response`, measured
  `usage`, `costMicros`, `priced`, `remaining`). With `Accept: text/event-stream` the answer is a
  stream of `start`, `delta`, then `done` (the same response object) or `error` events.

**Run node side (W1-3b-4).** `oax run-node` sends every model call of its step, `simulated`
included, through this endpoint with its step-scoped run token (`ModelProxyProvider`, a *metered*
provider); it never holds a provider key and does not compute cost or post `model_call` steps (the
control node refuses them with `400 step_kind_refused`). A refusal of the proxy ends the step with
the proxy's code. The orchestrator takes the cost and tokens of an isolated step from the run's
ledger counters (what the proxy recorded while the node ran), never from the node's report, so
isolated steps count against `maxCostUsd`, `maxTokens` and the monthly budgets like any other step.
In-process steps reserve through `POST /v1/worker/runs/{id}/model-reservations` (orchestrator token
only) and are settled by the control node, see [budgets.md](budgets.md).

What the control node decides, in this order: token and binding (run, session, node, step, `jti`,
session not revoked or expired, run running and cancel flag unset), the model allowlist (the model
and provider are fixed by the published step; the request cannot choose either, and a `provider`
field is refused), data classification against the provider clearance, the air-gapped egress policy
for every endpoint of the provider, the emergency-override hook, strict request validation and
re-serialisation (no server tools, `mcp_servers`, URL sources or file ids; prototype and duplicate
keys refused), then a worst-case reservation against the run, step and monthly budgets. The
provider key is resolved on the control node for the run's scope (BYOK connection of the run's
tenant, else platform provider) and is never returned, logged or audited; provider error text is
scrubbed of it. A provider that ignores `max_tokens` is cut at the reserved bound plus 10 %; a
revoked session, cancelled run, deadline or client disconnect ends an open stream, and the call is
settled from the usage received so far. Every refusal and every internal error fails closed with a
stable code (`model_not_allowed`, `classification_denied`, `egress_denied`, `control_budget_*`,
`model_unpriced`, `model_rate_limited`, `provider_error`, `provider_timeout`,
`model_proxy_unavailable`, ...) in the envelope `{ "error": { "code", "message" } }`. Bodies are
never logged. Audit: `model_token.issued`, `model.denied` (once a minute per session and reason),
`model.aborted`, `model.overrun`, `model.usage_floor`, `model.reservation_expired` and the
`step.model_call` entry of every settlement (`via: proxy`). Metrics: `oax_model_proxy_*`.

### Pass-through surfaces (W1-3b-6)

For harnesses that speak a vendor protocol the proxy serves the Anthropic Messages and OpenAI Chat
Completions APIs under the same switch (`OAX_MODEL_PROXY_ENABLED`):

| Route | Purpose |
| --- | --- |
| `POST /v1/model-proxy/anthropic/v1/messages` | Anthropic Messages, JSON or SSE (`stream: true`) |
| `POST /v1/model-proxy/openai/v1/chat/completions` | OpenAI Chat Completions, JSON or SSE |
| `GET /v1/model-proxy/anthropic/v1/models`, `GET /v1/model-proxy/openai/v1/models` | list exactly the model of the step |

- **Credential**: the **model token** only, as `x-api-key` or `Authorization: Bearer` (two different
  values are refused as ambiguous). A run token never opens these routes. The path has no run id;
  the run, session and step come from the token. Neither header is ever forwarded upstream: the
  upstream request carries the provider key resolved on the control node and nothing else from the
  client except the `anthropic-beta` values listed in `OAX_MODEL_PROXY_ANTHROPIC_BETAS`.
- **Same admission as the native route**: token and session binding, model allowlist (the request's
  `model` must be the step's published model), classification, air-gap, SSRF checks on tenant
  endpoints, worst-case reservation, settlement from the measured usage, rate and concurrency limits.
  The step's provider must speak the surface (`400 model_surface_mismatch`; no translation between
  protocols; `simulated` works on both).
- **Strict request allowlist**: unknown keys and server tools, `mcp_servers`, URL or file sources,
  `n > 1`, `logprobs`, audio and the like are `400 model_parameter_refused`; the upstream body is
  rebuilt from the validated fields (`metadata` and `user` are dropped, `max_tokens` is clamped to the
  reservation, never raised).
- **Streams** are relayed event by event, each event **rebuilt from allowlisted fields** (unknown
  keys and event types are dropped). The hard stop of the native stream applies: output beyond the
  reserved bound plus 10 %, a revoked session, a cancelled run, the call deadline or a client
  disconnect ends the upstream request and the stream, and the call is settled from what was
  streamed. A mid-stream stop is sent as `event: error` (Anthropic) or a final `data: {"error":...}`
  chunk without `[DONE]` (OpenAI). Errors in the protocol's own envelope carry the platform code in
  `error.code`.
- Not served yet: `POST .../messages/count_tokens` and `GET .../models/{id}`.

## Not in this version

- **OpenCode run-node image.** The Claude Code image exists (DOG-1, below); the image target for
  OpenCode does not. A `opencode` harness step fails with `harness_image_unknown` until the operator
  maps a self-built image.

### Known follow-ups

- Credentials are delivered per step, not per stdio server: all of a step's secrets are in the
  node process and its children; UID separation or ptrace hardening between the node and its tool
  processes is open.
- `assertSafeCreateBody` is a deny list; it should become an allow list of exactly the options the
  runner sets. Network membership (only the intended neighbours on the node network), the
  inspect-then-create gap (TOCTOU) and inter-container traffic between nodes need a stricter
  network model.
- The import-boundary test of the run node is shallow and the run-node image still contains the
  control node packages; a slim image stage is open. Posting a result after revocation races with
  the orchestrator's read; a node can claim any failure status (it cannot succeed without an output
  that the orchestrator validates). The gate only constrains cooperating nodes: a compromised node
  can skip it, which is why credentials and egress are the real boundary.
- Minor: approval requests from a node are not rate limited; error messages of the broker are
  distinguishable; cancellation is polled every two seconds; the migration default tenant id is
  the legacy constant.
- Step groups, dynamic credential sources (Vault, STS), mTLS (W2-2), signed toolbox images (W2-1).

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
