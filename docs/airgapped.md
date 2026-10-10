# Air-gapped operation

`OAX_AIRGAPPED=true` makes openagentix **fail closed**: the process may only talk to loopback and
to hosts you list explicitly. Nothing is "best effort": a misconfigured endpoint stops the start,
and anything that slips past configuration is refused at the socket level.

## What it does

| Layer | Behaviour |
| --- | --- |
| Start-up self-check | `api` and `worker` refuse to start (`airgap_violation`) when an **enabled** LLM provider (incl. its `proxyUrl`; Anthropic and Bedrock without a custom endpoint point at the public internet), OIDC issuer, LDAP server, OpenTelemetry endpoint, outbound webhook, `HTTP(S)_PROXY`, or a stored **MCP streamable-HTTP connection** is not on `OAX_AIRGAPPED_ALLOW`. The error lists every offender. |
| Stdio MCP servers | A child process is invisible to the network guard (it patches the Node process only). Start-up and connection create/update refuse **platform** stdio connections unless `OAX_AIRGAPPED_STDIO=trusted` (the operator accepts that they share the worker's network) and **tenant** stdio connections unless a `container`/`kubernetes-job` runner is enabled (they run only in run nodes). Their `egress` lists (per-server proxy grants of the container runner) must be plain hosts on `OAX_AIRGAPPED_ALLOW`: wildcards and CIDRs are refused, at save time, at start-up and before each step. Run nodes cannot resolve external names (non-forwarding resolver); on Kubernetes DNS egress needs `OAX_K8S_DNS_EGRESS_ACK=true`. See [`mcp.md`](mcp.md#stdio-mcp-servers) and [`mcp.md`](mcp.md#egress-of-stdio-servers). |
| MCP OAuth | An `oauth` MCP connection contacts its authorization server (discovery, token, revocation). Every endpoint it pins and `auth.issuer` must be on `OAX_AIRGAPPED_ALLOW`: the start-up check lists offenders, authorizing fails with `egress_denied` before any request to a non-allowlisted host, and renewal never contacts an endpoint that moved. Only pre-registered clients work (CIMD and DCR are not offered). See [`mcp.md`](mcp.md#oauth-for-http-mcp-connections). |
| Egress policy | One process-wide policy used by all HTTP clients (providers, MCP gateway, OIDC discovery/JWKS/token, schedule probes), also when a fetch implementation is injected. The *target* host must be allowlisted, with or without a proxy. |
| Connections | Stored connections are checked at start-up (`mcp` streamable-HTTP servers, including their `egress` entries, and BYOK `model` connections, including each kind's public default endpoint such as `api.openai.com` and their proxy). Creating or changing a connection whose endpoint is outside the allowlist is refused with `422 egress_denied`, and `POST /v1/connections/{id}/test` on a connection that predates air-gapped mode fails with an `air-gapped` error instead of reaching out. |
| Network guard | Defence in depth: TCP connect, DNS lookup and UDP send are patched process-wide, so LDAP, the AWS SDK, Kafka and the OTLP exporter cannot reach a non-allowlisted host even if a code path forgot the policy. Each refused attempt is counted. |
| Model catalog | Only the **vendored snapshot** (`packages/providers/catalog/*.json`, read from disk) is used for the model list, price proposals (`POST /v1/models/proposals`) and cost calculation; none of these touches the network (tested: no egress attempt). The weekly refresh is a pull request opened by a GitHub workflow, never a process of the platform, and `scripts/import-models-dev.mjs` reads a local file. A catalog refresh URL (`OAX_CATALOG_REFRESH_URL`) is refused at start-up even when allowlisted. |
| `/readyz` | The API's `GET /readyz` and the worker's `GET /readyz` report `airgapped: { enabled, allowlist, blockedAttempts }` (counts only, never the allowlist content). A `blockedAttempts` above zero means something tried to leave. |

Not covered: your own network. Keep a NetworkPolicy/firewall as the outer wall; this is the inner one.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `OAX_AIRGAPPED` | `false` | Enable air-gapped mode (set by the Helm chart for air-gapped installs). |
| `OAX_AIRGAPPED_ALLOW` | empty | Comma/space separated internal targets: hostnames (`ollama.internal`), domain suffixes (`.corp.example`, `*.svc.cluster.local`), IPs, CIDRs (`10.0.0.0/8`, `fd00::/8`), each with an optional port (`vllm.internal:8000`, `[fd00::1]:443`). Wildcards that match everything (`*`, `0.0.0.0/0`) are rejected. |
| `OAX_CATALOG_REFRESH_URL`, `OAX_WEBHOOK_OUT_URLS` | – | Reserved for outbound features; setting them while air-gapped aborts the start (the refresh never runs, outbound webhooks need an allowlisted host). |

Loopback (`localhost`, `127.0.0.0/8`, `::1`) and the configured **database** and **cache** hosts
are implicitly allowed. Everything else the process contacts must be listed: Kafka brokers of
event sources, the API URL a separate worker uses, in-cluster services.

Typical values:

```bash
OAX_AIRGAPPED=true
OAX_AIRGAPPED_ALLOW="vllm.llm.svc.cluster.local:8000,.keycloak.svc.cluster.local,10.20.0.0/16"
OAX_PROVIDERS='[{"kind":"openai","name":"local","baseUrl":"http://vllm.llm.svc.cluster.local:8000/v1","clearance":"restricted"}]'
```

## OpenTelemetry

Tracing is off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set, and then it follows the same rules as
every other destination ([`observability.md`](observability.md#exporter)):

- With `OAX_AIRGAPPED=true` the endpoint (host **and** port) must be on `OAX_AIRGAPPED_ALLOW`.
  Otherwise `api` and `worker` refuse to start with `airgap_violation`, before the header secret is
  resolved and before an exporter exists. Without an endpoint nothing is created: no provider, no
  socket, no blocked attempt.
- Use an in-cluster collector or a self-hosted backend. A SaaS backend (for example a hosted
  Langfuse or Phoenix) is not reachable and must not be allowlisted for an air-gapped install.
  Plain `http://` to an in-cluster collector needs `OAX_OTEL_INSECURE=true`.
- Exports go through the outbound dispatcher with purpose `telemetry`, so the network file's routes,
  trust bundles and client certificates apply and the network guard stays on as a second wall.
- `OAX_OTEL_TRACE_URL_TEMPLATE` is only a string for the link in `GET /v1/runs/{id}`; the platform
  never fetches it. `OAX_OTEL_MCP_PROPAGATION` stays `deny` unless you want MCP servers to learn
  the run's trace id.

Tenant-owned exporters (`OAX_OTEL_TENANT_EXPORTERS=allow`, connections of type `telemetry`) follow the
same rule and are stricter in one respect:

- The endpoint of a `telemetry` connection must be on `OAX_AIRGAPPED_ALLOW` (host **and** port)
  when it is saved (422 `egress_denied`), a stored connection outside the list stops `api` and
  `worker` from starting (like any stored MCP or model connection), and every request is checked
  again by the dispatcher and the network guard. Nothing is sent to a name that is not on the list,
  and redirects are never followed.
- Tenants may only use `https://` (the tenant destination rules), so an air-gapped tenant exporter
  needs a TLS endpoint inside the allowlist; `OAX_OTEL_INSECURE` is an operator setting for the
  operator's own collector only. Local, private and metadata addresses are refused for tenants
  unless the operator lists a private range in `privateAllow` of the network file.
- Content capture (`OAX_OTEL_CONTENT=redacted`) never widens this: it sends only to those exporters.
  Leave both switches at their defaults (`deny`, `off`) unless a tenant needs its own collector.

```bash
OAX_AIRGAPPED=true
OAX_AIRGAPPED_ALLOW="otel-collector.observability.svc.cluster.local:4318,.keycloak.svc.cluster.local"
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector.observability.svc.cluster.local:4318
OAX_OTEL_INSECURE=true
```

## Verification (what is tested)

- Unit tests of the allowlist (hosts, suffixes, ports, CIDR v4/v6, IPv4-mapped IPv6, wildcard rejection).
- Network guard tests: real TCP connects, `fetch`, DNS (callback and promise) and UDP to the
  internet are refused without any packet or lookup leaving the process; loopback and unix sockets work.
- An integration test (`apps/worker/test/airgap.test.ts`) runs a **complete agent run** (signed
  webhook, queue, worker, simulated provider, policy gate, tools, audit chain, costs) with an
  *empty* allowlist and asserts that the run succeeds and that **zero** egress attempts were
  recorded; a second test proves the guard is live by triggering real attempts that throw.

Tenant-owned exporters are covered by `apps/api/test/telemetry-connection.test.ts` (endpoint refused
outside the allowlist, stored connection checked at start-up in `airgap.test.ts`) and
`apps/api/test/telemetry-tenant.test.ts` (a dispatcher with an air-gapped network sends nothing).

## Offline bundle checklist

1. **Images.** Mirror `ghcr.io/open-agentix/open-agentix-{api,worker,ui}:<version>` (and the
   toolbox images you use, `OAX_TOOLBOX_REGISTRY`) plus PostgreSQL (and Valkey if used) into your
   internal registry. Verify the cosign signature and SBOM attestation **before** transfer
   (`cosign verify`, offline with the bundle) and record digests; pin by digest in the Helm values.
   Image pulls are done by the container runtime, not by openagentix, so they are unaffected.
2. **Model catalog.** Ships inside the image (`packages/providers/catalog/models.json`, dated by
   `snapshotDate`). To use newer prices without refresh, add `OAX_PRICE_TABLE` overrides or build
   an image from a reviewed catalog pull request.
3. **Models.** Provide your own inference endpoint (Ollama, vLLM, an OpenAI-compatible gateway)
   inside the allowlist and set its `clearance`.
4. **License.** Apache-2.0; ship `LICENSE` and `NOTICE` with the bundle. No license server,
   telemetry or phone-home exists.
5. **Docs.** Take `docs/` (this folder), `openapi.yaml` and `CHANGELOG.md` from the same tag; the
   UI contains no external fonts or scripts.
6. **Upgrade path.** Transfer the new signed images and the tag's `CHANGELOG.md`; run the
   migrations Job (`node dist/migrate-cli.js`, only database variables needed) and roll the
   deployments; migrations run under an advisory lock. Check `/readyz` (`airgapped.enabled: true`,
   `blockedAttempts: 0`). Roll back by redeploying the previous digests (restore the database
   backup if the release notes mark the migration as breaking).
