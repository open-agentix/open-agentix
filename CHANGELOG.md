# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Tenant tree data model (W13-1 first slice, ADR 0013)**: migration `0013_tenant_hierarchy.sql`
  (PostgreSQL and PGlite) adds `parent_id`, `root_id`, a materialized `path` with prefix index and
  `depth` (technical maximum 32) to `tenants`; slugs are unique among siblings, root slugs stay
  globally unique, every existing tenant becomes a root and nothing is nested automatically. A guard
  trigger refuses inconsistent placements and cycles and freezes the placement until moves exist; a
  down script is documented. New `placeNode` and path helpers in `@openagentix/core`, a `TenantTree`
  repository (ancestors, descendants, subtree by one index lookup, slug paths) and
  `TenantsService.createChild` with `OAX_TENANT_MAX_DEPTH` (default 32) and
  `OAX_TENANT_MAX_NODES_PER_ROOT` (default 1000). No API change and no behaviour change for flat
  installs; sub-tenants are not creatable over HTTP yet. ADR 0013 is accepted.
- **Code quality reviewer example agent (NEW-51)**: `examples/agents/code-quality-reviewer.md`
  reviews a PR diff or repository path against the code quality guidelines (rule catalogue `QG-*` with
  severities, structured findings with `file:line`, Definition of done) and drafts a PR comment;
  read-only tools, one approved comment at most, no merge, 0.20 USD run budget. Guide with showcase
  setup (S-13) and golden-PR evaluation in `docs/examples-quality-agent.md`; a test validates every
  file in `examples/agents/`.
- **Outbound dispatcher factory with DNS pinning (W10-1-2 first slice, ADR 0011 amendment 3)**:
  `createOutboundDispatcher` in `@openagentix/providers` asks `resolveRoute` for every request and builds
  the undici dispatcher: direct with a pinned DNS lookup, or through the selected HTTP(S) proxy
  (CONNECT, `Proxy-Authorization` from the secret reference, proxy CA bundle); trust bundles
  (`system+extra` / `extra-only`) and client certificates come from the network configuration.
  Deny and veto results are `egress_denied` (with the resolver code), redirects are never followed,
  connect/header/body timeouts and a response size limit always apply, and every decision is exposed
  to `onRoute` without secrets. `createGuardedFetch` (OpenAI-compatible, Ollama, Anthropic, stream
  transports) and the Bedrock client now use the factory; providers, the registry and the stream
  factory accept an optional `outbound` (dispatcher, purpose, scope). A boundary test and ESLint
  rules fail when a new direct `fetch(`, `undici` or `node:http(s)` client appears outside the
  factory (exceptions are listed). New `RouteScope.allowPlainHttp` (platform only) keeps in-cluster
  `http://` model servers working until they are described by the network configuration.
- **Outbound network configuration and route resolver (W10-1-1, ADR 0011)**:
  `OAX_NETWORK_CONFIG_FILE` (YAML/JSON) or `OAX_NETWORK_CONFIG` (inline JSON) defines named proxies,
  trust bundles, client certificates, ordered routes and the proxies tenants may select. The pure
  `resolveRoute(url, purpose, scope, net)` in `@openagentix/core` decides direct, proxy or deny
  (precedence: connection selection, legacy `proxyUrl`, routes, `HTTP(S)_PROXY`/`NO_PROXY`, direct)
  and never touches the network. The api validates the file at start-up (including the air-gapped
  allowlist for proxy hosts and routes). The configuration is file/Helm only; there is no write API.
  Dispatchers and client migration follow in W10-1-2 and later.
- **Harness adapters through the model proxy (W1-3b-7, PLAT-04)**: `agents[].runtime.harness:
  claude-code | opencode` runs a step in a run node with the harness as executor. The harness reaches
  its model only through `/v1/model-proxy/anthropic|openai` with the step's model token and never
  holds a provider key or OAuth token. `POST /v1/worker/runs/{id}/model-token` accepts `harness` and
  answers with the pass-through surface. New `OAX_HARNESSES_ENABLED` (default empty, requires the model
  proxy). Cost is measured by the proxy; the harness report is stored in the `output` step. Publish
  checks: isolating runner, no `simulation`, enabled harness. Hardening: `assertProxyInvocation`
  guard, default 30-minute time limit, process-group kill. See ADR 0009 amendment W1-3b-7.
- Run node environment variables `OAX_CLAUDE_BIN`, `OAX_OPENCODE_BIN`, `OAX_OPENCODE_SHA256`
  (the images with pinned binaries are PLAT-05).

### Security

- Network configuration refuses plain `http://` proxies in production (`proxy_plain_http`), proxy
  URLs with credentials (use `authSecret` references), any key that would disable TLS verification
  and `NODE_TLS_REJECT_UNAUTHORIZED=0` (`tls_insecure`). Cloud metadata addresses and names are
  never routable, tenant destinations must be public, loopback never goes through a proxy, and
  proxies that inspect TLS cap the data classification.
- Hardening of the route resolver (security review): `OAX_NETWORK_PRIVATE_ALLOW` follows the same
  rules as the file and can no longer open loopback or the internet; `ldap(s)` hosts are
  canonicalised (`0xa9fea9fe`, `2852039166`, octal spellings) so the metadata and tenant checks
  apply; tenants may select only `tenantSelectableCertificates` and never override a route's client
  certificate; tenant `proxyUrl` hosts must be public (metadata and loopback refused, also
  grandfathered); `deny` routes veto regardless of order; LDAP is never sent through an HTTP proxy;
  plain `ldap://` is refused for `identity` and `mcp` is TLS-only for tenant destinations; 6to4,
  Teredo, site-local and local-use NAT64 addresses, `169.254.170.23` and `192.0.0.192` are
  classified; the config file is read from a regular file only, bounded through one descriptor;
  network configuration warnings are logged at start-up; the digest covers the environment proxies.
- **Harness review fixes (W1-3b-7)**: OpenCode substitutes `{env:...}` / `{file:...}` in the raw
  text of its config, so author strings could pull the model token or the run token file into the
  prompt. Such sequences are now refused in `provider`, `model` and the instructions of a harness
  step at validation, and escaped (`\u007b`) in every string written to the generated
  `opencode.json` (proxy and BYOK variants). The run token file is removed once read (best effort).
  Tokens are redacted in the recorded `call.args` of gate calls and in harness errors; stderr is
  redacted before it is truncated; a malformed model token response no longer surfaces a ZodError.
  The harness environment is an allowlist behind the proxy (loader, certificate and OpenCode/Claude
  config variables are refused for every harness), `ANTHROPIC_BASE_URL` must equal the proxy URL and
  the check runs on the environment actually passed to `spawn`. A harness run no longer hangs on a
  grandchild that keeps stdout open (`exit` is handled, the process group is always signalled).
  Model tokens carry a `surface` claim (`native` | `harness`) plus the harness kind: the native
  `/model` route refuses a harness token and the pass-through surfaces refuse a native one.

- Hardening of the dispatcher factory (security review of PR #133): a legacy `proxyUrl` of a platform
  connection is no longer pinned (a private proxy host works again); only tenant-chosen proxies are.
  Node agents (Bedrock) behind a proxy use a dedicated CONNECT agent: the proxy hop gets its own CA
  and never the client certificate, the destination gets the trust bundles and the client
  certificate, also in `extra-only` mode. `rejectUnauthorized: true` is set on every TLS option set
  and the factory refuses to run with `NODE_TLS_REJECT_UNAUTHORIZED=0`. `proxyUrlGrandfathered`
  comes from the connection metadata only, never from "a proxyUrl is set". Policy and configuration
  errors (`egress_denied`, `network_secret_unavailable`, `client_certificate_unknown`,
  `network_config_invalid`, `tls_insecure`), also behind undici's `fetch failed`, are never retried
  or wrapped into a retryable provider error. Tenant destinations behind a proxy are resolved once
  and checked before sending. The dispatcher cache is bounded (LRU, 64) and keyed by a digest of
  proxy credentials; invalid percent-encoding in proxy credentials fails with
  `network_config_invalid`; the size limit has its own code `response_too_large`; plain `http://`
  Bedrock endpoints now also go through the proxy.

### Changed

- Outbound routing of existing installs (dispatcher factory): loopback destinations are always
  direct (never sent to `HTTP(S)_PROXY`), cloud metadata addresses are denied, and an invalid
  `HTTPS_PROXY`/`HTTP_PROXY` value now fails with `network_config_invalid` instead of being ignored.
- Clients without their own network configuration share one factory per proxy environment.
- The response size limit error code is `response_too_large` (was `egress_denied`).

### Breaking

- **Network start-up checks (W10-1-1)**: the api now aborts start-up (`tls_insecure`) when
  `NODE_TLS_REJECT_UNAUTHORIZED=0` is set, air-gapped or not; add the CA to a trust bundle or
  `NODE_EXTRA_CA_CERTS` instead. `HTTPS_PROXY`/`HTTP_PROXY` values that are not an `http://` or
  `https://` URL abort start-up (`network_config_invalid`); a bare `host:port` is still accepted
  (read as `http://host:port`, with a warning), `socks5://` and other schemes are refused.
  `OAX_NETWORK_PRIVATE_ALLOW` and `privateAllow` now accept only IPs and CIDR ranges with a prefix
  of at least /8 that do not cover loopback, link-local, unspecified or multicast space; the
  allowlist grammar rejects `/0`, empty and non-numeric prefixes (`10.0.0.0/`); the deny code of a
  `deny` route is `egress_denied` (was `denied_by_route`).
- **Model proxy cutover (W1-3b-4)**: isolated run node steps now call models only through the
  model proxy. With `OAX_MODEL_PROXY_ENABLED=false` (the default) they fail with
  `model_proxy_unavailable`, the simulated provider included. Old `oax run-node` images report
  `model_call` steps themselves and now get `400 step_kind_refused`: roll out control node and node
  images together. As soon as any cost limit applies (run, step, team or monthly), a model without
  a price is rejected with `422 model_unpriced`.

### Security

- Price lookups resolve the fallback keys (catalog provider, adapter kind) against the platform
  table only; a tenant connection named like a catalog provider can no longer zero the price of
  another connection. Tenant overrides apply only under the connection name the agent uses.
- In-process reservations are settled only by the in-process call of the same agent; reservations
  of a proxied session are refused.

### Fixed

- In-process model errors release their reservation only for failures that provably did no work
  (egress refusal, DNS or refused connection, 4xx other than 408, 409 and 429); everything else
  expires at the reserved amount like the proxy does.
- The in-process provider call is bounded by the reservation deadline, and a late report for an
  already expired reservation is recorded as a `model.late_settlement` correction in the audit log
  instead of failing the run.
- A price lookup that fails during reservation or settlement is logged as a warning.

### Added

- **Model proxy pass-through surfaces (W1-3b-6)**: `POST /v1/model-proxy/anthropic/v1/messages`,
  `POST /v1/model-proxy/openai/v1/chat/completions` and the two `GET .../v1/models` routes speak the
  Anthropic and OpenAI protocols for harnesses, with JSON and Server-Sent Events. They open with the
  model token only (`x-api-key` or `Authorization: Bearer`), run through the same admission,
  reservation, settlement, cap, SSRF-pinning and revocation chain as the native route, and stop a
  stream mid-way (output over the reserved bound, revoked session, cancelled run, deadline, client
  disconnect) with the protocol's own error event. Requests are parsed with a strict allowlist and
  the upstream body is rebuilt; every relayed event is rebuilt from allowlisted fields; client
  credentials and headers are never forwarded (new `OAX_MODEL_PROXY_ANTHROPIC_BETAS` allowlist for
  `anthropic-beta`). `count_tokens` and `GET models/{id}` are not served yet. Requests with
  `cache_control` are reserved at the cache-write rate and `ttl: "1h"` is refused; client-visible
  events carry the step's model, an own id and capped usage; oversized upstream strings end the
  stream with an error instead of being blanked; a thinking budget under 1024 after the output
  clamp is omitted; the token is checked before the body is validated.
- **Run node and executor on the model proxy (W1-3b-4)**: `oax run-node` sends every model call of
  its step through the control node's model proxy (`ModelProxyProvider`, a metered provider, the
  simulated provider included; `ModelProxyUnavailableProvider` is gone), the executor records no
  cost or `model_call` step for metered providers, and refusals of the proxy keep their code in the
  run's failure. In-process steps now reserve their worst case before each call
  (`ControlPlane.reserveModelCall`, new `POST /v1/worker/runs/{id}/model-reservations` for
  orchestrator tokens) and the control node settles the reservation from the usage (`reservationId`
  on the `model_call` step), so run, step and monthly budgets hold across concurrent calls. The
  dispatcher takes the cost and tokens of an isolated step from the run's ledger counters, so
  isolated steps count against `maxCostUsd`, `maxTokens` and the monthly budgets. Reservation and
  settlement use the run's prices including BYOK connection overrides and the connection's catalog
  provider. ADR 0009 amendment W1-3b-4.

- **Model proxy: native endpoint and model token (W1-3b-3, opt-in `OAX_MODEL_PROXY_ENABLED`)**: the
  control node serves `POST /v1/worker/runs/{id}/model-token` (a step-scoped, session-bound,
  once-per-step model token `oaxmt.`, stored as `run_node_sessions.model_token_jti`) and
  `POST /v1/worker/runs/{id}/model` (JSON, or Server-Sent Events with `Accept: text/event-stream`)
  with the pre-call chain of ADR 0009: token and session binding, model allowlist of the published
  step (provider and model cannot be chosen by the caller), data classification, air-gapped egress,
  BYOK key resolution on the control node (the key never leaves it and is scrubbed from provider
  errors), strict re-serialised request validation (no server tools, `mcp_servers`, URL sources,
  file ids, duplicate or prototype keys), a worst-case budget reservation, and settlement from the
  usage the control node measured. Streaming goes through the upstream transports of W1-3b-5 with a
  hard stop on revoked sessions, cancelled runs, deadlines, client disconnects and output beyond the
  reservation (bound + 10 %). Stable error codes, `model_token.issued` / `model.denied` /
  `model.aborted` audit entries, `oax_model_proxy_*` metrics and the `OAX_MODEL_PROXY_*`
  configuration block (limits are bound to the accounting service and the stream transports).
  New route access kind `model-token`. `ModelAccountingService.settle` now scrubs step payloads
  before it opens its transaction. Not yet wired to the run node (W1-3b-4); the Anthropic and OpenAI
  pass-through surfaces follow (W1-3b-6). Provider calls of the proxy never retry (a retry would be a
  second billed call), the HTTP timeout follows the call deadline, everything that may have been
  billed is charged, JSON answers use the stream limits, reported usage is capped by the
  reservation, and tenant-controlled endpoints cannot reach private or metadata addresses
  (`OAX_MODEL_PROXY_PRIVATE_ALLOW`); this also covers NAT64, 6to4 and IPv4-compatible forms, refuses
  names that cannot be resolved, validates and pins the address at connect time (also for custom
  Bedrock endpoints, whose responses are size-bounded), refuses calls of a run or step whose time is
  exhausted and caps estimate-mode usage at the input upper bound. `docs/runners.md`, `docs/configuration.md`.
- **Streaming upstream transports for the model proxy (W1-3b-5)**: `@openagentix/providers` gets a
  streaming API next to `complete`: `AnthropicStreamTransport`, `BedrockStreamTransport`
  (`InvokeModelWithResponseStream`) and `OpenAIStreamTransport` (OpenAI, Azure, OpenRouter, vLLM,
  LM Studio, Ollama `/v1`, compatible; forces `include_usage`). Robust SSE parser (partial frames,
  split UTF-8, line/event/total size limits), pull-based events with backpressure, abort via
  `AbortSignal` that closes the upstream socket, a `shouldStop` hook for the mid-stream hard stop,
  time-to-first-event, between-event idle and deadline timeouts, retries only before the first byte,
  and a usage meter (provider usage incl. cache tokens, estimate and floor, `usageReported` flag for
  the estimator fallback). No bodies in logs, secrets scrubbed from errors. Not yet wired to a route
  (W1-3b-6). `docs/providers.md`.
- **Run node, per-step credential broker and container runner (W1-3a, opt-in)**: steps whose effective
  runner is `container` (pipeline `runtime.runner` or per-step `runtime.runner`) run in their own
  short-lived container, started by the worker through a socket proxy or rootless Podman: digest-pinned
  image, numeric non-root user, read-only root filesystem, all capabilities dropped,
  `no-new-privileges`, CPU/memory/PID limits, tmpfs, an `internal` network (verified before every
  start), no engine socket inside, never started through the raw Docker socket unless explicitly
  allowed. The step-scoped run token (claims `sid`, `steps`) reaches the node through its stdin, never
  through the environment. The new run node (`apps/worker/src/run-node.ts`, entry `run-node-cli.js`, image target
  `run-node`) talks to the control node only and never to PostgreSQL. The credential broker
  (`POST /v1/worker/runs/{id}/credentials`) hands out exactly the step's secrets once per step and
  session, only for references the tenant allows (`tenants.secret_refs`, empty = nothing, migration
  `0009`; `PATCH /v1/tenants/{id}` `secretRefs`), audited as `runnode.started`, `credential.issued`,
  `credential.denied`, `credential.revoked`, `runnode.stopped`, `runner.unsafe_socket` without values.
  A revoked or expired session kills its token immediately (also when another worker takes the run
  over); node-reported cost and tokens are dropped, nodes may only report model/tool/output/error steps (marked `node:<id>`) and receive the remaining budget; a node token can never complete a run or
  act for another step. A separate egress proxy service (`CONNECT`, signed per-node grants, operator ceiling
  `OAX_CONTAINER_EGRESS_ALLOW`, private/metadata/loopback ranges closed, air-gapped policy on top)
  enforces `runtime.egress`. New `GET /v1/worker/runs/{id}/handover`,
  `POST .../handover/result`; Compose profile `container-runner`; `docs/runners.md`. **Not yet**: run
  nodes cannot call models except the keyless `simulated` provider until the model proxy (W1-3b).
- **Kubernetes Job runner (W1-4)**: `KubernetesJobRunner` implements the isolating-runner contract
  of ADR 0008: one suspended Job per step plus an owner-referenced deny-by-default NetworkPolicy
  (DNS, control node and egress CIDR allowlist) and a Secret holding only the run token, then
  unsuspend; everything is deleted on stop. Hardened Pods (non-root, read-only rootfs, drop ALL,
  seccomp RuntimeDefault, no ServiceAccount token, resource limits, `activeDeadlineSeconds`,
  `ttlSecondsAfterFinished`, no secrets in env), digest-pinned and allowlisted images only, minimal
  namespaced RBAC (`docs/examples/kubernetes-job-runner-rbac.yaml`), in-cluster API client without
  extra dependencies. Security-reviewed: operator egress is an upper bound (steps can only narrow,
  min prefix /8 and /32, IMDS/link-local/loopback and `OAX_K8S_DENY_CIDRS` excluded, no step egress
  when air-gapped), Foreground Job deletion with the NetworkPolicy removed last, a static
  default-deny policy, uid-tracked cleanup, UUID-only node ids, clamped resources with LimitRange
  and ResourceQuota, a dedicated step ServiceAccount (`openagentix-run-node`), fail-closed toolbox
  allowlist and an explicit admission-signature acknowledgement. The `kubernetes-job` `StubRunner` is gone. `docs/kubernetes-job-runner.md`.
- **Agent Check and Agent Plan v1 (advisory)**: strict `AgentPlan` schema, deterministic
  least-privilege lint `LP001`-`LP008` with a fixed JSON output, optional model-assisted notes that
  can only add `info`/`warning` findings (untrusted, schema-validated, costed and budget-checked),
  and a deterministic plan -> `agents.md` draft generator. `POST /v1/plans/check` and
  `POST /v1/plans/generate` (audited as `plan.checked`/`plan.generated`, rate limit
  `OAX_RATE_LIMIT_PLAN_MAX`), `oax plan check|generate`, an "Agent plans" page (en, de). Nothing is
  stored or published automatically. `docs/agent-check.md`.
- **agents.md data flow fields (parsed and validated, no runtime effect yet)**: `schemas`,
- **Guided demo tour**: in demo mode the UI offers an 8-step modal tour (welcome, scenarios, run
  view, audit chain, costs, agents/tenants/roles, connections and policies, links) with spotlight,
  progress dots, a "Don't show this again" checkbox (localStorage with a session/memory fallback),
  a "Take the tour" entry in the sidebar and a hint box with the shared fake credentials on the
  sign-in page (`VITE_OAX_DEMO=true` build argument). English and German, own lazy-loaded component,
  no third-party code or requests, no API change. `docs/demo.md` ("Guided tour").
- **Named read/write tool profiles per MCP connection**: an `mcp` connection declares
  `tools: { <name>: { access: read | write } }` and `profiles: { <name>: [tool, ...] }` (unknown tools
  in a profile are refused when it is saved). `agents[].tools[].profile` grants such a profile; it is
  expanded into concrete grants when a version is published and stored in the immutable version
  (`expansion`, `toolAccess`, `expansionDigest`), so later profile edits never widen a published
  version. A step with `access: read-only` can never receive a write tool: refused at publish and
  denied by the policy gate at run time (`profile_write_denied`). Expansion and refusals are audited
  (`agent.profiles.expanded`, `agent.publish.denied`). Connections page and agent overview show
  classes, profiles and where a grant came from. `docs/mcp.md`.
- **Typed handovers and conditional steps (W1-1)**: `output.schema` / `input.schema` are validated at
  runtime (ajv 8, strict, JSON Schema subset, size and depth limits) with `onInvalid: fail|retry`,
  `input.from` gives a step only the JSON it names, and `when` is evaluated by a strictly typed,
  non-`eval` evaluator (false skips the step, an error fails the run). New run steps `condition` and
  `handover` (status `skipped`), audit entries `step.skipped`, `condition.error`, `handover.invalid`,
  `handover.retry` (never with the offending values), error codes `handover_invalid`,
  `handover_missing`, `condition_error`. `examples/ticket-triage.agents.md`, `docs/pipelines.md`.
- **agents.md data flow fields (parsed and validated; `schemas`, `input`, `output` and `when` now run, see above)**: `schemas`,
  `agents[].input`/`output` (JSON Schema subset with size, depth and safe-regex limits), `when`
  (bounded expression grammar, parsed at publish), `access`, `tools[].profile`, `credentials`
  (secret references per step) and `runtime` per step. Existing files parse unchanged.
  [ADR 0008](docs/adr/0008-agents-md-data-flow-and-isolation-contract.md) fixes the contract for
  handovers, tool profiles, the credential broker, run nodes and Agent Plan v1;
  `docs/agents-md.md`.
- **Demo profile**: `docker-compose.demo.yml` is a standalone, working stack (api, worker, ui,
  postgres) with the simulated provider. Fixed demo scenarios (`GET /v1/demo/scenarios`,
  `POST /v1/demo/scenarios/{id}/run`), a dashboard card, per-visitor and daily limits and the optional
  `OAX_DEMO_LLM=claude-code` mode that runs scenarios through the Claude Code harness (no free-text
  prompts, no built-in or outbound tools, per-run and daily budget caps, token only as a read-only
  mounted file). `docs/demo.md`.
- **Claude Code harness**: the adapter now runs `claude -p` (stream-json, `--tools ""`, `dontAsk`,
  explicit allowlist, `--restricted`) in a temporary directory with a minimal environment. The policy
  gate is served as a loopback MCP bridge (`serveGateHttp`) so every tool call is policy-checked,
  approved, audited and costed; agent limits map to `--max-turns`/`--max-budget-usd` and are enforced
  by the platform. `oax run --harness claude-code`, opt-in real-run test (`OAX_TEST_CLAUDE=1`),
  `docs/harnesses.md`, `docs/verification/claude-code-harness.md`. Other harnesses stay documented stubs.
- **OpenCode harness**: `createHarness('opencode')` / `oax run --harness opencode` runs
  `opencode run --format json` non-interactively with a generated deny-by-default config whose only
  tool source is the loopback policy gate, a minimal environment inside the temporary work directory,
  the model taken from an existing model connection (BYOK secret references; the key reaches the CLI
  only through the child environment and is redacted everywhere), platform-side step, cost and time
  limits, an air-gapped egress check of the model endpoint and an optional binary checksum pin. Tested
  with a fake CLI; the opt-in real-run test (`OAX_TEST_OPENCODE=1`) and its verification note are
  pending a pinned binary. `docs/harnesses.md`. Hermes and OpenClaw stay documented stubs.
- **Air-gapped mode** (`OAX_AIRGAPPED`, `OAX_AIRGAPPED_ALLOW`): fail-closed start-up self-check,
  process-wide egress policy and network guard (TCP, DNS, UDP), vendored model catalog only,
  `airgapped` state on `/readyz`, tests proving no outbound traffic, and `docs/airgapped.md`.
- **Budgets with hard stop**: monthly budgets per tenant, use case and team, checked when a run is
  queued and before every step of a running run (also across runs of the same month). A reached
  budget blocks or stops the run (`blocked_by_policy` or `failed` with `control_budget_*`), writes
  `run.blocked` / `budget.blocked` audit entries and raises alerts at 50, 80 and 100 % as events
  (`io.openagentix.budget.alert`) plus `budget.alert` audit entries. New API: `GET /v1/budgets`,
  `PUT`/`DELETE /v1/budgets/use-cases/{useCase}`, worker route `GET /v1/worker/runs/{id}/budget`;
  costs page shows and manages the budgets; migration `0004` adds `use_case_budgets` and
  `budget_alerts`; `docs/budgets.md`.
- **Tenant isolation**: every request-facing query is filtered by the caller's tenant; other
  tenants' resources answer 404 (denied agent/run access is audited), names are unique per tenant,
  workers resolve tool servers per run and tenant, cross-tenant references are refused. Tenants API
  (`/v1/tenants`), platform operators (`users.platform_admin`, `X-OAX-Tenant`, `allTenants`),
  connection scopes (platform, tenant, team, agent), platform vs tenant policies, tenant partition
  key on audit entries, and `docs/tenancy.md` with isolation tests.

- **Every regular provider as a model connection** (BYOK): Claude API (Anthropic), AWS Bedrock
  (default chain or key references), OpenAI (GPT), Azure OpenAI, OpenRouter, vLLM, LM Studio, Ollama
  and any OpenAI-compatible server. Connections of kind `model` hold secret references scoped to
  platform, tenant, team or agent (most specific wins), resolve per run, can be tested
  (`POST /v1/connections/{id}/test`) and fail with the real reason when broken. Pasted API keys are
  refused; tenant connections must use the tenant's secret namespace.
- **Model catalog from a pinned models.dev snapshot** (726 models, MIT, provenance with SHA-256),
  local models in `local.json`, `GET /v1/models?provider=&q=`, `POST /v1/models/proposals` and price
  proposals when a connection is created (explicit prices stay as overrides), Bedrock inference
  profile pricing, import script with a field whitelist and a weekly reviewed refresh PR job
  (`.github/workflows/catalog-refresh.yml`). Docs: `docs/providers.md`.
- UI: model connections with provider presets, scope and catalog price proposals.
- **Model proxy foundations (W1-3b-1, ADR 0009)**: model token (`oaxmt.`, HMAC key derived from the
  run token secret with the label `openagentix/model-token/v1`, bound to run, session, node and
  step, expiring, constant-time verification; cannot verify as a run token and vice versa),
  strict wire schemas of the native model endpoint (`WorkerModelRequest`, `WorkerModelResponse`,
  `ModelTokenResponse`, error envelope and code table), pure token estimators
  (`estimateInputUpperBound`, `estimateOutputTokens`, `outputFloor`) and prompt cache prices in
  the cost model (`cacheReadPerMTok`, `cacheWritePerMTok`; fallback input and 1.25 x input). No
  endpoint or behaviour change yet.

- **Model call accounting (W1-3b-2)**: `ModelAccountingService` reserves the worst-case cost of a model
  call before it is made and settles the measured cost afterwards (ADR 0009 section 4). A reservation
  is checked against the run and step budgets (cost, tokens, model calls), the monthly tenant, use case
  and team budgets and the concurrency limits in one transaction under a per-tenant advisory lock, so
  concurrent calls cannot overshoot a limit. Settlement writes the `model_call` step, the ledger line,
  run counters, budget alerts and audit entries atomically and is idempotent; a missing or implausible
  usage report falls back to the estimate and a lower bound (`usage_source` `estimated` / `floor`), an
  overdue reservation is charged at the reserved amount (`model.reservation_expired`, worker reaper),
  and a model without a price is refused (`model_unpriced`) whenever a cost limit applies. Cache tokens
  are priced separately (cache read as input and cache write as 1.25 x input unless the price entry
  names them). Migration `0010` adds `model_reservations`, the ledger columns `usage_source`,
  `cache_read_tokens`, `cache_write_tokens`, `reservation_id`, `via` and `run_node_sessions.model_token_jti`;
  all money is integer micro-USD. **Not yet wired**: the model proxy and the executor call the service
  with W1-3b-3 and W1-3b-4, so the budgets documented in `docs/budgets.md` still check after a call until then.

### Changed

- A model call is refused before it is made when its worst case does not fit a run, step or monthly
  budget (it used to be checked only after the call); an in-process step without `maxTokensPerCall`
  is capped at 4096 output tokens when the control plane reserves. A run node can no longer report
  `model_call` steps (`400 step_kind_refused`); the proxy records them. **Breaking for custom
  workers** that post `model_call` steps from a node token.

- **UI navigation**: the governance group (policies, audit trail, users & teams, API tokens) is now
  labelled "Governance" in English (was "Govern") and German (was "Steuern"); the key
  `nav.groups.govern` is unchanged.
- **Breaking (pre-1.0)**: MCP connection secrets of in-process runs are resolved through the tenant
  allowlist `tenants.secret_refs` (empty by default, canonical comparison); set it for tenants whose
  connections use secrets. Tenant slugs that overlap in canonical form (`acme`, `acme-corp`) cannot
  be created together, and the tenant prefix check of connection secrets is canonical.
- A step whose effective runner is isolating is never executed inline by the worker: without an
  enabled runner the run fails with `runner_unavailable`. The `container` runner is no longer a stub;
  publishing also refuses per-step runners that are not enabled.
- The tenant limit `tenants.monthly_budget_micros`, stored but not enforced before, is now a hard
  stop. Runs refused at admission by a tenant or use case budget carry the error codes
  `tenant_budget_exceeded` and `use_case_budget_exceeded` (team budgets keep
  `team_budget_exceeded`).
- **Breaking (API/DB, pre-1.0)**: `Principal` carries `tenantId` and `platformAdmin`; migration
  `0003` makes names unique per tenant, adds `users.tenant_id`, `users.platform_admin` and
  `policies.scope`, and marks existing `admin` users as platform operators.

### Fixed

- `docker-compose.yml`: the `volumes:` section contained a copy of the `ui` service and a dangling
  `ollama:` key; it now declares `pgdata` and `ollama`.
- **Release workflow**: the api image is built for linux/amd64 only; the QEMU arm64 build exceeded the 60 minute job timeout and the api image was never published (worker and ui keep amd64 and arm64).

- **Costs page "request validation failed"**: `GET /v1/costs/summary` and `/v1/costs/export` now accept
  `from`/`to` as a date (`YYYY-MM-DD`) or a full ISO 8601 timestamp and round it down to the first
  day of its month (UTC); the UI sends plain `YYYY-MM-DD` dates (local calendar, no timezone shift on
  the first of the month). Affects "This month", "Last 30 days" and the dashboard spend tile.
- **Audit "Verify hash chain" showed head #0 with an all-zero hash for tenants**: the tenant-scoped
  result now reports the tenant's own latest entry (real sequence number and hash) instead of a
  placeholder; the UI no longer prints a head for an empty trail.
- **UI unknown routes**: signed-out visitors opening an unknown path are redirected to `/login` instead of seeing the "Page not found" page; signed-in users still get the not-found page.
- **Database password override**: `OAX_DATABASE_PASSWORD` / `PGPASSWORD` were ignored with pg 8.23 when the connection string contained no password (SCRAM error "client password must be a string"); the password is now injected into the connection string (URL-encoded).

## [0.1.0] - 2026-10-04

First release of the openagentix platform (control node, worker, packages).

### Added

- **core**: `agents.md` parser and validator (YAML front matter + markdown sections, pipelines of
  1..n agents, budgets, tool allowlists with argument constraints, approvals, data classification,
  runtime/toolbox); immutable published versions (SemVer, digest); deterministic policy engine
  (audit agent); control agent guardrails (budgets, timeout, rate, loops, error streaks, policy
  denials, forbidden actions, provider clearance, optional stricter reviewer); SHA-256 audit hash
  chain with Ed25519-signed checkpoints and verification; cost model in micro-USD with a
  configurable price table; secret redaction; RBAC roles and team-scoped permissions; secret
  references; signed run tokens; CloudEvents 1.0 envelope and run state machine.
- **providers**: one provider interface with adapters for OpenAI-compatible APIs (OpenAI, Azure,
  vLLM, LM Studio), Ollama, AWS Bedrock (Converse, VPC endpoint, HTTPS proxy, default credential
  chain/IRSA), Anthropic (official SDK) and a deterministic `simulated` provider; egress guard
  that only allows configured endpoints.
- **events**: HMAC-SHA256 webhooks (`oax-v1` and GitHub schemes) with timestamp and replay
  protection, mail-in normalisation, Kafka consumer source (SASL/TLS, CloudEvents binary and
  structured mode), cron source.
- **mcp**: MCP client gateway (official SDK, stdio / streamable HTTP / in-memory) with per-agent
  allowlists, policy gate, timeouts and result size limits; policy gate exposed as an MCP proxy for
  external harnesses; deterministic demo servers (`cve-db`, `tickets`).
- **runners**: runner contract and shared step executor; `in-process` and `local` runners;
  `oax` CLI (`run`, `validate`); HTTP control plane client for remote worker nodes; typed stubs for
  container, Kubernetes Job, AWS Lambda, GitHub Actions and GitLab CI runners; external harness
  adapters (Claude Code invocation builder; OpenCode, Hermes, OpenClaw stubs).
- **api**: Fastify 5 control node with zod schemas and a committed OpenAPI 3.1 document;
  PostgreSQL via Drizzle with migrations, hot-path indexes and append-only triggers; endpoints for
  agents, event sources and ingest, events, runs (steps, SSE stream, cancel), approvals,
  connections, policies (incl. dry-run), audit (list, verify, export, checkpoints), costs, users,
  teams, API tokens, settings and worker run-token endpoints; OIDC (PKCE), LDAP/AD with group to
  role mapping, local bootstrap admin, scoped hashed API tokens; per-route access declarations
  enforced at start-up and in tests; rate limiting, security headers, CORS, compression, ETags;
  Prometheus metrics, OpenTelemetry hooks, pino logs with run-id correlation; LRU/Valkey cache
  layer; keyset pagination and prepared statements on hot paths.
- **worker**: Postgres `FOR UPDATE SKIP LOCKED` queue with leases, heartbeats and retries,
  configurable concurrency, approval waits, cancellation, cron scheduler with cluster-wide
  de-duplication and Kafka sources.
- **Operations**: standalone database settings (`OAX_DATABASE_URL` or `PG*` variables, separate
  `OAX_DATABASE_PASSWORD`), migrations under a Postgres advisory lock with wait-for-DB backoff,
  `/readyz` reports schema status, migration job needs only DB settings; worker HTTP server with
  `/healthz`, `/readyz`, `/metrics`; explicit `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` support for
  providers, AWS SDK, OIDC and MCP over HTTP; env contract for the v0.2 Kubernetes Job runner and
  toolbox allowlist (feature-flagged off, enforced at publish); release workflow publishing signed
  multi-arch images with SBOM attestations.
- **API for the UI**: stream tokens for EventSource, documented SSE/NDJSON media types, standard
  401/403/404 responses and OIDC redirects in OpenAPI, `GET /v1/auth/methods`, OIDC expiry in the
  UI redirect, role permissions in settings, step kind/status enums, agent/pipeline/team names in
  runs, approvals and costs, run time filters and `GET /v1/stats/runs`, `runId` filter for
  approvals, parsed definition from validation, dry runs of drafts with the simulated provider,
  cron event sources, source deletion, user detail, team members, team update and deletion,
  agent search.
- **Concept v2 foundations**: data model with tenants (`tenant_id` on agents, runs, events,
  approvals, connections, policies, costs, audit partition key), agent-scoped role bindings
  (hidden agents return 404, denials audited), cost lines with tenant/use case/run/step and CSV/JSON
  export, deterministic change gate for schedule sources (HTTP/file probes, audited, no tokens),
  pinned model catalog snapshot (models.dev schema) with local overrides and `GET /v1/models`,
  versioned development guidelines (global -> tenant -> agent, stricter wins) enforced by the
  policy gate and a hardening review endpoint, opt-in `dark-factory` agent mode with a fixed
  "prototypes and proofs of concept only" notice.
- **Public demo**: deterministic demo seed (`pnpm seed:demo`, `OAX_DEMO_MODE=true`) with two
  tenants, users for all six roles, six agents, runs, approvals, costs and a verifiable audit chain;
  read-only API in demo mode; compose demo profile.
- Examples `cve-triage` and `ticket-updater` with an end-to-end integration test; Dockerfile
  (api/worker targets, non-root, read-only rootfs friendly), docker compose stack, demo script,
  toolbox catalog skeleton, ADRs 0001-0006, configuration contract, performance baseline, CI with
  coverage gate and SHA-pinned actions, Dependabot, community files.

### Added (web UI)

- Web UI of the control node (`apps/ui`): React 19, Vite, TanStack Router/Query, typed API client
  generated from `openapi.yaml` (`pnpm gen:api`).
- Sign-in with OIDC (redirect), LDAP and local accounts; session expiry handling.
- Dashboard: runs today, success/failure, costs this month vs. team budgets, pending approvals,
  active policies, recent audit events, runners and providers.
- Agents: list, overview with runtime/toolbox/tools, `agents.md` editor with live validation,
  optimistic draft saves, version history, diff between versions, publish with confirmation,
  test runs with an example event.
- Workflow wizard for business users ("when … / check, do … / reply as …") that creates a draft
  `agents.md` for review and shows who must approve.
- Events & sources (webhook URLs, HMAC secret references, Kafka topics, cron schedules, mail-in,
  recent events), runs (filters, keyset pagination, virtualised table), live run detail over SSE
  with audit-gate decisions, costs, tokens, approvals and cancel.
- Connections (secrets by reference only), policies (bundles, audit-gate tester, budgets), audit
  trail (search, hash-chain verification, NDJSON export, checkpoints), costs, users/teams/RBAC
  matrix, API tokens, settings (providers, runners, Bedrock VPC endpoint/proxy configuration).
- English and German, light/dark theme, responsive layout, axe checks in tests, coverage gate
  80 %, bundle budget (initial JS < 200 KB gzip) and a third-party request scan of `dist/`.

[Unreleased]: https://github.com/open-agentix/open-agentix/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/open-agentix/open-agentix/releases/tag/v0.1.0
