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
| `OAX_SESSION_TTL_SECONDS` | `28800` | Lifetime of session tokens from login. |
| `OAX_TOKEN_MAX_TTL_DAYS` | `365` | Upper bound for API token lifetimes. |
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

The `container` runner is implemented and opt-in (see [runners.md](runners.md)); the `OAX_K8S_*`
variables are parsed and validated today so the Helm chart can expose them, the `kubernetes-job`
runner itself is feature-flagged off.

| Variable | Default | Meaning |
| --- | --- | --- |
| `OAX_RUNNERS_ENABLED` | `in-process` | Comma list of runners agents may use (`in-process`, `local`, `container`, `kubernetes-job`, `aws-lambda`, `github-actions`, `gitlab-ci`). Publishing an agent with another `runtime.runner` fails. |
| `OAX_CONTAINER_RUNNER_ENABLED` | `false` | Feature flag; required when `container` is listed in `OAX_RUNNERS_ENABLED`. With it on, `OAX_CONTAINER_ENGINE_URL`, `OAX_CONTAINER_IMAGE` (digest-pinned), `OAX_CONTAINER_NETWORK` (internal) and `OAX_NODE_CONTROL_URL` are required, otherwise the process refuses to start. |
| `OAX_CONTAINER_ENGINE` | `docker` | `docker` or `podman`. |
| `OAX_CONTAINER_ENGINE_URL` | – | `unix:///path/to/podman.sock` or a socket proxy `http://socket-proxy:2375`. The raw Docker socket is refused. |
| `OAX_CONTAINER_ALLOW_RAW_SOCKET` | `false` | Unsafe: allow `/var/run/docker.sock` (warning at start, audit `runner.unsafe_socket`). |
| `OAX_CONTAINER_IMAGE` | – | Run node image, `name@sha256:<digest>` only. |
| `OAX_CONTAINER_TOOLBOX_IMAGES` | `{}` | JSON map toolbox name -> digest-pinned image. |
| `OAX_CONTAINER_NETWORK` | – | Pre-created network with `internal: true` (verified before every start). |
| `OAX_CONTAINER_EGRESS_PROXY_LISTEN` / `OAX_CONTAINER_EGRESS_PROXY_URL` | – | Listen address of the worker's egress proxy (`0.0.0.0:3128`) and the URL nodes use; set both or neither. |
| `OAX_CONTAINER_MAX_CPUS` / `OAX_CONTAINER_MAX_MEMORY_MB` / `OAX_CONTAINER_MAX_PIDS` | `1` / `512` / `256` | Upper bounds for a node container. |
| `OAX_NODE_CONTROL_URL` | – | Control node base URL as seen from run nodes (internal network). |
| `OAX_K8S_JOB_ENABLED` | `false` | Feature flag; required when `kubernetes-job` is enabled. |
| `OAX_K8S_NAMESPACE` | `openagentix-runs` | Namespace for run Jobs. |
| `OAX_K8S_SERVICE_ACCOUNT` | `openagentix-worker` | ServiceAccount of run Jobs (annotate for IRSA on EKS). |
| `OAX_K8S_TTL_SECONDS_AFTER_FINISHED` | `600` | Job TTL. |
| `OAX_K8S_ACTIVE_DEADLINE_SECONDS` | `3600` | Job deadline. |
| `OAX_K8S_IMAGE_PULL_SECRETS` | – | Comma list of image pull secret names. |
| `OAX_K8S_NODE_SELECTOR` | `{}` | JSON node selector for run Pods. |
| `OAX_K8S_RESOURCES_CPU` / `OAX_K8S_RESOURCES_MEMORY` | `500m` / `512Mi` | Requests/limits of run Pods. |
| `OAX_K8S_EGRESS` | – | Comma list of allowed egress CIDRs/hosts (rendered into NetworkPolicies). |
| `OAX_TOOLBOX_REGISTRY` | `ghcr.io/open-agentix` | Registry of toolbox images. |
| `OAX_TOOLBOX_ALLOWLIST` | – | Comma list of toolbox names agents may declare (`runtime.toolbox`); empty = any catalog toolbox. Enforced at publish. |
| `OAX_TOOLBOX_REQUIRE_SIGNATURE` | `true` | Only run cosign-verified toolbox images (enforced by the v0.2 runners/admission policy). |

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
