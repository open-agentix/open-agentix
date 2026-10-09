# Configuration contract

This is the contract between the platform, the **Helm chart** (`open-agentix/open-agentix-helm`)
and the **UI**. The control node (`api`) and the worker read the same environment variables
(`apps/api/src/config.ts` validates them at start-up and refuses to start on invalid values).

Secrets are never stored in the database, agent files or prompts: anything marked *secret*
should come from a Kubernetes Secret (`envFrom`/`secretKeyRef`) or a mounted file.

## Images and processes

Chart and images are named `open-agentix` (chart repo `open-agentix/open-agentix-helm`).

| Image | Command (workdir) | Port | Probes |
| --- | --- | --- | --- |
| `ghcr.io/open-agentix/open-agentix-api:<version>` | `node dist/main.js` (`/app/apps/api`) | 8080 | liveness `GET /healthz`, readiness `GET /readyz` (DB reachable + schema migrated) |
| `ghcr.io/open-agentix/open-agentix-api:<version>` | `node dist/migrate-cli.js` (`/app/apps/api`) | – | migrations Job (Helm hook); needs **only** the database variables |
| `ghcr.io/open-agentix/open-agentix-worker:<version>` | `node dist/main.js` (`/app/apps/worker`) | 9090 | `GET /healthz`, `GET /readyz` (DB + schema + loop), `GET /metrics` |
| `ghcr.io/open-agentix/open-agentix-ui:<version>` | nginx (`apps/ui/Dockerfile`, `apps/ui/nginx.conf`) | 8080 | `GET /healthz`; `nginxinc/nginx-unprivileged`, uid 101, static SPA; mount `emptyDir` on `/tmp` and `/var/cache/nginx` for a read-only root fs. Route `/v1`, `/healthz` of the API and `/openapi.json` to the API at the ingress, or build with `VITE_OAX_API_URL` for a separate API origin. |

API and worker images run as user `node` (uid 1000), need no writable root file system (mount
`/tmp` as `emptyDir` if desired) and no Linux capabilities. Images carry the label
`org.opencontainers.image.version` and are signed with cosign (keyless) with an SPDX SBOM
attestation (release workflow).

Migrations run under a Postgres advisory lock, so the Helm hook Job and API replicas with
`OAX_DB_MIGRATE_ON_START=true` can race safely; every process waits for the database with
exponential backoff before it starts.

## Core

| Variable | Default | Used by | Meaning |
| --- | --- | --- | --- |
| `NODE_ENV` | `production` | both | `production` requires `OAX_RUN_TOKEN_SECRET`. |
| `OAX_HOST` | `0.0.0.0` | api | Listen address. |
| `OAX_PORT` | `8080` | api | Listen port. |
| `OAX_PUBLIC_URL` | `http://localhost:8080` | api | External base URL (OIDC redirects, ingest URLs, OpenAPI servers). |
| `OAX_UI_URL` | – | api | UI base URL; OIDC callback redirects to `<ui>/auth/callback#token=…`. |
| `OAX_CORS_ORIGINS` | – | api | Comma-separated allowed origins (the UI). Empty = no CORS. |
| `OAX_TRUST_PROXY` | `false` | api | Trust `X-Forwarded-*` (behind an ingress/ALB). |
| `OAX_LOG_LEVEL` | `info` | both | `fatal`…`trace`, `silent`. JSON logs, secrets redacted. |
| `OAX_BODY_LIMIT_BYTES` | `1048576` | api | Max request body size. |

## Database

| Variable | Default | Used by | Meaning |
| --- | --- | --- | --- |
| `OAX_DATABASE_URL` | – (*secret* if it contains a password) | both | `postgres://user@host:5432/db?sslmode=require`. `memory://` / `pglite://<dir>` = embedded PGlite (tests/demos only). Either this or `PGHOST` is required. |
| `OAX_DATABASE_PASSWORD` | – (*secret*) | both | Password, overrides the URL password (no URL encoding needed). |
| `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGSSLMODE` | – / `5432` / – / – / `openagentix` / – | both | libpq-style alternative to `OAX_DATABASE_URL` (e.g. from a CloudNativePG/RDS secret). `OAX_DATABASE_PASSWORD` wins over `PGPASSWORD`. |
| `OAX_DB_CONNECT_RETRIES` | `30` | both | Attempts to reach the database at start-up (exponential backoff, capped at 5 s). |
| `OAX_DB_CONNECT_BACKOFF_MS` | `500` | both | Initial backoff. |
| `OAX_DB_POOL_MAX` | `20` | both | Connection pool size per process. |
| `OAX_DB_STATEMENT_TIMEOUT_MS` | `15000` | both | `statement_timeout` per connection (also used by `migrate-cli`). |
| `OAX_DB_MIGRATE_ON_START` | `true` | both | Apply migrations at start. Set `false` when Helm runs the migration Job; set `false` on workers. |

Least-privilege roles: [`deploy/sql/roles.sql`](../deploy/sql/roles.sql).

## Cache

| Variable | Default | Meaning |
| --- | --- | --- |
| `OAX_CACHE_URL` | – | `redis://` / `rediss://` URL of Valkey/Redis (shared cache + invalidation across replicas). Empty = in-memory LRU per process. |
| `OAX_CACHE_MAX_ENTRIES` | `10000` | LRU size. |
| `OAX_AUTH_CACHE_TTL_SECONDS` | `30` | Max time a resolved token/principal is cached (never longer than the token lifetime). |

## Authentication

| Variable | Default | Meaning |
| --- | --- | --- |
| `OAX_BOOTSTRAP_ADMIN_EMAIL` | – | Creates a local admin when the user table is empty. |
| `OAX_BOOTSTRAP_ADMIN_PASSWORD` | – (*secret*, >= 12 chars) | Password of the bootstrap admin. |
| `OAX_ROLE_BINDINGS_SHADOW` | `true` | Compare the tenant role resolver with the legacy role bindings after each principal build and count the result in `oax_role_bindings_shadow_total` (ADR 0014 S1). The legacy result always decides; set `false` to skip the extra reads. |
| `OAX_SESSION_TTL_SECONDS` | `28800` | Lifetime of session tokens from login. |
| `OAX_TOKEN_MAX_TTL_DAYS` | `365` | Upper bound for API token lifetimes. |
| `OAX_TENANT_MAX_DEPTH` | `32` | Levels allowed below an organisation (root = 0), 1 to 32. 32 is the technical safety maximum of the tenant tree (ADR 0013); lower it only to forbid deep trees. |
| `OAX_TENANT_MAX_NODES_PER_ROOT` | `1000` | Guard against runaway automation: tenants (nodes) per organisation. |
| `OAX_RATE_LIMIT_MAX` | `600` | Requests per minute per token/IP. |
| `OAX_RATE_LIMIT_LOGIN_MAX` | `10` | Login attempts per minute per IP. |
| `OAX_RATE_LIMIT_PLAN_MAX` | `30` | Agent plan checks and drafts (`POST /v1/plans/*`) per minute per token/IP. |
| `OAX_OIDC_ISSUER` | – | Issuer URL (Keycloak realm, Entra ID tenant, Okta). OIDC is enabled when issuer, client id and redirect URI are set. |
| `OAX_OIDC_CLIENT_ID` | – | Client id. |
| `OAX_OIDC_CLIENT_SECRET` | – (*secret*) | Client secret (confidential client; PKCE is always used). |
| `OAX_OIDC_REDIRECT_URI` | – | `<public url>/v1/auth/oidc/callback`. |
| `OAX_OIDC_SCOPES` | `openid profile email` | Requested scopes. |
| `OAX_OIDC_GROUPS_CLAIM` | `groups` | Claim with group names. |
| `OAX_OIDC_ROLE_MAPPING` | `{}` | JSON: group -> `role` or `role@team-slug` (or a list). |
| `OAX_LDAP_URL` | – | `ldaps://ldap.example.com:636`. LDAP is enabled with URL + user base DN. |
| `OAX_LDAP_BIND_DN` | – | Service account for the user search. |
| `OAX_LDAP_BIND_PASSWORD` | – (*secret*) | Its password. |
| `OAX_LDAP_USER_BASE_DN` | – | Search base, e.g. `ou=people,dc=example,dc=com`. |
| `OAX_LDAP_USER_FILTER` | `(uid={username})` | `{username}` is RFC 4515 escaped. AD: `(sAMAccountName={username})`. |
| `OAX_LDAP_GROUP_ATTRIBUTE` | `memberOf` | Attribute with group DNs. |
| `OAX_LDAP_ROLE_MAPPING` | `{}` | JSON: group DN -> `role` / `role@team-slug`. |
| `OAX_LDAP_TLS_REJECT_UNAUTHORIZED` | `true` | Verify the LDAP server certificate. |

Roles: `admin`, `agent-engineer`, `integrator`, `operator`, `auditor`, `viewer`
(permissions: `GET /v1/settings` or `packages/core/src/rbac.ts`).

## Audit

| Variable | Default | Meaning |
| --- | --- | --- |
| `OAX_AUDIT_SIGNING_KEY` | – (*secret*) | Ed25519 private key (PKCS#8 PEM or base64 DER) for checkpoints. Generate: `openssl genpkey -algorithm ed25519`. |
| `OAX_AUDIT_SIGNING_KEY_ID` | `default` | Key id written into checkpoints (rotate by changing id + key). |
| `OAX_AUDIT_PUBLIC_KEYS` | `{}` | JSON `{keyId: publicKeyPem}` of older keys to verify historic checkpoints. |
| `OAX_AUDIT_CHECKPOINT_EVERY` | `1000` | Sign a checkpoint every N entries. |

## Worker, runs and control agent

| Variable | Default | Used by | Meaning |
| --- | --- | --- | --- |
| `OAX_RUN_TOKEN_SECRET` | dev fallback (*secret*, >= 32 chars, required in production) | both | HMAC key for run tokens (control node <-> worker nodes). Same value on api and worker. |
| `OAX_RUN_TOKEN_TTL_SECONDS` | `14400` | both | Run token lifetime. |
| `OAX_WORKER_CONCURRENCY` | `4` | worker | Parallel runs per worker process. |
| `OAX_WORKER_POLL_MS` | `500` | worker | Queue poll interval. |
| `OAX_WORKER_LEASE_SECONDS` | `60` | worker | Run lease; renewed every lease/3, expired leases are requeued. |
| `OAX_WORKER_MAX_ATTEMPTS` | `3` | worker | Attempts before a lost run is failed. |
| `OAX_APPROVAL_POLL_MS` | `1000` | worker | Poll interval while waiting for a human approval. |
| `OAX_CONTROL_MAX_TOOL_CALLS_PER_MINUTE` | `30` | worker | Rate guardrail of the control agent (pause above). |
| `OAX_DEFAULT_MAX_STEPS` | `50` | worker | Reserved: platform default when an agent sets no step budget. |
| `OAX_DEFAULT_TIMEOUT_SECONDS` | `1800` | worker | Reserved: platform default timeout. |
| `OAX_DEMO_MCP` | `false` | worker | Registers the built-in demo MCP servers (`cve-db`, `tickets`) for `in-memory` connections. Demo only. |
| `OAX_WORKER_HTTP_PORT` | `9090` | worker | Port of the worker's probe/metrics server. |
| `OAX_WORKER_HTTP_HOST` | `0.0.0.0` | worker | Listen address of that server. |
| `OAX_SSE_POLL_MS` | `500` | api | Poll interval of `GET /v1/runs/{id}/stream`. |

## Input hardening

Stages that clean text before it enters a model's context or a stored step output (details:
[input hardening](security-input-hardening.md)). Both are on by default; switch off only to diagnose.

| Variable | Default | Used by | Meaning |
| --- | --- | --- | --- |
| `OAX_STRIP_INVISIBLE_UNICODE` | `true` | worker, run node | Remove zero-width, bidi, tag and control characters from prompts and tool results. `0`, `false`, `off` or `no` disables; any other value keeps it on. |
| `OAX_REDACT_MODEL_CONTEXT` | `true` | worker, run node | Replace known secret values and token shapes with `[redacted:<kind>]` in prompts and tool results. Same value rules. |

## Providers and costs

| Variable | Default | Meaning |
| --- | --- | --- |
| `OAX_PROVIDERS` | `[{"kind":"simulated","name":"simulated"}]` | JSON array of providers (below). Agents reference them by `name`. |
| `OAX_PRICE_TABLE` | `[]` | JSON array `{provider, model (glob), inputPerMTok, outputPerMTok, perToolCallUsd?}` in USD; `provider` is the provider name or kind. `simulated`/`ollama` are free. Example: [`examples/prices.example.json`](../examples/prices.example.json). |
| `OAX_SECRET_<NAME>` | – (*secret*) | Value of the secret reference `<name>` (upper case, non-alphanumerics -> `_`; `<NAME>` must match `[A-Z0-9_]+`, validated at start-up). |
| `OAX_SECRETS_DIR` | – | Directory with one file per secret reference (e.g. a mounted Kubernetes Secret). |

Provider entries use the same settings as model connections, plus a `name` agents reference.
`kind` is one of `anthropic`, `bedrock`, `openai`, `azure-openai`, `openrouter`, `vllm`, `lmstudio`,
`ollama`, `openai-compatible`, `simulated`; see [Models, providers and keys](providers.md) for every
field. `clearance` = highest data classification the provider may receive
(`public|internal|confidential|restricted`); `proxyUrl`, `timeoutMs`, `maxRetries` and `models`
(price overrides) are optional on all:

```json
[
  { "kind": "simulated", "name": "simulated" },
  { "kind": "ollama", "name": "ollama", "baseUrl": "http://ollama:11434", "clearance": "restricted" },
  { "kind": "openai", "name": "openai", "apiKeySecret": "openai-key" },
  { "kind": "azure-openai", "name": "azure", "endpoint": "https://res.openai.azure.com",
    "apiKeySecret": "azure-openai-key" },
  { "kind": "openrouter", "name": "router", "apiKeySecret": "openrouter-key" },
  { "kind": "vllm", "name": "vllm", "baseUrl": "http://vllm:8000/v1" },
  { "kind": "anthropic", "name": "anthropic", "apiKeySecret": "anthropic-key" },
  { "kind": "bedrock", "name": "bedrock", "region": "eu-central-1",
    "endpoint": "https://vpce-0abc.bedrock-runtime.eu-central-1.vpce.amazonaws.com",
    "proxyUrl": "http://egress-proxy:3128", "clearance": "confidential" }
]
```

Prices come from the pinned model catalog; `OAX_PRICE_TABLE` overrides them. Tenants and teams add
their own providers and keys at run time through model connections (BYOK), see
[Models, providers and keys](providers.md).

Bedrock uses the AWS default credential chain: on EKS annotate the ServiceAccount with
`eks.amazonaws.com/role-arn` (IRSA); no keys in configuration. Standard AWS variables
(`AWS_REGION`, `AWS_ROLE_ARN`, `AWS_WEB_IDENTITY_TOKEN_FILE`, `HTTPS_PROXY` for the SDK) apply.

## Public demo mode

| Variable | Default | Meaning |
| --- | --- | --- |
| `OAX_DEMO_MODE` | `false` | Seeds the deterministic demo data set on first start (2 tenants, users for all six roles incl. an agent-scoped user, 6 agents incl. dark-factory, hardening and change-gated agents, runs, approvals, costs, verifiable audit chain) and makes the API read-only except sign-in and side-effect-free checks (validate, dry-run, policy evaluation, hardening review, audit verify). Responses carry `x-oax-demo: true`; `GET /v1/settings` reports `demo: true`. Use with the simulated provider only. Helm: `demo.enabled`. |
| `OAX_DEMO_PASSWORD` | `demo-password-2026` | Shared password of the fake demo users (`admin@example.org`, `engineer@`, `integrator@`, `operator@`, `auditor@`, `viewer@`, `contractor@example.org`). Not a secret. |

`pnpm seed:demo` loads the same data set into an empty database (`--force` to add anyway).
Compose (standalone: api, worker, ui, postgres): `docker compose -f docker-compose.demo.yml up --build`.

Fixed scenarios and the optional live model are described in [`demo.md`](demo.md):

| Variable | Default | Meaning |
| --- | --- | --- |
| `OAX_DEMO_LLM` | `simulated` | `claude-code` runs visitor-started scenarios through the Claude Code harness (requires `OAX_DEMO_MODE=true`). |
| `OAX_DEMO_LLM_MODEL` | `haiku` | Model alias passed to the harness. |
| `OAX_DEMO_LLM_TOKEN_FILE` | – | File with a token from `claude setup-token`, mounted read-only into the worker (never an environment value). Without it the login of the worker's user is used. |
| `OAX_DEMO_LLM_DAILY_BUDGET_USD` | `1` | Daily cap for live model runs (runs in flight reserve `OAX_DEMO_LLM_RUN_BUDGET_USD`). |
| `OAX_DEMO_LLM_RUN_BUDGET_USD` | `0.05` | Hard cost cap of one scenario run. |
| `OAX_DEMO_LLM_WORKDIR` | OS temp dir | Parent of the harness' temporary work directories. |
| `OAX_DEMO_RATE_RUNS`, `OAX_DEMO_RATE_WINDOW_SECONDS` | `3`, `600` | Scenario runs per visitor (salted hash of the client IP) and window. |
| `OAX_DEMO_DAILY_RUNS` | `100` | Scenario runs per day for the whole demo. |

## Outbound proxy

Node's `fetch` and the AWS SDK do not honour proxy variables on their own; openagentix resolves
them explicitly for **LLM providers** (OpenAI-compatible, Ollama, Anthropic, Bedrock), **OIDC**
(discovery, JWKS, token endpoint) and **MCP over streamable HTTP**.

| Variable | Meaning |
| --- | --- |
| `HTTPS_PROXY` / `https_proxy` | Proxy for `https://` targets (falls back to `HTTP_PROXY`). |
| `HTTP_PROXY` / `http_proxy` | Proxy for `http://` targets. |
| `NO_PROXY` / `no_proxy` | Comma list of hosts, domain suffixes (`.internal`), `host:port` or `*` that bypass the proxy (e.g. VPC endpoints `.vpce.amazonaws.com`, the database, in-cluster services). |

A provider's own `proxyUrl` overrides the environment for that provider (NO_PROXY still applies).
**LDAP** connections (`ldap://`/`ldaps://`) are plain TCP/TLS and are **not** proxied; allow
direct egress to the directory (NetworkPolicy) instead. Kafka brokers and PostgreSQL are not
proxied either.

## Runners and toolboxes (v0.2)

The `container` runner is implemented and opt-in (see [runners.md](runners.md)). The `OAX_K8S_*` variables are consumed by the `kubernetes-job` runner (see
[kubernetes-job-runner.md](kubernetes-job-runner.md)), which stays opt-in behind `OAX_K8S_JOB_ENABLED`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `OAX_RUNNERS_ENABLED` | `in-process` | Comma list of runners agents may use (`in-process`, `local`, `container`, `kubernetes-job`, `aws-lambda`, `github-actions`, `gitlab-ci`). Publishing an agent with another `runtime.runner` fails. |
| `OAX_CONTAINER_RUNNER_ENABLED` | `false` | Feature flag; required when `container` is listed in `OAX_RUNNERS_ENABLED`. With it on, `OAX_CONTAINER_ENGINE_URL`, `OAX_CONTAINER_IMAGE` (digest-pinned), `OAX_CONTAINER_NETWORK` (internal) and `OAX_NODE_CONTROL_URL` are required, otherwise the process refuses to start. |
| `OAX_CONTAINER_ENGINE` | `docker` | `docker` or `podman`. |
| `OAX_CONTAINER_ENGINE_URL` | – | `unix:///path/to/podman.sock` or a socket proxy `http://socket-proxy:2375`. The raw Docker socket is refused. |
| `OAX_CONTAINER_ALLOW_RAW_SOCKET` | `false` | Unsafe: allow `/var/run/docker.sock` (warning at start, audit `runner.unsafe_socket`). |
| `OAX_CONTAINER_IMAGE` | – | Run node image, `name@sha256:<digest>` only. |
| `OAX_CONTAINER_TOOLBOX_IMAGES` | `{}` | JSON map toolbox name -> digest-pinned image. |
| `OAX_CONTAINER_HARNESS_IMAGES` | `{}` | JSON map harness (`claude-code`, `opencode`) -> digest-pinned image; a harness step runs only on its harness image (`harness_image_unknown` otherwise). See [runners](runners.md#harness-images-dog-1). |
| `OAX_PR_TARGETS` | – | worker | Path of the JSON file with the pull request delivery targets (DOG-4, [bug-fix agent](bug-fix-agent.md)). Unset: steps with a `pull-request` output fail closed. |
| `OAX_PR_DRY_RUN` | `false` | worker | `true`: delivery stops after the local commit (no push, no pull request). |
| `OAX_PR_PRIVATE_ALLOW` | – | worker | Private Git destinations (hosts/CIDRs) the delivery may reach. |
| `OAX_WORKSPACE_ROOT`, `OAX_WORKSPACE_STATE_DIR` | `/tmp/workspace`, `/tmp/oax-workspace` | run node | Where the node unpacks the seed and keeps the workspace server's configuration and result. |
| `OAX_CONTAINER_MEMORY_MB` | `512` | Memory (MiB) of an ordinary run node, clamped to `OAX_CONTAINER_MAX_MEMORY_MB`. The max is the ceiling, not the default. |
| `OAX_CONTAINER_TMP_MB` | `64` | `/tmp` tmpfs size (MiB) of an ordinary run node; at most half of the node memory. |
| `OAX_CONTAINER_HARNESS_MEMORY_MB` | `2048` | Memory (MiB) of a harness step's node, clamped to `OAX_CONTAINER_MAX_MEMORY_MB`. |
| `OAX_CONTAINER_HARNESS_TMP_MB` | `256` | `/tmp` tmpfs size (MiB) of a harness step's node (repository checkout, test scratch). At most half of the node memory. |
| `OAX_HARNESS_EGRESS_ALLOWED` | `false` | Allow harness steps to declare egress hosts. Default: a harness step reaches the control node only (refused at publish and at node start). **Exfiltration risk** when `true`: see [runners](runners.md). |
| `OAX_CONTAINER_NETWORK` | – | Pre-created network with `internal: true` (verified before every start). |
| `OAX_CONTAINER_EGRESS_PROXY_URL` / `OAX_CONTAINER_EGRESS_GRANT_SECRET` | – | URL nodes use for the separate egress proxy service and the HMAC key (>= 32 chars) that signs per-node grants; set both or neither (neither = no step egress). |
| `OAX_CONTAINER_EGRESS_ALLOW` | – | Operator ceiling for step egress (`host`, `host:port`, `*.suffix`, IP, CIDR no wider than /8); steps can only narrow it; empty = no step egress. Checked at publish, at node start and by the proxy. |
| `OAX_CONTAINER_EGRESS_PRIVATE_ALLOW` | – | Private CIDRs the egress proxy may reach where a rule matches; private ranges are closed otherwise. Proxy-side (`OAX_EGRESS_PROXY_LISTEN` is its listen address). |
| `OAX_CONTAINER_MAX_CPUS` / `OAX_CONTAINER_MAX_MEMORY_MB` / `OAX_CONTAINER_MAX_PIDS` | `1` / `512` / `256` | Upper bounds for a node container. |
| `OAX_NODE_CONTROL_URL` | – | Control node base URL as seen from run nodes (internal network). Required by `container`; for `kubernetes-job` it is required too and must be `https://`. |
| `OAX_K8S_JOB_ENABLED` | `false` | Feature flag; required when `kubernetes-job` is enabled. |
| `OAX_K8S_IMAGE` | – | Default run node image, `repo@sha256:<digest>` under `OAX_TOOLBOX_REGISTRY` and allowlisted (`OAX_K8S_RUN_NODE_IMAGES`/toolbox name). **Required** when `kubernetes-job` is enabled; checked at config load. |
| `OAX_K8S_TOOLBOX_IMAGES` | `{}` | JSON map toolbox name -> digest-pinned image (must be in `OAX_TOOLBOX_ALLOWLIST`); an unknown toolbox fails closed (`toolbox_image_unknown`). |
| `OAX_K8S_CONTROL_PLANE_POD_SELECTOR` / `OAX_K8S_CONTROL_PLANE_NAMESPACE_SELECTOR` | – | JSON label selectors (non-empty) of the control node Pods that run Pods may reach; prefer `{"kubernetes.io/metadata.name":"<ns>"}` for the namespace. At least one of the two selectors or `OAX_K8S_CONTROL_PLANE_CIDRS` is **required** when `kubernetes-job` is enabled. |
| `OAX_K8S_CONTROL_PLANE_CIDRS` / `OAX_K8S_CONTROL_PLANE_PORTS` | – / `443` | Comma lists: control node CIDRs (no broader than `/24` IPv4 or `/64` IPv6, never inside IMDS/link-local/loopback; denied ranges inside are excluded) and TCP ports (at least one) a run Pod may reach. |
| `OAX_K8S_DNS_EGRESS` | `true` | Allow DNS to kube-dns (needed to resolve the control node). |
| `OAX_K8S_AUTOMOUNT_SA_TOKEN` | `false` | Mount the ServiceAccount API token into run Pods (a step never needs it). |
| `OAX_K8S_DEFAULT_DENY_POLICY` | `default-deny-all` | Name of the namespace-wide default-deny NetworkPolicy that must exist; a step does not start without it. The worker Role grants `get` on this name only (`resourceNames` in `docs/examples/kubernetes-job-runner-rbac.yaml`), so change both together. |
| `OAX_K8S_NAMESPACE` | `openagentix-runs` | Namespace for run Jobs. |
| `OAX_K8S_SERVICE_ACCOUNT` | `openagentix-run-node` | ServiceAccount of run Jobs (annotate for IRSA on EKS); must differ from the worker's. |
| `OAX_K8S_WORKER_SERVICE_ACCOUNT` / `OAX_K8S_WORKER_NAMESPACE` | `openagentix-worker` / – | Worker identity the runner refuses to reuse for step Pods. |
| `OAX_K8S_RUN_NODE_IMAGES` | – | Comma list of non-toolbox images (repository path below the registry) allowed as run node. |
| `OAX_K8S_DENY_CIDRS` | – | Always-denied CIDRs (pod, service, node, API server) punched out of allowed egress, in addition to the built-in link-local/IMDS/loopback. |
| `OAX_K8S_SIGNATURES_VERIFIED_BY_ADMISSION` | `false` | Confirms an admission policy verifies image signatures; required when `OAX_TOOLBOX_REQUIRE_SIGNATURE=true` and `kubernetes-job` is enabled. |
| `OAX_K8S_TTL_SECONDS_AFTER_FINISHED` | `600` | Job TTL. |
| `OAX_K8S_ACTIVE_DEADLINE_SECONDS` | `3600` | Job deadline. |
| `OAX_K8S_IMAGE_PULL_SECRETS` | – | Comma list of image pull secret names. |
| `OAX_K8S_NODE_SELECTOR` | `{}` | JSON node selector for run Pods. |
| `OAX_K8S_RESOURCES_CPU` / `OAX_K8S_RESOURCES_MEMORY` | `500m` / `512Mi` | Requests/limits of run Pods. |
| `OAX_K8S_EGRESS` | – | Operator upper bound for step egress CIDRs (a step can only narrow it; prefix >= /8 or /32). Host names are not enforceable by NetworkPolicies. |
| `OAX_TOOLBOX_REGISTRY` | `ghcr.io/open-agentix` | Registry of toolbox images. |
| `OAX_TOOLBOX_ALLOWLIST` | – | Comma list of toolbox names agents may declare (`runtime.toolbox`). Enforced at publish; the `kubernetes-job` runner treats an empty list as "no toolbox allowed" and refuses to start without it. |
| `OAX_TOOLBOX_REQUIRE_SIGNATURE` | `true` | Only run cosign-verified toolbox images. **Not enforced by the runner itself**: with `kubernetes-job` enabled the node refuses to start unless `OAX_K8S_SIGNATURES_VERIFIED_BY_ADMISSION=true` (an admission policy verifies). |

## Model proxy (v0.2)

The control node can serve model calls of isolated run nodes: the node holds only a step-scoped
token, the provider key is resolved on the control node, the control node measures tokens and
settles the cost, and a worst-case reservation is held against every applicable budget before the
call ([ADR 0009](adr/0009-model-proxy.md); how it works and how to call it: [runners.md](runners.md)).
Opt-in; with the flag off, `POST /v1/worker/runs/{id}/model` and `.../model-token` answer
`503 model_proxy_unavailable` and nodes behave as before. Concurrency limits are counted in the
database (reservations), so they hold across api replicas; the per-run call rate and the in-flight
limit are per replica.

| Variable | Default | Meaning |
| --- | --- | --- |
| `OAX_MODEL_PROXY_ENABLED` | `false` | Feature flag of the model proxy (native endpoint and model token). |
| `OAX_HARNESSES_ENABLED` | empty | Comma-separated harnesses a step may name in `runtime.harness` (`claude-code`, `opencode`). Requires `OAX_MODEL_PROXY_ENABLED=true`. Run nodes find the binaries through `OAX_CLAUDE_BIN`, `OAX_OPENCODE_BIN` and `OAX_OPENCODE_SHA256` (set by the node image, never downloaded). |
| `OAX_MODEL_PROXY_MAX_BODY_BYTES` | `8388608` | Largest request body (8 MiB); larger bodies get `413 model_request_too_large`. |
| `OAX_MODEL_PROXY_RESERVATION` | `upper-bound` | `upper-bound` reserves the proven worst-case input (UTF-8 bytes plus overheads); `estimate` reserves a third of it (fewer refusals near a limit, no guarantee). |
| `OAX_MODEL_PROXY_MIN_OUTPUT_TOKENS` | `256` | A call whose tightest budget leaves fewer output tokens is refused with that budget's code instead of being shrunk. |
| `OAX_MODEL_PROXY_MAX_CONCURRENT_PER_SESSION` | `2` | Active reservations (calls in flight) per run node session. |
| `OAX_MODEL_PROXY_MAX_CONCURRENT_PER_TENANT` | `16` | Active reservations per tenant. |
| `OAX_MODEL_PROXY_MAX_STREAMS` | `256` | Calls in flight on one replica (streams and plain calls). |
| `OAX_MODEL_PROXY_CALLS_PER_MINUTE` | `60` | Calls per run and minute (sliding window, per replica). |
| `OAX_MODEL_PROXY_MAX_CALL_SECONDS` | `600` | Deadline of one call (also bounded by the step's remaining timeout); also the base of the reservation expiry. |
| `OAX_MODEL_PROXY_TTFB_SECONDS` | `120` | Streaming: time to the first upstream event. |
| `OAX_MODEL_PROXY_IDLE_SECONDS` | `60` | Streaming: longest silence between two upstream events. |
| `OAX_MODEL_PROXY_GRACE_SECONDS` | `60` | A reservation outlives its call deadline by this long before the worker's reaper settles it at the reserved amount. |
| `OAX_MODEL_PROXY_REVOCATION_POLL_MS` | `2000` | While a call is open the session and run are polled this often; revocation, cancellation or lease loss ends the call within one interval. |
| `OAX_MODEL_PROXY_MAX_RESPONSE_BYTES` | `16777216` | Largest upstream response of one call (16 MiB). |
| `OAX_MODEL_PROXY_PRIVATE_ALLOW` | – | Private destinations (hosts, suffixes, CIDRs) that tenant-controlled endpoints (BYOK model connections) may reach; everything private, loopback, link-local or metadata is refused otherwise (`403 egress_denied`). |
| `OAX_MODEL_PROXY_ANTHROPIC_BETAS` | – | `anthropic-beta` values the Anthropic pass-through surface forwards (comma separated, each `[a-z0-9._-]{1,64}`); every other value a client sends is dropped. Empty = none forwarded. |
| `OAX_MODEL_PROXY_CAPTURE` | `metadata` | `metadata` stores the response text, tool calls and stop reason in the step record (never the request); `off` stores only metadata. Bodies are never logged. |

Note on betas: a forwarded beta header can change how the provider bills a call (for example long-context pricing). The reservation does not know such surcharges, so only enable betas whose pricing you have checked; a call that costs more than reserved is capped to the reservation and logged as `model.overrun`.

## Webhooks

| Variable | Default | Meaning |
| --- | --- | --- |
| `OAX_WEBHOOK_TOLERANCE_SECONDS` | `300` | Allowed clock skew for `x-oax-timestamp`; replay window. |
| `OAX_WEBHOOK_MAX_BYTES` | `1048576` | Max webhook body size. |

Signature scheme `oax-v1`: `x-oax-timestamp: <unix>`, `x-oax-signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`,
optional `x-oax-delivery: <id>`. Scheme `github`: `x-hub-signature-256` + `x-github-delivery`.
Event sources reference signing secrets by name (`secretRefs`, two during rotation).

## Observability

| Variable | Default | Meaning |
| --- | --- | --- |
| `OAX_METRICS_TOKEN` | – (*secret*) | If set, `GET /metrics` (API and worker) requires `Authorization: Bearer <token>` (ServiceMonitor `bearerTokenSecret`). |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | – | Enables OpenTelemetry traces via OTLP/HTTP (`<endpoint>/v1/traces`). |
| `OTEL_SERVICE_NAME` | `openagentix-api` / `openagentix-worker` | Service name in traces. |

## Air-gapped mode

`OAX_AIRGAPPED=true` enables a fail-closed egress policy: start-up is refused when an enabled
provider, MCP connection, OIDC, LDAP, OTel, outbound-webhook or proxy endpoint is not on
`OAX_AIRGAPPED_ALLOW` (hosts, `.suffixes`, IPs, CIDRs, optional `:port`); the model catalog stays
on the vendored snapshot. `/readyz` reports `airgapped`. Details: [`airgapped.md`](airgapped.md).

| Variable | Default | Meaning |
| --- | --- | --- |
| `OAX_AIRGAPPED` | `false` | Fail-closed air-gapped mode. |
| `OAX_AIRGAPPED_ALLOW` | – | Internal hosts/suffixes/CIDRs that may be contacted (loopback, database and cache are implicit). |

## What the UI needs

- Base URL of the API (`OAX_PUBLIC_URL`), the OpenAPI document at `/openapi.json` or
  [`openapi.yaml`](../openapi.yaml), and its origin in `OAX_CORS_ORIGINS`.
- Login: `POST /v1/auth/login` (local/LDAP) or redirect to `GET /v1/auth/oidc/login`; the OIDC
  callback redirects to `<OAX_UI_URL>/auth/callback#token=<session token>`.
- Capabilities and labels: `GET /v1/settings` (providers, runners, enabled auth methods, roles,
  permissions) and `GET /v1/me` (effective permissions for showing/hiding actions).
- Live runs: `GET /v1/runs/{id}/stream` (SSE events `step`, `status`, `end`; supports
  `Last-Event-ID`).
- Lists use keyset pagination: `?limit=&cursor=` -> `{items, nextCursor}`. Reads send weak ETags;
  send `If-None-Match` to get `304`.
- Errors: `{error: <stable code>, message, details?}`.
