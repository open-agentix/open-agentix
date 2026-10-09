# ADR 0009: Model proxy on the control node

- Status: Proposed
- Date: 2026-10-04
- Plan item: W1-3b ([implementation plan](../IMPLEMENTATION-PLAN.md)), the second half of W1-3
  (issue #10; W1-3a is PR #76: run node, credential broker, container runner)
- Builds on: [ADR 0003](0003-policy-engine-audit-and-control-agents.md),
  [ADR 0004](0004-provider-abstraction.md),
  [ADR 0005](0005-runners-and-external-harnesses.md),
  [ADR 0006](0006-control-node-and-worker-nodes.md),
  [ADR 0007](0007-tenants-as-isolation-boundary.md),
  [ADR 0008](0008-agents-md-data-flow-and-isolation-contract.md)
- Amends: ADR 0008 section 3.4 (model calls from run nodes; harnesses inside run nodes) and
  section 1.5 (adds `agents[].runtime.harness`); adds migration `0010` to the table of section 5.

## Context

W1-3a (PR #76) isolates a step in a short-lived run node (container now, Kubernetes Job with W1-4).
The node talks only to the control node with a step-scoped run token (claims `runId`, `workerId`
= node id, `sid`, `steps`), fetches its handover and its credentials once, and posts its result.
Two gaps are left open on purpose and documented in `docs/runners.md` ("Not in this version"):

1. **No model access.** A node can only use the keyless `simulated` provider. Every other provider
   resolves to `ModelProxyUnavailableProvider` (`packages/runners/src/model-proxy.ts`) and fails
   the step with `model_proxy_unavailable`. Provider keys (environment providers and BYOK model
   connections) are platform secrets and the credential broker refuses them
   (`credential.denied`, reason `platform_secret`).
2. **No trustworthy cost.** A node's own token and cost numbers are dropped
   (`ControlPlaneService.sanitizeNodeStep`, `NodeDispatcher`), so isolated steps do not count
   against `maxCostUsd` / `maxTokens` or the monthly budgets. That is acceptable only because
   nothing paid is reachable from a node today.

Related facts on `main` that shape the design:

- `ModelProvider.complete(ChatRequest) -> ChatResponse` is the only provider interface
  (`packages/providers/src/types.ts`); every adapter is **non-streaming** (OpenAI-compatible
  incl. Azure/OpenRouter/vLLM/LM Studio, Ollama `/api/chat`, Anthropic Messages, Bedrock Converse,
  simulated).
- Providers resolve per run: `ModelsService.registryFor(scope)` = platform providers
  (`OAX_PROVIDERS`) overlaid by the tenant's `model` connections, most specific scope wins
  (agent, team, tenant, platform). Keys are secret references resolved on the control node.
- Cost: `CostModel.modelCall(provider, model, usage)` in integer micro-USD; an unpriced model costs
  `0` and is flagged `priced: false`. `Usage` has input and output tokens only (no cache tokens).
- Budgets: per run and per step (`budget` / `agents[].budget`: tokens, USD, steps, tool calls,
  timeout) are enforced by the control agent **after** each call; monthly tenant, use case and team
  budgets are checked before every model call against the cost ledger (`BudgetsService`). Both are
  post-hoc: `docs/budgets.md` says one call, or a burst of concurrent runs, can overshoot.
- The cost ledger, run counters, budget alerts and the `step.model_call` audit entry are all
  written in one place: `ControlPlaneService.recordStep` (trusted path).
- Air-gapped mode: a process-wide egress policy and a network guard on the control node; provider
  endpoints must be on `OAX_AIRGAPPED_ALLOW`.
- Harnesses: Claude Code (`claude -p`) and OpenCode (`opencode run`) run as child processes of the
  orchestrator, today only from the CLI (`oax run --harness`) and the demo. Claude Code
  authenticates with an OAuth token file (`CLAUDE_CODE_OAUTH_TOKEN`) and reports its own cost;
  OpenCode receives a BYOK key in its environment and reports its own cost. Neither cost is
  measured by the platform.

## Decision

The control node gets a **model proxy**. A run node never holds a provider key and never talks to
a model endpoint; it calls the proxy with a step-scoped token. The proxy authorises the call
against the run's published definition, reserves the worst-case cost against every applicable
budget, forwards the call with the key resolved on the control node, meters the tokens itself,
and settles the cost in the ledger. Every rule below fails closed.

### 1. Threat model and trust boundaries

```text
 untrusted                         |  trusted (control node)                  |  external
                                   |                                          |
 run node (container / Job)        |  api: model proxy routes                 |  provider endpoint
  - step executor                  |   auth -> admission -> reserve           |  (Anthropic, Bedrock,
  - MCP tools, toolbox binaries ---+-> forward (key added here) -------------+-> OpenAI, Azure,
  - harness child (claude/opencode)|   meter stream -> settle (ledger, audit) |   OpenRouter, vLLM,
    holds ONLY a model token       |  PostgreSQL: reservations, ledger, audit |   Ollama, ...)
                                   |  orchestrator (worker): revokes sessions |
```

- **Boundary B1, node -> proxy**: everything in the request is attacker-controlled (a tool, a
  prompt injection or a compromised toolbox can own the node). The proxy trusts only the token
  claims and what it reads from its own database (run, session, published definition, budgets,
  connections).
- **Boundary B2, proxy -> provider**: the proxy builds a new upstream request; nothing from the
  node's HTTP request (headers, raw bytes, URLs) is forwarded.
- **Boundary B3, provider -> proxy -> node**: provider responses are untrusted data too (a BYOK
  endpoint is controlled by the tenant; responses may be huge, malformed or report wrong usage).
- **Assets**: provider keys and BYOK secrets; money (budgets, ledger integrity); other runs' and
  other tenants' data and budgets; prompt/response content (may be classified); availability of
  the control node; the audit hash chain.
- **Actors**: (A1) a compromised run node or harness child; (A2) a tenant user who publishes
  agents.md or configures a BYOK endpoint; (A3) another tenant; (A4) a party on the node network
  (sniffing or replaying tokens; mTLS is W2-2); (A5) a misbehaving or malicious provider endpoint;
  (A6) an operator misconfiguration.

| # | Threat | Actor | Decision (section) |
| --- | --- | --- | --- |
| T1 | Read the provider key | A1 | Keys exist only in the proxy process; never in responses, errors, logs (2, 7) |
| T2 | Use the proxy as a free model gateway: other model, other provider, other run | A1 | Token binds run, session, step; model and provider pinned by the published version (3) |
| T3 | Overspend: huge `max_tokens`, many parallel calls, endless streams | A1, A2 | Reservation of the worst case before forwarding, forced `max_tokens`, concurrency and rate limits, mid-stream stop (4, 6) |
| T4 | Under-report usage | A1, A5 | Usage is measured by the proxy from the provider; node numbers are never used; estimate and floor when the provider is silent (4.2) |
| T5 | Server-side tools and URL fetches by the provider (web search, MCP connector, code execution, image/document URLs) that bypass the policy gate and node egress | A1 | Strict parameter allowlist; server tools, `mcp_servers`, URL sources and file ids refused (6.2) |
| T6 | Request smuggling / header injection into the upstream request | A1 | Parse with strict schemas, re-serialize, build headers from configuration only (6.1) |
| T7 | Token theft and replay (from the harness environment, logs, network) | A1, A4 | Model token is audience-bound, step-bound, short-lived, dies with the session; separate key and prefix from run tokens (2.2) |
| T8 | Cross-tenant access (connections, budgets, caches) | A1, A3 | Tenant comes from the run row only; per-run provider resolution; no response cache (6.5) |
| T9 | Prompt/response leakage through logs, audit, metrics | A1, A6 | Metadata-only capture by default, redaction, no bodies in logs (8) |
| T10 | Denial of service on the control node (slow streams, big bodies) | A1 | Size, time, concurrency limits; optional separate deployment (6.3, 11) |
| T11 | Classification bypass (restricted data to a public provider) | A2 | Clearance check on the proxy with the published classification (3) |
| T12 | Air-gap bypass | A2, A6 | Proxy asserts the egress policy for the upstream endpoint; nodes have no provider egress (9) |
| T13 | Malicious provider response (oversized, endless, wrong events) | A5 | Response size and time limits, event allowlist, re-serialization (6.4) |

Explicitly **not** prevented: a compromised node can send any data it legitimately holds (its
input, its credentials) to the model of its own step. That is the step's allowed data flow; the
classification check bounds where it can go. The model provider sees what the step sends; that is
inherent in using a hosted model.

### 2. API surface

All routes are served by the api (control node). Two surfaces exist: a **native** surface for the
openagentix step executor inside a run node, and **passthrough** surfaces that speak the Anthropic
Messages and OpenAI Chat Completions protocols for harnesses (Claude Code, OpenCode) inside a node.

#### 2.1 Endpoints

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `POST /v1/worker/runs/{id}/model` | step-scoped run token (`oaxrt.`, with `sid`) or model token | Native call: `WorkerModelRequest` -> `WorkerModelResponse`, non-streaming |
| `POST /v1/worker/runs/{id}/model-token` | step-scoped run token | Issue the model token for one step (once per step and session) |
| `POST /v1/model-proxy/anthropic/v1/messages` | model token (`x-api-key` or `Authorization: Bearer`) | Anthropic Messages, `stream: true` (SSE) or JSON |
| `POST /v1/model-proxy/anthropic/v1/messages/count_tokens` | model token | Token count of a request (no cost, rate limited) |
| `GET /v1/model-proxy/anthropic/v1/models` | model token | Lists exactly the step's model |
| `POST /v1/model-proxy/openai/v1/chat/completions` | model token (`Authorization: Bearer`) | OpenAI Chat Completions, `stream: true` (SSE) or JSON |
| `GET /v1/model-proxy/openai/v1/models` | model token | Lists exactly the step's model |

- Route declarations use a new access kind `model-token` (next to `run-token`); the route
  permission test that already enforces declarations for every route covers them.
- The whole feature is opt-in: `OAX_MODEL_PROXY_ENABLED=true` on the api. When it is off the
  routes answer `503 model_proxy_unavailable` and nodes behave as in W1-3a.
- The passthrough surfaces have no run id in the path; the run comes from the token. They are
  meant for the node network only; the Helm chart and the Compose file do not route
  `/v1/model-proxy/` and `/v1/worker/` through the public ingress by default (section 11).
- The trusted orchestrator does **not** use the proxy for in-process steps (it already holds the
  provider registry); it uses the same reservation and settlement service through the
  `ControlPlane` interface (section 4.4). The one exception is an in-process harness step with a
  model connection (section 10).

#### 2.2 Model token

- Format `oaxmt.<base64url(claims)>.<base64url(hmac)>`. Claims
  `{ v: 1, aud: "model", runId, sid, nodeId, agentId, jti, iat, exp }`; exactly one `agentId`.
- Key: `HMAC-SHA256(OAX_RUN_TOKEN_SECRET, "openagentix/model-token/v1")` (domain separation): a
  model token can never verify as a run token and the other way round; the prefixes differ too.
  Rotating the run token secret invalidates both.
- `exp <= session.expiresAt` and at most `OAX_RUN_TOKEN_TTL_SECONDS`.
- `POST /v1/worker/runs/{id}/model-token` with `{ agentId }`: the step must be in the token's
  `steps`, the session active, the run `running`, the agent's provider must resolve. Issued **once
  per step and session** (`409 model_token_already_issued`; a restarted node gets a new session),
  stored as `run_node_sessions.model_token_jti`. Response
  `{ token, expiresAt, protocol: "anthropic" | "openai" | "native", baseUrl, model }` with
  `Cache-Control: no-store`. Audit `model_token.issued { runId, nodeId, agentId, jti, expiresAt }`.
- Every call re-checks: signature, `exp`, `aud`, session not revoked and not expired, `jti` equals
  the session's `model_token_jti`, run `running`, `agentId` in the session's steps. Revoking the
  session (step end, cancel, timeout, lease loss) kills the token at once, including open streams
  (section 6.3).
- Why a second token instead of the run token: the harness child process needs a credential in
  its environment; the run token would also open the gate, approvals, credentials and handover
  endpoints. The model token opens model endpoints of one step only (least privilege, T7).

#### 2.3 Native request and response

```ts
// WorkerModelRequest (strict)
{
  agentId: string,
  request: {
    model: string,                 // must equal the published agent.model
    system?: string,
    messages: ChatMessage[],       // as packages/providers ChatMessage
    tools?: ToolSpec[],            // names ^[a-zA-Z0-9_-]{1,64}$
    maxTokens?: number,            // clamped by the proxy, never raised
    temperature?: number,
    hints?: { context?: object }   // simulated templates only; `simulation` is taken from the
                                   // published definition, never from the node
  }
}
// WorkerModelResponse
{
  callId: string,                  // reservation id, also in the audit entry
  response: ChatResponse,          // text, toolCalls, usage, stopReason, model
  usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
           source: "provider" | "estimated" | "floor" },
  costMicros: number, priced: boolean,
  remaining: { costMicros?: number, tokens?: number, modelCalls?: number }  // tightest scope
}
```

The node's executor uses `usage` and `remaining` for its local control decisions only; it does
not record a `model_call` step and does not compute cost (section 5).

#### 2.4 Passthrough requests

- **Anthropic surface** accepts provider kinds `anthropic`, `bedrock` (Anthropic model ids only;
  forwarded as `InvokeModel[WithResponseStream]` with the Anthropic body and
  `anthropic_version: "bedrock-2023-05-31"`) and `simulated` (synthesised protocol events).
- **OpenAI surface** accepts `openai`, `openai-compatible`, `azure-openai`, `openrouter`, `vllm`,
  `lmstudio`, `ollama` (its `/v1` endpoint) and `simulated`.
- A step whose provider does not fit the surface gets `400 model_surface_mismatch`. There is no
  cross-protocol translation in v0.2 (smaller parsing surface; open question 6). Bedrock
  non-Anthropic models are reachable through the native surface only.
- Parameters are an **allowlist** per surface (section 6.2); anything else is
  `400 model_parameter_refused` naming the parameter.

#### 2.5 Errors

Every refusal is fail closed: nothing is forwarded, no reservation stays open. Native and
`model-token` errors use the platform envelope `{ error: { code, message } }`; passthrough errors
use the protocol's envelope so that harnesses surface them (`{ type: "error", error: { type,
message } }` for Anthropic, `{ error: { message, type, code } }` for OpenAI) with the platform code
in `code` / the message prefix.

| HTTP | Code | When | Anthropic `type` |
| --- | --- | --- | --- |
| 400 | `model_request_invalid` | schema violation, limits (count, depth) | `invalid_request_error` |
| 400 | `model_parameter_refused` | parameter outside the allowlist, server tool, URL source, file id | `invalid_request_error` |
| 400 | `model_surface_mismatch` | provider does not speak this surface | `invalid_request_error` |
| 401 | `unauthenticated` | missing, malformed, expired token; wrong audience | `authentication_error` |
| 403 | `run_node_session_revoked` | session revoked or expired, run not running | `permission_error` |
| 403 | `model_not_allowed` | `model` differs from the published agent model; agent not in token | `permission_error` |
| 403 | `classification_denied` | definition classification above the provider clearance | `permission_error` |
| 403 | `egress_denied` | air-gapped mode and the provider endpoint is not allowlisted | `permission_error` |
| 403 | `security_override` | an emergency override blocks the provider or model (W2-3) | `permission_error` |
| 403 | `control_budget_tokens`, `control_budget_cost`, `control_budget_steps` | run or step budget cannot cover the reservation | `permission_error` |
| 403 | `control_budget_tenant`, `control_budget_use_case`, `control_budget_team` (`control_budget_agent` with W2-5) | monthly budget cannot cover the reservation (same codes as the existing mid-run stop) | `permission_error` |
| 409 | `model_token_already_issued` | second token request for the same step and session | - |
| 413 | `model_request_too_large` | body over `OAX_MODEL_PROXY_MAX_BODY_BYTES` | `request_too_large` |
| 422 | `model_unpriced` | a cost budget applies and the model has no price | `invalid_request_error` |
| 429 | `model_rate_limited` | concurrency or rate limit; `Retry-After` set | `rate_limit_error` |
| 502 | `provider_error` | upstream error (message truncated to 300 chars, scrubbed) | `api_error` |
| 503 | `model_proxy_unavailable` | proxy disabled, database or settlement unavailable | `overloaded_error` |
| 504 | `provider_timeout` | upstream exceeded the call deadline | `api_error` |

Budget refusals are `403`, not `429` or `402`: clients must not retry them. A budget refusal of a
node's call fails the step with the same code; the orchestrator turns it into the run's failure as
for in-process steps. Mid-stream failures
are sent as the protocol's error event (`event: error` for Anthropic; a final chunk with an `error`
object for OpenAI) followed by closing the stream.

### 3. Admission: what the proxy checks before a reservation

In this order, each a hard refusal (section 2.5):

1. Token valid (section 2.2), tenant taken from the run row.
2. Load the call context (cached per session for its lifetime, keyed by `sid`): the published
   definition and the step (`agents[]` entry), the run scope (tenant, team, agent, use case), the
   provider resolved through `ModelsService.registryFor(scope)` (BYOK scopes as today), the price
   entry, the effective step budget (`effectiveBudget(def.budget, agent.budget)`).
3. **Model allowlist**: `request.model` must equal the published `agent.model`; the provider is
   the published `agent.provider` and is never taken from the request. A version pins exactly one
   provider and model per step (fallback lists are W4-5 routing; open question 5).
4. **Classification**: `controller.checkDataFlow(definition.classification, provider.clearance)`
   on the control node (the node's view is irrelevant).
5. **Air-gapped / egress**: `getEgressPolicy().assert(endpoint)` for every endpoint of the provider
   (base URL, proxy URL) before any network activity; the process-wide network guard stays as the
   second line.
6. **Emergency overrides** (W2-3 once merged): targets `provider:<name>` and `model:<provider>/<id>`
   are checked first and never served from a stale cache.
7. **Cancellation**: the run's cancel flag.
8. **Request validation and normalisation** (section 6).
9. **Reservation** (section 4.3), which also enforces step-call counts and concurrency.

A refusal after step 1 writes the audit entry `model.denied { runId, nodeId, agentId, reason,
provider, model }` (no request content). Repeated identical denials of one session are written once
per minute with a counter, so a looping node cannot flood the audit chain.

### 4. Accounting

#### 4.1 Where tokens are counted

- **Authoritative source**: the provider-reported usage as received by the proxy (Anthropic
  `message_start.usage` and `message_delta.usage`; OpenAI final usage chunk, which the proxy
  forces with `stream_options: { include_usage: true }`; Bedrock `amazon-bedrock-invocationMetrics`;
  Ollama `prompt_eval_count`/`eval_count`; non-streaming `usage` objects). Never the node.
- **Cache tokens**: `cacheReadTokens` / `cacheWriteTokens` are recorded separately.
  `PriceEntry` gains optional `cacheReadPerMTok` and `cacheWritePerMTok` (the models.dev catalog
  carries both); without them cache reads are priced as input and cache writes as 1.25 x input.
- **Reasoning/thinking tokens** are output tokens (that is how providers bill them).
- **Fallback estimate** when the provider reports nothing (aborted stream, endpoint without usage):
  input = the reservation's input estimate; output = `ceil(utf8Bytes(streamed output) / 3)` plus
  tool-call argument bytes. Ledger `usage_source = 'estimated'`.
- **Floor** against an endpoint that reports implausibly low usage (A5): output tokens are at least
  `ceil(utf8Bytes(output) / 8)`; when the floor wins, `usage_source = 'floor'` and an audit entry
  `model.usage_floor` is written. Honest providers never hit the floor.
- **Crash recovery**: a reservation still active after its deadline is settled at the **reserved**
  amount (`usage_source = 'reservation'`, audit `model.reservation_expired`). Conservative by
  design: the provider may have billed.

#### 4.2 Unpriced models

When the model has no price (`priced: false`) and **any** cost limit applies to the call (run or
step `maxCostUsd`, or a monthly tenant/team/use case/agent budget), the call is refused with
`422 model_unpriced`. Without any cost limit the call proceeds, tokens are counted and the ledger
line is flagged unpriced (today's behaviour). Self-hosted endpoints get an explicit price of `0`
by configuration (`models[].inputPerMTok: 0`), as Ollama and simulated already have by default.

#### 4.3 Reservation and settlement (no overspend with concurrent calls)

Before forwarding, the proxy reserves the **worst-case** cost of the call; after the call it
settles the actual cost and releases the rest.

- **Input upper bound** (`OAX_MODEL_PROXY_RESERVATION=upper-bound`, the default): the UTF-8 byte
  length of all text the provider will tokenise (system, messages, tool names/descriptions/schemas,
  serialized tool calls and results) plus a fixed per-message and per-tool overhead plus a per-image
  constant from the catalog (fallback 6 000 tokens per image), clamped to the model's context
  window from the catalog. A byte-level BPE tokenizer never produces more tokens than bytes, so
  this is a true upper bound for text (assumption: the tokenizers of the configured model
  families are byte-level BPE; a connection can set `tokenBoundFactor` > 1 for a model where that
  does not hold, and W1-3b-1 verifies the bound with fixture tokenizers). Mode `estimate` (bytes / 3) reserves less and can overshoot; it is
  for operators who prefer fewer refusals near a limit.
- **Output bound**: the proxy always sets the provider's max-tokens parameter itself:
  `maxOutput = min(request.maxTokens ?? catalog default, agent.maxTokensPerCall, catalog output
  limit, tokens left in the tightest token budget minus the input bound, tokens the tightest cost
  budget can pay at the output price)`. If `maxOutput < OAX_MODEL_PROXY_MIN_OUTPUT_TOKENS`
  (default 256), the call is refused with the budget code of the tightest scope.
- `reservedMicros = price(inputBound, maxOutput)`; with `cache_control` blocks present the input
  part is priced at the cache-write rate (the higher one).
- **Reserve transaction** (one PostgreSQL transaction, `pg_advisory_xact_lock` on the tenant id
  so that concurrent reservations of one tenant are serialised; different tenants do not contend):
  - run: `runs.costMicros + active reservations of the run + reservedMicros <= maxCost`, same for
    tokens; step: ledger sum of the run and agent + active reservations of the agent, same rule;
  - model calls of the agent in this run (`run_steps` kind `model_call` + active reservations)
    `< maxSteps` of the step budget;
  - every monthly scope that applies (tenant, use case, team; agent with W2-5): ledger sum of the
    month + active reservations of that scope + `reservedMicros` must stay **below or at** the
    limit (a spend at or above the limit already blocks, as today);
  - concurrency: active reservations of the session `< OAX_MODEL_PROXY_MAX_CONCURRENT_PER_SESSION`
    (default 2) and of the tenant `< OAX_MODEL_PROXY_MAX_CONCURRENT_PER_TENANT` (default 16). The
    database is the counter, so the limits hold across api replicas;
  - insert `model_reservations` row (`status = 'active'`, `expires_at = now + call deadline + 60 s`).
- **Settle transaction**: one transaction writes the `model_call` step (trusted `recordStep` path:
  `run_steps`, run counters, `cost_ledger` with the new columns, budget alerts, audit entry) and
  sets the reservation to `settled` with the actual micros. A settlement that fails is retried; if
  it still fails, the reaper settles the reservation at the reserved amount (fail closed in money).
- **Release**: a call refused upstream with no tokens processed (4xx before generation) settles at
  `0` with `usage_source = 'provider'` and a `model_call` step with status `error`.
- **Guarantee**: with `upper-bound` mode, the sum of settled and reserved cost of every scope never
  exceeds its limit, regardless of concurrency, as long as the provider bills no more than the
  reservation. The documented "one call or a burst can overshoot" in `docs/budgets.md` no longer
  applies to model calls (it still applies to priced tool calls). A provider reporting more than
  the reservation (A5, or a catalog limit that is wrong) is charged what it reported and writes
  `model.overrun { callId, reservedMicros, actualMicros }`.
- **Lowered limits**: a budget lowered by an admin does not cancel granted reservations; they
  settle normally. New reservations see the new limit.

#### 4.4 Same accounting for every model call

The reservation and settlement service (`ModelAccountingService`, apps/api) is used by every model
call of the platform, not only by the proxy: the trusted in-process executor calls
`ControlPlane.reserveModelCall(runId, agentId, bound)` before `provider.complete` and passes the
`reservationId` with its `recordStep`. Remote trusted workers use the same through
`HttpControlPlane` (new worker route `POST /v1/worker/runs/{id}/model-reservations`, orchestrator
token only); the local CLI's control plane implements it as a no-op. The monthly-budget
`checkBudget` call before a model call stays as a fast pre-check.

#### 4.5 Ledger and data model (migration `0010_model_proxy.sql`)

- `model_reservations`: `id uuid pk`, `tenant_id`, `run_id`, `session_id null` (null for in-process),
  `agent_id`, `team_id null`, `use_case null`, `provider`, `model`, `reserved_micros bigint`,
  `reserved_input_tokens int`, `reserved_output_tokens int`, `status` (`active` | `settled` |
  `expired`), `actual_micros bigint null`, `created_at`, `expires_at`, `settled_at null`; indexes
  on `(tenant_id, status)`, `(run_id, status)`; partitioned by `tenant_id` like every table
  (ADR 0007).
- `cost_ledger` gains `usage_source text not null default 'provider'`, `cache_read_tokens int not
  null default 0`, `cache_write_tokens int not null default 0`, `reservation_id uuid null`,
  `via text not null default 'in-process'` (`in-process` | `proxy` | `harness-report`).
- `run_node_sessions` gains `model_token_jti text null`.
- Settled reservations older than 35 days are deleted by the existing reaper (the ledger keeps the
  money; the reservation is bookkeeping).

### 5. Run node changes

- `ModelProxyProvider` (packages/runners) replaces `ModelProxyUnavailableProvider` for **every**
  provider, the simulated one included, so tests and demos exercise the real path. It implements
  `ModelProvider` with `metered = true` and calls `POST /v1/worker/runs/{id}/model` through
  `HttpControlPlane`. A node-local simulated provider remains available only to unit tests
  (`localProviders` option), never in the run-node binary's default wiring.
- The executor treats a `metered` provider as authoritative: it does not compute cost, does not
  post a `model_call` step (the proxy recorded it), and feeds `usage`/`remaining` into its local
  control decisions (kill early instead of waiting for a refusal).
- `ControlPlaneService.sanitizeNodeStep` keeps dropping cost and tokens from node-posted steps
  (unchanged; defence in depth), and node-posted steps of kind `model_call` are refused
  (`400 step_kind_refused`), so a node cannot fake a model call record.
- `NodeDispatcher`: after a node step ends, the orchestrator re-reads `runs.tokensIn/tokensOut/
  costMicros` (written by the proxy) and updates its in-memory run metrics, so later in-process
  steps see the true remaining budget. The handover keeps carrying the remaining budget.

### 6. Request and response handling

#### 6.1 No smuggling

- Bodies are parsed with strict zod schemas per surface and **re-serialized** into a new upstream
  body. Raw bytes, client headers, query strings and URLs are never forwarded.
- Upstream headers are built from configuration only (`x-api-key`/`authorization`,
  `anthropic-version`, content type, configured `headers`/`headerSecrets`, Azure `api-key`). The
  only client header honoured is `anthropic-beta`, filtered against
  `OAX_MODEL_PROXY_ANTHROPIC_BETAS` (default empty). Hop-by-hop headers, `transfer-encoding`
  tricks and duplicate headers are handled by Fastify's parser; a body with both
  `content-length` and `transfer-encoding` is refused.
- JSON limits before schema validation: `OAX_MODEL_PROXY_MAX_BODY_BYTES` (default 8 MiB),
  depth 64, no duplicate keys, prototype keys (`__proto__`, `constructor`, `prototype`) refused.

#### 6.2 Parameter allowlists

| Surface | Allowed | Refused (examples) |
| --- | --- | --- |
| Anthropic | `model`, `system` (string or text blocks), `messages` (text, `image` with `source.type: base64`, `tool_use`, `tool_result`, `thinking`/`redacted_thinking` blocks), `tools` (custom tools only: `name`, `description`, `input_schema`, `cache_control`), `tool_choice`, `max_tokens`, `temperature`, `top_p`, `top_k`, `stop_sequences`, `stream`, `thinking` (`budget_tokens <= max_tokens`), `metadata` (dropped) | server tools (`web_search_*`, `web_fetch_*`, `code_execution_*`, `computer_*`, `bash_*`, `text_editor_*` typed tools), `mcp_servers`, `container`, `source.type: url` or `file`, `document` blocks with URL/file sources, `service_tier`, unknown keys |
| OpenAI | `model`, `messages` (system/developer/user/assistant/tool; `image_url` only as `data:` URI), `tools` (`type: function` only), `tool_choice`, `parallel_tool_calls`, `max_tokens`/`max_completion_tokens` (clamped), `temperature`, `top_p`, `stop`, `seed`, `response_format` (json schema at most 32 KiB), `stream`, `stream_options` (overwritten), `user` (dropped) | `n > 1`, `web_search_options`, `audio`, `modalities`, `prediction`, `logprobs`, `top_logprobs`, `logit_bias`, `service_tier`, `store`, `metadata`, http(s) image URLs, file ids, unknown keys |
| Native | as section 2.3 | everything else (strict schema) |

Limits (configurable): 500 messages, 128 tools, 64 KiB per tool schema, 20 images, 5 MiB per
image, 256 KiB per text block, stop sequences 4.

#### 6.3 Streams and the mid-stream hard stop

- Upstream streams are parsed event by event and **re-emitted** to the client after
  re-serialization; unknown event types are dropped and counted. Output tokens are metered while
  streaming (bytes of text, thinking and tool-input deltas).
- The upstream request is aborted (and the client stream closed with the protocol's error event)
  when:
  1. the metered output exceeds the reservation's output bound by more than 10 % (a provider that
     ignores `max_tokens`) -> code `control_budget_cost` / `control_budget_tokens`;
  2. the session is revoked or the run cancelled: the proxy polls the session row every
     `OAX_MODEL_PROXY_REVOCATION_POLL_MS` (default 2 000) while a stream is open, and subscribes to
     a Valkey channel `oax:session-revoked` when Valkey is configured (the orchestrator publishes on
     revocation) -> `run_node_session_revoked` / `cancelled`;
  3. the call deadline `min(OAX_MODEL_PROXY_MAX_CALL_SECONDS (600), remaining step timeout)`
     passes -> `provider_timeout`;
  4. the client disconnects -> no error event (no one listens);
  5. an emergency override for the provider/model appears (W2-3) -> `security_override`.
- Every abort settles with the provider usage received so far, completed by the estimate
  (section 4.1), and writes `model.aborted { callId, reason, outputTokensEstimated }`.
- Time to first byte limit `OAX_MODEL_PROXY_TTFB_SECONDS` (default 120) and idle timeout between
  events (60 s).

#### 6.4 Responses

- Non-streaming upstream responses are limited to `OAX_MODEL_PROXY_MAX_RESPONSE_BYTES` (default
  16 MiB), parsed, and re-serialized to the client.
- Error bodies from providers are reduced to status, type and a message truncated to 300 chars and
  scrubbed of every secret value the provider configuration resolved (key, header secrets).
- The native response adds `callId`, `usage`, `costMicros`, `remaining`; passthrough responses
  are protocol-shaped and carry `x-oax-call-id` and `x-oax-cost-micros` headers only.

#### 6.5 Tenant isolation

- The tenant, team, agent and use case come only from the run row of the token's `runId`.
- Provider instances are resolved per run scope (BYOK); HTTP keep-alive pools may be shared per
  upstream origin, keys are per request. There is no response cache and no prompt cache inside the
  proxy (provider-side prompt caching is per API key and therefore per connection).
- Concurrency and rate limits are per session and per tenant; one tenant's streams cannot use up
  another tenant's share beyond the global limit `OAX_MODEL_PROXY_MAX_STREAMS` (default 256).
- Rate limit: `OAX_MODEL_PROXY_CALLS_PER_MINUTE` per run (default 60), sliding window in Valkey
  when configured, else per replica (documented as weaker).

### 7. Secrets

- Provider keys are resolved on the control node per call context (as `ModelsService` does today)
  and never leave the proxy process: not in responses, errors, logs, audit payloads, metrics labels
  or spans. Every resolved value is registered with the redactor used for logs and step records.
- The credential broker keeps refusing provider and model-connection secrets (`platform_secret`).
- The model token is the only new credential a node receives; it is written into the harness
  child's environment (section 10) and scrubbed from everything the harness returns, like the
  OAuth token today.

### 8. Logging, capture and redaction

- **Default capture `metadata`** (`OAX_MODEL_PROXY_CAPTURE=metadata`): the `model_call` step stores
  what the in-process executor stores today (message count, tool names, the response text and tool
  calls, stop reason) after redaction and broker-value scrubbing; request messages are not stored.
  Audit payloads carry provider, model, token counts by kind, cost, `usageSource`, latency, stop
  reason, `callId`, `nodeId`, `via`, and `requestDigest` (SHA-256 of the canonical upstream body)
  so that a call can be correlated without storing its content.
- `OAX_MODEL_PROXY_CAPTURE=off`: the response text is not stored either (only metadata).
- `full` (stores the redacted request too) is **not** part of v0.2 (open question 4).
- Logs never contain bodies; pino redaction covers `authorization`, `x-api-key`, `api-key` and
  every configured header-secret name.

### 9. Air-gapped mode and egress

- Nodes never get egress to provider endpoints for model access; the model proxy is reached
  through `OAX_NODE_CONTROL_URL`, which is already their one exit. Publishing a step whose
  `runtime.egress` names a configured provider endpoint gives a warning (it is not a model path).
- In air-gapped mode the proxy refuses a provider whose endpoint is not on `OAX_AIRGAPPED_ALLOW`
  (`403 egress_denied`) before any connection; the network guard remains active. `simulated` and
  allowlisted private endpoints (vLLM, Ollama) work.
- Harnesses in proxied mode no longer need `api.anthropic.com` on the allowlist; the egress check
  moves to the provider endpoint the proxy uses (section 10).

### 10. Harnesses through the proxy (amends ADR 0008 section 3.4)

- New optional step field `agents[].runtime.harness: claude-code | opencode` (additive, amends
  ADR 0008 section 1.5). Publish checks: the harness is enabled on the control node
  (`OAX_HARNESSES_ENABLED`, default empty), the provider fits the harness's surface, and the step
  has no `simulation` that the harness cannot honour. Without the field nothing changes; the CLI
  keeps `oax run --harness`.
- **Inside a run node** (`runner: container | kubernetes-job` with a harness): the node requests a
  model token, starts the harness child with the proxy as its only model endpoint, and never
  receives a provider key or OAuth token.
  - Claude Code: `ANTHROPIC_BASE_URL=<control>/v1/model-proxy/anthropic`,
    `ANTHROPIC_AUTH_TOKEN=<model token>`, `ANTHROPIC_MODEL` and the default/small-fast model
    variables all set to `agent.model` (so background calls of the CLI do not ask for a model the
    allowlist refuses), `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, experimental betas disabled,
    no `CLAUDE_CODE_OAUTH_TOKEN`. The exact variable names are verified against the pinned CLI
    version in the implementing task.
  - OpenCode: the provider entry points to `<control>/v1/model-proxy/anthropic/v1`
    (`@ai-sdk/anthropic`) or `<control>/v1/model-proxy/openai/v1` (`@ai-sdk/openai-compatible`),
    `apiKey: "{env:OAX_OPENCODE_API_KEY}"` = model token, no header secrets. Through the proxy,
    `azure-openai` and `bedrock` (Anthropic models) connections become usable for OpenCode.
  - The harness's self-reported cost is stored in the step output for comparison only; the ledger
    uses the proxy's measurement (`via = 'proxy'`). `--max-budget-usd` stays as a secondary limit.
  - Harness binaries are part of dedicated run-node image targets (`run-node-claude-code`,
    `run-node-opencode`), pinned and checksummed at build time (W1-6 rule), selected by the runner
    from the step's harness; nothing is downloaded at run time.
- **In the orchestrator** (in-process harness step with a model connection): the worker creates a
  harness session (a `run_node_sessions` row with `node_id = orchestrator:<workerId>:<agentId>`),
  issues a model token for it and points the harness at the proxy on loopback or the internal API
  URL. Cost is measured, not reported.
- **OAuth subscription mode** (`CLAUDE_CODE_OAUTH_TOKEN`, used by the demo) is not proxied: it
  stays orchestrator-only, its cost stays harness-reported (`via = 'harness-report'`), and a run
  node never receives the OAuth token. Publishing a node step with a harness and no model connection
  fails (`harness_requires_model_connection`).

### 11. Deployment

- The proxy is part of the api process and image. A separate deployment of the same image with
  `OAX_ROLE=model-proxy` (only the model routes) is possible later without a contract change (open
  question 1).
- Compose (`container-runner` profile): no new service; `OAX_MODEL_PROXY_ENABLED=true` on the api;
  nodes already reach the api over the `nodes` network.
- Helm: run-pod NetworkPolicy already allows the control plane; the chart gets `modelProxy.enabled`
  and keeps `/v1/model-proxy/` and `/v1/worker/` off the public ingress unless
  `modelProxy.exposeOnIngress=true`; an internal Service for the api is the documented node target.
  Mirrored as an issue in open-agentix-helm.
- mTLS (W2-2) covers the proxy routes like every worker route.

### 12. Observability and audit

| Kind | Name | Notes |
| --- | --- | --- |
| Metric | `oax_model_proxy_requests_total{surface,provider,code}` | provider = instance name, no tenant label |
| Metric | `oax_model_proxy_tokens_total{direction,source}` | direction `input`/`output`/`cache_read`/`cache_write` |
| Metric | `oax_model_proxy_reserved_micros` (gauge), `oax_model_proxy_reservations_active` | |
| Metric | `oax_model_proxy_duration_seconds{phase}` | `ttfb`, `total` histograms |
| Metric | `oax_model_proxy_aborts_total{reason}`, `oax_model_proxy_streams_active` | |
| Span | `oax.model.call` | `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.*`, `oax.call_id`, `oax.run_id`; no content |
| Audit | `step.model_call` | written by settlement (existing action), payload extended (section 8) |
| Audit | `model_token.issued`, `model.denied`, `model.aborted`, `model.overrun`, `model.usage_floor`, `model.reservation_expired` | names and numbers only |

Existing `oax_cost_micros_total` keeps counting every ledger line.

### 13. Migration from the W1-3a state (PR #76)

| Area | W1-3a | W1-3b |
| --- | --- | --- |
| `packages/runners/src/model-proxy.ts` | interface + `ModelProxyUnavailableProvider` | `ModelProxyProvider`; placeholder deleted; `model_proxy_unavailable` only when the proxy is disabled |
| `apps/worker/src/run-node.ts` | local simulated provider only | proxy provider for every provider; model token for harness steps; harness child wiring |
| `packages/runners/src/executor.ts` | cost from `CostModel` | `metered` providers skip cost and `model_call` records; in-process path reserves through `ControlPlane.reserveModelCall` (append-only seam, ADR 0008 ownership rules) |
| `apps/worker/src/node-dispatcher.ts` | ignores node cost | re-reads authoritative run counters after each node step |
| `apps/api/src/services/control-plane.ts` | drops node cost | unchanged dropping; refuses node `model_call` steps; settlement path with `reservationId` |
| `apps/api/src/services/run-nodes.ts` | sessions, broker | `model_token_jti`, harness sessions, revocation publish to Valkey |
| `apps/api/src/http/routes/worker.ts` | run node routes | `model`, `model-token`, `model-reservations` routes |
| `apps/api/src/http/routes/model-proxy.ts` | - | new: passthrough surfaces |
| `apps/api/src/services/model-accounting.ts`, `model-proxy.ts` | - | new: reservation/settlement, admission, forwarding |
| `packages/providers` | non-streaming adapters | streaming upstream transports for the two surfaces; cache token usage; `PriceEntry` cache prices |
| `packages/runners/src/harness*.ts` | key/OAuth in child env | proxy endpoint + model token mode |
| `docs/runners.md` | "Not in this version: model proxy" | section replaced by a link to `docs/model-proxy.md` |
| `docs/budgets.md` | overshoot possible | reservations; overshoot only for priced tool calls |
| Compose, Helm | - | flags, ingress exclusion, Helm mirror issue |

Existing installations: the proxy is off by default; with it off nothing changes. Isolated steps
start counting against run, step and monthly budgets once it is on, which can stop runs that
passed before (pre-1.0, noted in the changelog).

## Consequences

- Positive: a run node can use every configured provider without ever holding a key; costs of
  isolated steps are measured, not reported; budgets become hard limits under concurrency for all
  model calls (in-process too); classification, air-gap and overrides apply to model calls in one
  place; harnesses in nodes become possible and their cost becomes measured.
- Positive: the reservation design removes the overshoot documented in `docs/budgets.md` for model
  calls.
- Negative: every model call of an isolated step adds a hop through the control node and two short
  transactions; the control node carries streaming load (mitigated by limits and a possible
  separate deployment).
- Negative: the upper-bound reservation refuses calls near a limit earlier than strictly needed;
  operators can choose `estimate` mode at the cost of the guarantee.
- Negative: two protocol surfaces to keep in sync with provider APIs; new provider parameters are
  refused until reviewed and allowlisted.
- Negative: the tenant-wide advisory lock serialises reservations of one tenant; fine for v0.2
  volumes, revisited with the scale-out queue (W7-5).

## Alternatives considered

- **Give nodes provider keys from the broker**: rejected in ADR 0008 (long-lived keys in untrusted
  nodes, misreported usage).
- **An external LLM gateway (LiteLLM and similar) in front of providers**: would need its own
  key store, budget model and audit integration, and is another component to harden; budgets,
  scopes, classification and the audit chain live in the control node already. Rejected for v0.2;
  operators can still put a gateway behind an `openai-compatible` connection.
- **Trust node-reported usage, signed by the node**: the node is the adversary. Rejected.
- **Check budgets only after the call (today's model) for proxied calls**: concurrent calls and
  large `max_tokens` overshoot without bound. Rejected in favour of reservations.
- **Exact input tokens through provider count endpoints before every call**: an extra round trip,
  not available for every provider. Kept as an optional optimisation (open question 2).
- **Run tokens as harness credentials**: they open more than model endpoints. Rejected; separate
  model token.
- **Generic cross-protocol translation** (Anthropic surface on top of OpenAI backends): larger
  parsing and semantic surface. Deferred (open question 6).
- **Forward raw request bytes and filter headers**: smuggling risk and parameter drift. Rejected;
  parse and re-serialize.

## Open questions

1. Separate `model-proxy` deployment by default in the Helm chart, or only when load requires it?
2. Exact input counting (Anthropic `count_tokens`, local tokenizers) to shrink reservations: worth
   the latency and the dependency?
3. Should the Claude Code OAuth subscription mode ever run in nodes (owner decision; today: no)?
4. Opt-in `full` capture of redacted prompts for debugging: retention, GDPR, tenant setting?
5. More than one allowed model per step (fallbacks), together with model routing (W4-5)?
6. Cross-protocol translation so that any harness can use any provider?
7. Catalog import of cache prices (`scripts/import-models-dev.mjs`) and per-image token constants.
8. A native SSE variant of `POST .../model` for live token streaming into the console?
9. Default limits (concurrency per session/tenant, calls per minute) after the first real loads.

## Amendments

### W1-3b-3: native endpoint and model token (2026-10-04)

Decisions taken while implementing `POST /v1/worker/runs/{id}/model` and `.../model-token`. Where
they differ from the text above, this section wins.

1. **Native SSE variant (answers open question 8).** The native endpoint answers JSON by default.
   With `Accept: text/event-stream` it answers Server-Sent Events: `start { callId }`,
   `delta { text }` per upstream text delta, then `done` (the `WorkerModelResponse`) or `error
   { code, message }`. Tool calls are delivered in `done` only. Errors before the first upstream
   byte are plain JSON errors with the usual status. Providers without a streaming transport
   (`simulated`, Bedrock models that do not speak the Anthropic body) are completed first and
   replayed as one `delta` and `done`.
2. **Revocation by polling only.** An open call polls the session and run every
   `OAX_MODEL_PROXY_REVOCATION_POLL_MS`. The Valkey channel `oax:session-revoked` is not built: the
   cache interface has no publish/subscribe. The sliding-window call rate (`OAX_MODEL_PROXY_CALLS_PER_MINUTE`)
   is per replica and in memory; the concurrency limits are database counters and hold across replicas.
3. **Hard stop rule and reported usage.** The output of a stream is cut when `max(reported output
   tokens, ceil(streamed bytes / 8))` exceeds the granted output bound by more than 10 %. Bytes / 8
   is the floor of section 4.1: an honest provider that obeys `max_tokens` never reaches it (using
   bytes / 3 would cut honest answers that run into the limit). A provider that reports more than
   the bound is therefore cut as well. Usage that is reported is capped before settlement: input and
   cache tokens together at the reserved input bound, output at `ceil(1.1 x bound) + 256` (never
   below the bytes / 8 floor); the raw numbers go to the `model.overrun` audit entry only. An
   aborted stream is settled with the estimate (bytes / 3, section 4.1) from what was streamed,
   which can exceed the reservation by at most the bytes seen before the cut-off.
   *Corrected:* an earlier text of this amendment said a hostile provider could be charged well above
   its reservation; with the cap and the early cut-off the settled amount stays within the
   reservation plus the 10 % overrun of the output bound.
4. **Token and binding errors.** A model token whose `jti` is not the one stored in the session is
   `401 unauthenticated`; a token or run token for another run than the path's, an agent that is not
   the token's step, and an orchestrator token without `sid` are `403 model_not_allowed`; a revoked
   or expired session, a run that is not `running`, a cancelled run or a lease taken over by
   another worker are `403 run_node_session_revoked`. A provider that does not resolve for the run's
   scope (including another tenant's BYOK connection) is `403 model_not_allowed`; a provider that
   exists but cannot be built (missing secret) is `503 model_proxy_unavailable`.
5. **No per-session context cache.** Definition, provider and secrets are resolved on every call, so a
   revoked connection or rotated key takes effect on the next call. The cost is a few indexed reads
   per call.
6. **Strict schema before the allowlist.** The strict request schema (unknown keys, server tools,
   `provider`, node-supplied `simulation`) runs when the body is parsed, so such requests are
   `400 model_parameter_refused` before the model allowlist (`403 model_not_allowed`) is evaluated.
   Nothing is forwarded or reserved in either case.
7. **Request parser.** The model routes use their own JSON parser (no duplicate keys, no
   prototype keys, depth 64, `OAX_MODEL_PROXY_MAX_BODY_BYTES`) and answer in the model envelope
   `{ error: { code, message } }`, including authentication failures; a body with both
   `content-length` and `transfer-encoding` is refused.
8. **Audit and settlement.** `ModelAccountingService.settle` accepts `auditExtra` (node id, request
   digest, latency, stop reason: names and numbers only) that is merged into the `step.model_call`
   payload, and scrubs step payloads before it opens its transaction (not inside it). A call that
   cannot be settled returns `503` without the model output; the reaper settles the reservation at
   the reserved amount.
9. **Token response.** `baseUrl` is `<OAX_NODE_CONTROL_URL or OAX_PUBLIC_URL>/v1/worker/runs/<runId>`
   and `protocol` is always `native` until the pass-through surfaces exist (W1-3b-6).
10. **Known gaps carried to later tasks.** `ModelAccountingService` prices with the global
    `CostModel`; prices set only on a BYOK connection's `models[]` are not seen by the reservation, so
    such a model counts as unpriced (`422 model_unpriced` under a cost limit, otherwise `priced:
    false`). The connection schema has no `tokenBoundFactor`. The emergency-override check (W2-3) is
    a hook (`ModelProxyHooks.checkOverride`) without an implementation.

### W1-3b-3 review fixes (2026-10-04)

11. **One call, one provider request, no retries.** Every provider the proxy builds has
    `maxRetries: 0` (Bedrock one attempt, stream transports no retries) and an HTTP timeout equal to
    the call deadline; a retry is a second billed call under one reservation, so the node retries
    with a new reservation. Only provably pre-send failures are released at zero (egress refusal, DNS
    and connection-refused errors, and a 4xx other than 408, 409 and 429); timeouts, resets, 5xx and
    stream errors are charged with the reservation or the estimate.
12. **The JSON path uses the stream plan.** For every provider with a streaming transport the plain
    JSON answer is produced through that transport and aggregated, so the response size limit
    (`OAX_MODEL_PROXY_MAX_RESPONSE_BYTES`), time to first byte, idle and deadline timeouts and the
    output hard stop apply uniformly. Providers without a transport (`simulated`, Bedrock models
    that do not speak the Anthropic body) use the adapter; the adapter paths use a bounded body
    reader, never follow redirects and have a call deadline. The Bedrock adapter of a tenant-scoped
    connection runs on an SDK request handler that fails the body beyond 16 MiB (see 14).
13. **Deadline.** The call deadline is `min(OAX_MODEL_PROXY_MAX_CALL_SECONDS, time left of the run
    timeout since the run start, time left of the step timeout since the session start)`, at least
    one second while any time is left. A run or step whose time is already exhausted is refused
    (`504 provider_timeout`) without a reservation.
14. **Tenant-controlled endpoints.** Redirects are never followed (also in the SDK fetch). Endpoints
    of tenant-scoped connections that are or resolve to loopback, private, link-local, metadata,
    CGNAT, multicast or translation-embedded (IPv4-mapped, IPv4-compatible, NAT64, 6to4, Teredo)
    private addresses are refused with `403 egress_denied` before the call and again right before
    each request, unless listed in `OAX_MODEL_PROXY_PRIVATE_ALLOW`. A name that cannot be
    resolved is refused too (fail closed). At connect time the HTTP client (an undici dispatcher
    for fetch, an `https.Agent` for the AWS SDK) resolves the name itself through a lookup that
    validates every address and connects to exactly those, so a DNS answer that changes between
    the check and the connection (rebinding) is rejected. Limit: behind an HTTP proxy
    (`proxyUrl`, `HTTPS_PROXY`) the proxy resolves the name, so only the pre-request check
    applies; the operator trusts that proxy. A tenant-scoped Bedrock `endpoint` goes through the
    same check and lookup, and its responses are bounded (stream limit, 16 MiB for the adapter).
15. **Node-facing errors carry no upstream text.** Provider failures are reported as the HTTP status
    or the kind of stream failure; budget refusals use fixed texts without scope names or numbers.
16. **Smaller points.** The `requestDigest` is an HMAC under a per-tenant key derived from the server
    secret; the HTTP rate limit of the model routes is keyed by peer address and a 429 is answered
    in the model envelope with `Retry-After` (invalid tokens are rejected by authentication before
    the limiter); the model proxy reads connections fresh (no 30 s cache); a failure in `begin()` or
    aggregation settles the reservation and reports an error; `oax_model_proxy_*` labels use the
    provider family, not the connection name (the older `oax_cost_micro_usd_total` still labels by
    provider name).

### W1-3b-4: run node and executor switch (2026-10-09)

Decisions taken while switching the run node and the executor to the proxy and the accounting
service. Where they differ from the text above, this section wins.

1. **Run node.** `oax run-node` builds a `ModelProxyProvider` (`metered = true`, `clearance
   restricted`: the proxy decides the classification) for every provider of its step, the simulated
   provider included; the placeholder `ModelProxyUnavailableProvider` is deleted. A disabled proxy
   still ends the step with `model_proxy_unavailable`. The node uses the native endpoint with the
   step's run token (the model token is for harness children, W1-3b-7), sends only the wire fields
   (`hints.simulation` is never sent) and reads the stable error code of the model envelope, so a
   refusal of the proxy fails the step with that code (`control_budget_*`, `model_unpriced`,
   `model_not_allowed`, ...; `classification_denied`, `egress_denied` and `security_override` as
   `blocked_by_policy`).
2. **Executor.** A provider with `metered = true` is authoritative: no local cost, no `model_call`
   step, no reservation request. The response carries `metered { callId, costMicros, priced,
   remaining }`; the cost feeds the node's local control decisions only.
3. **Reservations for in-process steps.** Before each call the executor asks
   `ControlPlane.reserveModelCall(runId, { agentId, inputTokens (upper bound), maxOutputTokens,
   minOutputTokens })`, passes the granted output bound as `maxTokens`, and sends the `model_call`
   step with `reservationId`. The control node then settles the reservation: it computes the cost
   from the usage (the executor's own cost number is ignored), writes step, ledger line (`via =
   'in-process'`) and audit entry, and closes the reservation. A call that failed on its own is
   released at zero (the `error` step carries the `reservationId`); a call aborted by cancellation
   or timeout keeps its reservation, which expires and is charged at the reserved amount. The
   output bound defaults to `agent.maxTokensPerCall`, else 4096 (the proxy's default); an in-process
   step without `maxTokensPerCall` is therefore capped at 4096 output tokens when the control plane
   reserves. The local CLI control plane has no ledger and calls the model unreserved, as before.
   Route: `POST /v1/worker/runs/{id}/model-reservations`, orchestrator token only (a node token is
   `403`), model envelope, available whether or not `OAX_MODEL_PROXY_ENABLED` is set (the
   accounting applies to every model call).
4. **Reservation ownership.** A trusted `model_call`/`error` step with a `reservationId` only settles
   an **active reservation of the same run** (otherwise `404`); a second report for a closed
   reservation is refused, so a call cannot be counted twice. The field is dropped from steps
   reported by run nodes.
5. **Node steps.** A step of kind `model_call` reported by a run node is `400 step_kind_refused`
   (earlier it was recorded without cost). The proxy is the only writer of node model calls.
6. **Authoritative counters.** `NodeDispatcher` reads the run's counters (`ControlPlaneService.
   runUsage`) before the session is created and after the node ended; the difference is the step's
   usage that the executor adds to its metrics, so later in-process steps see the true remaining
   budget. A failed or cancelled node step does not return its usage to the orchestrator (the
   counters in the database are still right; only the in-memory metrics of the aborted run miss it).
7. **Pricing (closes known gap 10 of W1-3b-3).** `ModelAccountingService` resolves the price through
   `ModelsService.priceFor(scope, provider, model)`: the provider (connection) name, then the
   connection's catalog provider, then the adapter kind, with the price overrides of the run's
   connections. BYOK prices therefore reach reservation and settlement, and in-process runs keep
   the prices they had. The lookup happens before the accounting transaction opens.
8. **Behaviour change for budgets.** Monthly, run and step limits now stop a call **before** it is
   made when its worst case does not fit, so a run can be refused with a budget code while the
   remaining headroom would have covered the actual cost. Size small budgets with the output bound
   in mind (`maxTokensPerCall`).


### W1-3b-4 review amendments (2026-10-09)

Where these differ from the W1-3b-4 section above, this section wins.

1. **Release rule.** An in-process error releases its reservation at zero only for failures that
   provably did no work, the same rule as the proxy's `noWorkDone`: `egress_denied`, a DNS or
   refused-connection failure before the request was sent, or a 4xx answer other than 408, 409 and
   429. Everything else (aborts, deadlines, timeouts, resets, 5xx, stream errors) keeps the
   reservation, which expires and is charged at the reserved amount.
2. **Call deadline.** The reservation grant carries `deadlineMs` (the deadline the reservation was
   sized for, `OAX_MODEL_PROXY_MAX_CALL_SECONDS` by default). The executor aborts the in-process
   provider call at that deadline, so a call cannot outlive its reservation (which expires after
   the deadline plus the grace). A late report for an already expired reservation no longer fails
   the run with `404`: the amount booked at expiry stands and the report is recorded as a
   `model.late_settlement` audit entry (reported tokens, booked amount). A report for a reservation
   that was settled normally is still `404`.
3. **Reservation ownership.** An in-process settlement requires a reservation of the same run with
   no run node session (`sessionId` null) and the same agent as the step; everything else looks
   like a missing reservation.
4. **Pricing.** The fallback keys (catalog provider, adapter kind) are looked up in the platform
   price table only. Overrides of a tenant connection count only under the name of the connection
   the agent actually uses, so a tenant connection named like a catalog provider cannot change the
   price of another connection. A failing price lookup is logged as a warning.
5. **Compatibility breaks (also in the changelog).** Isolated node steps fail with
   `model_proxy_unavailable` while `OAX_MODEL_PROXY_ENABLED=false` (the default), the simulated
   provider included. Old `oax run-node` images report `model_call` steps and now get `400
   step_kind_refused`: roll out control node and node images together. A model without a price is
   rejected with `422 model_unpriced` as soon as any cost limit applies.

### W1-3b-6: pass-through surfaces (2026-10-09)

Decisions taken while implementing `/v1/model-proxy/anthropic/...` and `/openai/...`. Where they
differ from the text above, this section wins.

1. **Scope.** Delivered: `POST .../anthropic/v1/messages`, `POST .../openai/v1/chat/completions`
   (JSON and SSE) and `GET .../v1/models` on both surfaces. Not delivered: `POST
   .../messages/count_tokens` (needs an upstream call or an honest local estimate; open) and `GET
   .../models/{id}`. A harness that needs them falls back to its own estimate or fails visibly with a
   404.
2. **Credential.** The model token only. The access kind is still `model-token`, but on these routes
   the authentication hook accepts nothing else: a run token is `401 unauthenticated` (least
   privilege, section 2.2). The token comes from `Authorization: Bearer` or `x-api-key`; if both are
   present and differ the request is treated as unauthenticated. No client credential or header is
   forwarded, and the upstream header set stays the one of section 6.1.
3. **One admission chain.** A pass-through call is an ordinary `admit` -> `reserve` -> stream ->
   `settle` call of the native route (shared code path), so token binding, model allowlist
   (`model` must equal the step's published model: a harness has to set its default and small-fast
   model to it, section 10), classification, air-gap, tenant endpoint SSRF checks with DNS pinning,
   emergency-override hook, budgets, rate and concurrency limits, usage caps and the hard stop are
   the same. The run and agent come from the token. The simulated provider works on both surfaces
   (synthesised events).
4. **Request path.** The strict allowlist schemas of section 6.2 are implemented in
   `packages/providers/src/passthrough`. The upstream body is built from the parsed value: `metadata`
   (Anthropic) and `user` (OpenAI) are dropped, `max_tokens` / `max_completion_tokens` is the granted
   bound (never above the request), `stream_options` is overwritten, the OpenAI `developer` role is
   sent as `system`, and an extended-thinking budget is clamped below the output bound. The input
   upper bound counts every text, tool and schema string plus a fixed bound per image and the bytes
   of the remaining parameters. Additions to the table of section 6.2: OpenAI `reasoning_effort`
   (enum) is accepted; Anthropic `thinking` requires `stream: true` (a JSON answer would have to drop
   thinking blocks and their signatures).
5. **Response path.** Every relayed stream event is rebuilt from allowlisted fields and length-limited
   (unknown keys, vendor fields and unknown event types never reach the client). OpenAI `choices`
   other than index 0 are dropped, and the usage-only chunk is relayed only when the client set
   `stream_options.include_usage`. Non-streaming answers are produced through the same stream
   transport (item 12 of the W1-3b-3 review fixes) and rendered from the settled response: text and tool calls
   only, usage from the capped settlement. Headers: `x-oax-call-id` always; `x-oax-cost-micros` for
   JSON answers only (a stream's headers are sent before its cost is known).
6. **Hard stop and errors.** A stop after the first byte is sent as `event: error` with the
   Anthropic error body (`{ type: "error", error: { type, message, code } }`) or as a final
   `data: { error: { message, type, code } }` chunk **without** `[DONE]`; the stream is then closed
   and the call is settled from what was streamed (`model.aborted`, usage source `estimated`).
   Errors before the first byte are plain HTTP errors in the protocol's envelope, `error.code` being
   the platform code and the message prefixed with it.
7. **Betas.** `anthropic-beta` values are intersected with `OAX_MODEL_PROXY_ANTHROPIC_BETAS` (default
   empty = none) and each must match `^[a-z0-9._-]{1,64}$`; the rest are dropped silently.
8. **Metrics.** `oax_model_proxy_requests_total` carries `surface="anthropic" | "openai"` for
   pass-through calls (`native` before).
9. **Review fixes (2026-10-09).** (a) A request with `cache_control` is reserved at the cache-write
   rate (`cacheWrite`), so a cache-writing call cannot settle above its reservation; `ttl: "1h"`
   (written at twice the input price, which the reservation does not model) is refused with
   `model_parameter_refused`. (b) A thinking budget below the API minimum of 1024 after the output
   clamp is not sent: thinking is omitted for that call. (c) A content string above 64 KiB in a
   relayed upstream event ends the stream with a `provider_error` instead of being blanked;
   synthesised events (providers without a stream) are split into chunks below the limit. (d)
   Client-visible events and JSON answers carry the model of the step, an id derived from the call id
   (never the upstream id) and usage capped to the bounds the books use. (e) The model token is
   checked before the request body is validated. (f) Non-streaming answers stay validated against the
   wire schema; only a relayed stream (already delivered event by event) skips it.

### W1-3b-7: harness adapters through the proxy (2026-10-09)

Decisions taken while implementing section 10 for Claude Code and OpenCode in the run node (PLAT-04).
Where they differ from the text above, this section wins. The run-node **images** that contain the
harness binaries (`run-node-claude-code`, `run-node-opencode`) are PLAT-05 and not part of this
change; the node looks the binaries up through `OAX_CLAUDE_BIN`, `OAX_OPENCODE_BIN` and
`OAX_OPENCODE_SHA256` and fails with `harness_spawn_failed` when they are missing.

**Threat model of a harness step.** A harness is a large, fast-moving third-party program with its
own tools, plugins, network stack and update logic, driven by a model that reads untrusted text. We
assume it can be steered into any action its process can perform, and that its output is attacker
influenced.

| # | Threat | Control |
| --- | --- | --- |
| H1 | The harness holds a provider key or an OAuth token and misuses or leaks it (prompt injection, tool output, a log line) | The child's only credential is the **model token** of its step (section 2.2). No provider key, no `CLAUDE_CODE_OAUTH_TOKEN`, no cloud variable reaches the node (`assertProxyInvocation` refuses them when the invocation is built and again before the spawn). A token file or host login configured on the adapter is ignored in proxy mode. The token is scrubbed from everything the harness returns |
| H2 | A stolen model token is used elsewhere | Bound to run, session, node, step and one `jti`, expires with the session, dies when the session is revoked (section 2.2); opens model endpoints only, never the gate, approvals, credentials or handover. Spending stays inside the step's reservations and the run, step and tenant limits of the admission chain. A harness step gets its token **for the harness** (`{ agentId, harness }`); the native token is refused for it |
| H3 | The harness bypasses the policy gate through built-in tools (shell, file edit, web fetch) | Claude Code: `--tools ""`, `--strict-mcp-config`, `--permission-mode dontAsk`, an allowlist of exactly the gate tools the control node serves for this step, `--restricted`. OpenCode: `"*": "deny"`, every built-in tool denied and switched off, one provider, one MCP server (the gate). Flags that switch the permission model off are refused. The tool list comes from `exposedTools(agent)`, i.e. from the step's concrete grants (profiles are expanded at publish), so the harness never sees more than a native step. Anything the stream reports outside the gate ends the run `blocked_by_policy` (`harness_unmanaged_tool`) |
| H4 | A policy decision is skipped | Every gate call is decided by the control node (`POST /v1/worker/runs/{id}/gate`, audited `policy.decision`); approvals are awaited there; the harness has no other way to act |
| H5 | The harness uses a different model or a hidden route (background calls, telemetry, update checks) | The proxy only lets the step's published model through, so the adapters set every model variable the CLI consults (`ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL`) to it; non-essential traffic, telemetry, error reporting, auto-update, experimental betas, model-catalog and LSP downloads, plugins and sharing are switched off; `HTTP(S)_PROXY`-style variables are not set. Where a harness still tries another host, the node's egress rules (the egress proxy of the container runner) apply |
| H6 | Cost is misreported | The ledger line of every upstream call is written by the proxy (`via = 'proxy'`). The harness' own report is stored in the output step (`harness.reported`) for comparison only; the `model_call` step of a node is refused (`step_kind_refused`), so none is written in proxy mode. `--max-budget-usd` and the platform-side check on the reported cost stay as a secondary limit |
| H7 | Runaway or hanging harness | `budget.maxSteps` (turn limit, enforced by flag and counted by the platform), `budget.timeoutSeconds` (kill), a **default of 30 minutes** when the agent sets none, cancellation, output cap of 16 MiB, stderr cap. The child runs in its own process group and the whole group is killed on stop and after exit, so nothing it forked survives. CPU, memory, PID and disk limits come from the container (or Job) of the run node; the adapter does not try to replace them |
| H8 | Output is hostile (tool output, final answer) | Captured as data only: the answer becomes the `output` step, validated against `output.schema` by the orchestrator; tool results are recorded by the gate (`tool_call` step, size-capped, credential values scrubbed) and truncated in the transcript; nothing the harness prints is executed or interpreted by the platform. The audit chain therefore holds: gate decisions and tool calls (control node), proxy calls and `model_token.issued` (control node), and the `output` / `error` step of the node, which carries the harness report (turns, termination, tool names, reported usage) |
| H9 | The harness binary is swapped or downloaded at run time | The platform never downloads a harness. Binaries are part of the node image (pinned and checksummed at build time, PLAT-05); OpenCode additionally verifies `OAX_OPENCODE_SHA256` before every start. Tests use fakes and fixtures only |
| H10 | A harness step runs in the worker process | Refused at publish (`harness` needs `container` or `kubernetes-job`), refused again by the step executor (`harness_requires_isolated_runner`), and the dispatcher only hands steps to run nodes |
| H11 | Cross-protocol confusion | No translation: Claude Code is limited to the Anthropic surface, OpenCode may use either, and the control node picks the surface from the harness **and the provider kind** (`400 model_surface_mismatch` otherwise, section 2.4). The CLI's choice never decides |

**Decisions.**

1. **Field and checks.** `agents[].runtime.harness: claude-code | opencode` (additive, optional;
   `hermes` and `openclaw` stay stubs and are not selectable). Definition check: the effective runner
   must be `container` or `kubernetes-job`, and the step must not have a `simulation`. Publish check:
   the harness is listed in the new `OAX_HARNESSES_ENABLED` (default empty). That variable requires
   `OAX_MODEL_PROXY_ENABLED=true` at startup (a harness without the proxy would need a provider key).
   The provider is checked when the token is issued, because only then the connection is resolved
   for the run's tenant.
2. **Model token for harnesses.** `POST /v1/worker/runs/{id}/model-token` accepts
   `{ agentId, harness? }`. With `harness` the step must have been published with exactly that
   harness (and the harness must be enabled); the answer is
   `{ protocol: "anthropic" | "openai", baseUrl: <control>/v1/model-proxy/<protocol>, model, token, expiresAt }`.
   `baseUrl` is the surface root **without** `/v1`: Claude Code appends `/v1/messages` itself, OpenCode
   gets `<baseUrl>/v1`. A harness step cannot ask for the native form. The audit entry
   `model_token.issued` gains `harness` and `protocol`.
3. **Adapter interface.** `ExternalHarness.buildInvocation(..., proxy?: ModelProxyEndpoint)`. With
   `proxy` the adapter builds the command line and environment for the proxy; `HarnessInvocation`
   carries `modelProxy` (public part) and `redact` (the token, for scrubbing). The CLI keeps its direct
   modes unchanged (`oax run --harness`, token file, BYOK connections).
4. **Run node.** For a step with `runtime.harness` the node requests the harness token, runs
   `executeWithHarness` with the proxy option (policy gate over loopback MCP as before) and reports the
   output. No `model_call` step and no usage numbers of the harness enter the books of the node.
   Classification and air-gap checks are the proxy's (`clearance restricted` on the node side);
   the direct-egress allowlist of the adapter does not apply behind the proxy.
5. **Tool and permission mapping.** Unchanged in principle (section 10 and ADR 0005): the harness gets
   exactly the tools the gate serves for the step. New is the guard `assertProxyInvocation`
   (forbidden environment, permission-bypass flags, permission mode, non-model secrets, missing time
   limit, base URL mismatch).
6. **Limits.** Default time limit, process-group kill, existing turn/cost/output limits (H7).

**Not in this change (open).** Run-node images with pinned binaries and the per-harness image
selection (PLAT-05); the verified variable names of the pinned CLI versions (the names above come from
the CLI documentation; the first real run is PLAT-60 and updates `docs/verification/`); an in-process
(orchestrator) harness session; `count_tokens` for harnesses that call it; hard CPU/memory limits
inside the node beyond what the container runner sets; harness steps with `credentials` that the
harness itself should see (the child never receives them; only MCP tools of the gate do).

**Review amendment (2026-10-09).** Findings of the PR review and their resolution.

1. **Config placeholder injection (OpenCode).** OpenCode substitutes `{env:NAME}` and `{file:PATH}` in
   the raw text of its configuration file before parsing. Author-controlled strings (instructions,
   `provider`, `model`, ids) could therefore pull `OAX_OPENCODE_API_KEY` (the model token) or the run
   token file (`OAX_RUN_TOKEN_FILE`) into the prompt. Controls: (a) definition validation refuses
   `{env:` and `{file:` (case-insensitive) in `provider`, `model` and the instructions of a harness
   step; (b) the adapter writes the opening brace of such sequences as the JSON escape `\u007b` in
   every string of the generated file, so the substitution pattern never matches while `JSON.parse`
   still yields the literal text. The adapter's own placeholders (key, header values) are inserted
   last through a per-build random marker that an author cannot know. (c) The node removes the run
   token file after reading it (the token is never re-read, there is no refresh); this is best
   effort, because a container reads `/dev/stdin` and a mounted Secret is read-only. The harness
   environment never contains the path.
2. **Environment.** Behind the proxy the environment is an allowlist (PATH, LANG, NO_COLOR, HOME, XDG
   dirs, the documented Claude/OpenCode switches, the model variables, `OAX_OPENCODE_*`); everything
   else is refused. For every harness (also the direct modes) the loader and trust variables
   (`NODE_*`, `LD_*`, `DYLD_*`, `BUN_*`, `SSL_CERT_*`, `CLAUDE_CONFIG_DIR`, `ANTHROPIC_CUSTOM_HEADERS`,
   `OPENCODE_CONFIG_CONTENT|DIR`, `OPENCODE_PERMISSION`, CA bundle variables) are refused.
   `ANTHROPIC_BASE_URL` must equal the proxy base URL. The check runs on the environment that is
   actually passed to `spawn`, after the adapter added HOME, XDG, config path and key.
3. **Process end and redaction.** The adapter reacts to `exit` and not only `close`; the process
   group is always signalled (also after the leader exited) so a descendant holding stdout cannot hang
   the run. stderr is redacted before it is truncated. Model token response errors report field names
   only. Gate call args and harness errors are redacted with the step's tokens before they are
   recorded.
4. **Token surface.** The model token gets the claims `surface` (`native` | `harness`, default
   `native` for older tokens) and, for `harness`, the harness kind. `POST .../model` accepts only
   `native` tokens, the pass-through surfaces only `harness` tokens (`model_not_allowed`). The control
   node still decides which harness a step may use at issue time.

**Merge-blocking verification notes (to be confirmed with the pinned binaries, PLAT-05/PLAT-60).**

- OpenCode must **not install npm provider packages at run time**. The config names
  `@ai-sdk/anthropic` / `@ai-sdk/openai-compatible`; the node image must bundle them and the node
  must have no registry egress. Verify with the pinned binary and no network that a run starts and
  that no `npm`/`bun add` is attempted. Until verified this is a residual risk (a run-time install
  would execute third-party code with the model token in its environment).
- Claude Code `managed-settings.json` must **not exist in the node image** (nor
  `/etc/claude-code`, nor a `CLAUDE_CONFIG_DIR`), because managed settings override flags such as
  `--restricted` and permissions. Verify by listing the image file system in the image build test.
- The default egress of harness steps should be **control node only**. The container runner of this
  change still applies the pipeline's `runtime.egress` allowlist; it has no per-step "control node
  only" default for harness steps. This is documented as a **residual risk**: until it exists, a
  harness step should be published with `runtime.egress: []` (the narrowest declaration); whether the
  egress proxy then admits the control node only was not verified here.

### DOG-1: harness image selection, egress default, resources (2026-10-09)

Closes the "run-node images" and "verified variable names" items of W1-3b-7 for Claude Code. Where it
differs from the text above, this section wins.

1. **Image per harness (H9).** `OAX_CONTAINER_HARNESS_IMAGES` maps a harness to a digest-pinned image.
   The keys are the allowlist (only `HARNESS_KINDS`); a harness step runs **only** on the image of its
   harness (`image_not_allowed` otherwise), an unmapped harness fails closed (`harness_image_unknown`,
   and publish refuses it on the container runner). The Claude Code image is built from the Dockerfile
   target `run-node-claude-code`: the native binary is downloaded at build time only and verified
   against the SHA-512 of the registry metadata recorded in the Dockerfile; no package manager remains
   in the image. OpenCode has no image target yet.
2. **Egress default (H5).** A harness step publishes with `runtime.egress: []`. Declared hosts are
   refused at publish and again by the container runner at node start (`harness_egress_denied`) unless
   the operator sets `OAX_HARNESS_EGRESS_ALLOWED=true`. "Control node only" is thereby enforced rather
   than a convention, and was verified from inside a node (control node reachable; DNS for
   `api.anthropic.com` and `github.com` fails; direct IPs unreachable).
3. **Resources (H7).** A harness node gets `OAX_CONTAINER_HARNESS_MEMORY_MB` (default 2048, capped by
   `OAX_CONTAINER_MAX_MEMORY_MB`) and a `/tmp` of `OAX_CONTAINER_HARNESS_TMP_MB` (default 256);
   ordinary nodes keep `OAX_CONTAINER_MEMORY_MB` (512) and `OAX_CONTAINER_TMP_MB` (64). The operator
   maximum `OAX_CONTAINER_MAX_MEMORY_MB` is only the ceiling: raising it to 2048 for harness steps does
   not give ordinary nodes 2048 MiB (the worker passes the default, not the ceiling, as step limit). A
   `/tmp` larger than half of the node memory is a configuration error (config and runner schema), so
   that tmpfs pages cannot starve the process. `/tmp` stays `noexec`.
4. **Verification.** The environment variables `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and
   `ANTHROPIC_MODEL` and the request shape (`/v1/messages`, Bearer, `tools: []`, no other request)
   are verified against the pinned binary (`docs/verification/claude-code-harness.md`).
5. **Licence.** The binary is proprietary: the image belongs in a private registry package. It carries no
   `org.opencontainers.image.source` label (GHCR would link the package to the public repository), and
   the build script verifies the package visibility with `gh api` before and after the push and aborts
   if it is not private. The SHA-512 pin is the npm registry integrity, not an Anthropic signature (no
   provenance): the registry is the trust anchor when the value is recorded.
6. **Credential.** The upstream credential of the Claude Code pass-through surface is an API key with a
   provider-side spend limit (owner decision 2026-10-09). The subscription-token option (`authTokenRef`,
   section 10 stays "OAuth is orchestrator-only, not proxied") is not built (DOG-1b closed as not needed).
7. **Review fixes.** (a) Publish refuses a harness step with a `toolbox` and an ordinary step whose
   toolbox or default image is a harness image; the runner refuses an ordinary step on a harness image
   unless it is also the default or a toolbox image. (b) `OAX_HARNESS_EGRESS_ALLOWED=true` is an
   exfiltration risk (a harness node holds a model token and reads untrusted content) and is documented
   as such. (c) "No DNS on the internal network" needs Docker Engine >= 26; Podman/aardvark-dns behaviour
   must be verified with `scripts/test-harness-image.sh`. (d) The image smoke test is automated and
   runs in CI; its egress part uses a fake proxy and proves the network path, not the real egress proxy
   (whose grant checks are covered by the egress proxy unit tests).
