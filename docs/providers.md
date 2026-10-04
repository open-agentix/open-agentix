# Models, providers and keys

Every regular provider is a **model connection**. Agents name a connection (`provider:` in
`agents.md`) and a model id (`model:`); the platform resolves the connection for the run's tenant,
team and agent, reads the API key from a secret reference, calls the provider and prices the usage.

| `kind` | Provider | Endpoint (default) | Auth (secret references) | Notes |
| --- | --- | --- | --- | --- |
| `anthropic` | Claude API (Anthropic) | `https://api.anthropic.com` | `apiKeySecret` | Official SDK, tool use. |
| `bedrock` | AWS Bedrock | regional runtime endpoint or VPC endpoint (`endpoint`) | default AWS chain (IRSA, roles) or `accessKeyIdSecret` + `secretAccessKeySecret` (+ `sessionTokenSecret`) | Converse API; `proxyUrl`; inference profiles (`eu.anthropic...`) are priced like their base model. |
| `openai` | OpenAI (GPT) | `https://api.openai.com/v1` | `apiKeySecret`, `organization` | Uses `max_completion_tokens`. |
| `azure-openai` | Azure OpenAI | `endpoint` = `https://<resource>.openai.azure.com` | `apiKeySecret` | `model` is the deployment name unless `deployment` is set; `apiVersion` (default `2024-10-21`). |
| `openrouter` | OpenRouter | `https://openrouter.ai/api/v1` | `apiKeySecret` | Optional `referer` and `title` attribution headers. |
| `vllm` | vLLM | `baseUrl` (required) | optional `apiKeySecret` | Default clearance `restricted`. |
| `lmstudio` | LM Studio | `http://localhost:1234/v1` | none | Default clearance `restricted`. |
| `ollama` | Ollama | `http://localhost:11434` | none | Default clearance `restricted`. |
| `openai-compatible` | any `/chat/completions` server | `baseUrl` (required) | `apiKeySecret`, `headerSecrets` | LiteLLM, TGI, internal gateways. |
| `simulated` | deterministic, no network | - | - | Tests, demos, dry runs. |

Common settings: `clearance` (highest data classification the provider may receive), `proxyUrl`,
`timeoutMs`, `maxRetries`, `models` (below), `catalogProvider` (models.dev id used for prices).

## Connections (BYOK)

```bash
curl -X POST $OAX/v1/connections -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "name": "gpt", "kind": "model", "scope": "team", "scopeId": "<team id>",
  "config": { "kind": "openai", "apiKeySecret": "acme.openai-key",
              "models": [ { "id": "gpt-4.1" } ] } }'
```

- **Keys are secret references**, never values: resolved from `OAX_SECRET_<NAME>` or a mounted
  secret directory at run time (`ACME.OPENAI-KEY` becomes `OAX_SECRET_ACME_OPENAI_KEY`). They never
  appear in prompts, audit entries, logs or API responses.
- **Scope**: `platform` (operators only, usable by every tenant), `tenant`, `team` or `agent`. A run
  uses the most specific connection of that name: agent, team, tenant, platform. Providers from
  `OAX_PROVIDERS` act as platform connections; a connection of the same name overrides them.
- **Tenant namespace**: outside the default tenant, secret references of tenant, team and agent
  connections must start with `<tenant-slug>.`, so a tenant cannot spend another tenant's or the
  platform's keys.
- A connection that cannot be built (secret missing, endpoint refused) does not break other
  providers: runs that use it fail with the real reason (`provider_unavailable`).
- `POST /v1/connections/{id}/test` sends one tiny audited completion (`{ "model": "..." }`).

## Model catalog and prices

The catalog is a **pinned, vendored snapshot** of [models.dev](https://models.dev) (MIT):
`packages/providers/catalog/models.json` plus hand-maintained local models in `local.json`
(Ollama, vLLM, LM Studio, simulated). It is read from disk; agents and the platform never fetch it
at run time. The snapshot records its source URL, licence, date and the SHA-256 of the models.dev
document it was generated from.

- `GET /v1/models?provider=&q=` lists models with context size, output limit and USD per million
  tokens (`source: catalog | override`, overrides from `OAX_PRICE_TABLE`).
- `POST /v1/models/proposals` returns proposed limits and prices **before** a connection is created
  (`{ "provider": "azure-openai", "models": [ { "id": "prod-gpt", "catalogModel": "gpt-4.1" } ] }`;
  without `models` it lists the provider's catalog). On creation every listed model without a price
  gets the proposal; prices you set are kept as overrides (`priceSource: override`). Models the
  catalog does not know are flagged `unknown` and counted as unpriced until you enter a price.
  Local providers default to free of charge.
- Cost lookup order for a model call: the connection's own price (`models[]`), the catalog entry of
  the provider family, then `OAX_PRICE_TABLE`/defaults. Azure deployments and aliases use
  `catalogModel` to borrow limits and prices from a catalog entry.

### Prompt cache prices

A price entry (`OAX_PRICE_TABLE`, catalog) may carry `cacheReadPerMTok` and `cacheWritePerMTok`.
Cache tokens are reported separately from input tokens (`Usage.cacheReadTokens`,
`cacheWriteTokens`). Without explicit prices, cache reads are priced like input tokens and cache
writes at 1.25 x the input price. The catalog schema accepts `cost.cacheRead`/`cost.cacheWrite`;
the pinned snapshot does not carry them yet, so cache prices come from overrides until the next
snapshot refresh. This is groundwork for the model proxy ([ADR 0009](adr/0009-model-proxy.md)).

### Refreshing the snapshot

A scheduled workflow (`.github/workflows/catalog-refresh.yml`, weekly or by hand) downloads
`https://models.dev/api.json` on a GitHub-hosted runner, runs `scripts/import-models-dev.mjs`
(field whitelist, safe ids and names, plausible prices) and opens a pull request that a maintainer
reviews. To do it by hand: download the file, run
`node scripts/import-models-dev.mjs api.json`, review the diff, commit. The models.dev content is
treated as untrusted data and never as instructions.

## Environment providers

`OAX_PROVIDERS` accepts the same objects with an additional `name` (see
[configuration](configuration.md#providers-and-costs)); they are the platform connections of an
installation without database-managed keys.

## Streaming upstream transports

`@openagentix/providers` ships a streaming API next to the non-streaming `ModelProvider.complete`
(ADR 0009, task W1-3b-5). It is a library for the control-node model proxy and is not wired to a
route yet (W1-3b-6). Three transports implement `StreamingTransport.open(request, call)`:

| Transport | Upstream | Provider kinds |
| --- | --- | --- |
| `AnthropicStreamTransport` | Anthropic Messages (`POST /v1/messages`, SSE) | `anthropic` |
| `BedrockStreamTransport` | `InvokeModelWithResponseStream` with the Anthropic body (Anthropic model ids) | `bedrock` |
| `OpenAIStreamTransport` | Chat Completions (`/chat/completions`, SSE), Azure deployment URLs | `openai`, `azure-openai`, `openrouter`, `vllm`, `lmstudio`, `ollama` (`/v1`), `openai-compatible` |

`open()` resolves with an `UpstreamStream`:

- `events` is a pull-based `AsyncIterable<UpstreamEvent>` (`{ event, data }`, parsed JSON). The
  upstream is read only when the consumer asks for the next event, so a slow client slows the
  upstream down (backpressure). Unknown event types are dropped and counted (`result().unknownEvents`).
- `abort(reason)` or the `signal` call option ends the stream on purpose and closes the upstream
  connection. The iteration then ends without an error and `result().abortReason` is set.
- `shouldStop(snapshot)` runs after every event with the live meter; a returned reason aborts the
  upstream request (mid-stream hard stop on output beyond the reservation, revocation, ...).
- `result()` returns the settlement input: normalised `usage` (input tokens exclude cache reads and
  writes, `cacheReadTokens`, `cacheWriteTokens`), `source` (`provider`, `estimated` or `floor`),
  `usageReported` (false means the caller must fall back to its estimator), `complete`, `outputBytes`.
  Output is estimated as `ceil(bytes / 3)` when nothing is reported or the stream was cut, and a
  reported output below `ceil(bytes / 8)` is raised to that floor (`floorApplied`).

Safety properties (all covered by tests against local fake provider servers):

- Limits per call (`limits`): line, event and total bytes, time to first event (120 s), idle time
  **between complete events** (60 s; trickled bytes and comments do not reset it) and a wall clock
  deadline (600 s). Violations end in a `StreamError` (`provider_timeout` for time limits,
  `provider_error` otherwise) with a `reason`; memory stays bounded.
- The request is built from configuration: forced `stream: true` (OpenAI family also
  `stream_options.include_usage: true`), key and headers from options only, `anthropic-beta`
  values from an allowlisted pattern, redirects refused, origin pinned by the guarded fetch, the
  egress policy asserted (also for Bedrock, whose SDK does its own networking).
- Retries (429, 5xx, network) happen only before the first response byte.
- The SSE `event:` line must agree with the payload `type`; unknown content block types and
  malformed frames are errors; `formatSseEvent` splits data on every line terminator and validates
  event names, so payloads cannot smuggle frames to a client.
- Request and response bodies are never logged and never part of an error; error messages carry
  status, type and at most 300 scrubbed characters; configured secrets are replaced by `[redacted]`.
