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
