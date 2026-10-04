# ADR 0011: Outbound network: central proxy configuration and private model endpoints

- Status: Proposed
- Date: 2026-10-04
- Plan items: W10-1, W10-2, W10-3 ([implementation plan](../IMPLEMENTATION-PLAN.md), wave 10)
- Builds on: [ADR 0004](0004-provider-abstraction.md) (providers, Bedrock VPC endpoints, proxies),
  [ADR 0008](0008-agents-md-data-flow-and-isolation-contract.md) (run nodes, egress),
  [ADR 0009](0009-model-proxy.md) (model calls leave from the control node)
- Related: [docs/airgapped.md](../airgapped.md), [docs/runners.md](../runners.md) (run-node egress
  proxy, W1-3a / PR #76), [ADR 0010](0010-agent-authoring-builder-and-git-sync.md) (Git sync),
  [ADR 0012](0012-connections-instances-scopes-and-data-protection.md) (connection instances, regions)

## Context

What exists on `main`:

- **Environment proxies.** `packages/providers/src/proxy.ts` resolves `HTTPS_PROXY`,
  `HTTP_PROXY` and `NO_PROXY` explicitly (Node's `fetch` and the AWS SDK ignore them) for LLM
  providers, OIDC and MCP over streamable HTTP. LDAP, Kafka and PostgreSQL are not proxied.
- **Per-provider `proxyUrl`** on every provider setting and BYOK model connection, overriding the
  environment (NO_PROXY still applies). A tenant can set it on its own connection.
- **Bedrock** takes an `endpoint` (VPC interface endpoint) and signs for `region`.
- **Air-gapped mode**: a process-wide egress policy (`OAX_AIRGAPPED_ALLOW`) checks the target host
  of every HTTP client, a network guard patches TCP/DNS/UDP, and start-up refuses configured
  endpoints and `HTTP(S)_PROXY` that are not allowlisted. The Helm chart in air-gapped mode refuses
  an outbound proxy altogether.
- **Run-node egress proxy** (PR #76): a separate CONNECT proxy for tool traffic of run nodes with
  signed per-node grants, an operator ceiling and numeric private-range checks. It has no upstream
  proxy, so in a network where the internet is only reachable through a corporate proxy, step
  egress cannot work.
- **Model proxy** (ADR 0009, in progress): model calls of isolated steps leave from the control
  node (api). In-process steps call providers from the worker.
- **No trust-store configuration.** Custom CAs only through `NODE_EXTRA_CA_CERTS` at process start;
  no client certificates (mTLS) for gateways; nothing prevents a future
  `rejectUnauthorized: false`.

Enterprises asked for: different proxies per destination (one for the internet, none for
PrivateLink, a different one for a partner network), proxy credentials from the secret store, a
corporate CA bundle, mTLS to internal LLM gateways, Bedrock and Azure OpenAI over private
connectivity, and a way for an admin to see and test all of it without opening an SSRF oracle.

## Decision

### 1. One network configuration, one resolver

All outbound traffic of the api and the worker is routed by **one resolver** that reads **one
network configuration**:

```yaml
# OAX_NETWORK_CONFIG_FILE=/etc/openagentix/network.yaml (or OAX_NETWORK_CONFIG as JSON)
proxies:
  - name: corp
    url: http://proxy.corp.example:3128        # http or https (TLS to the proxy)
    authSecret: platform.corp-proxy-auth       # "user:password" or a full Proxy-Authorization value
    caBundle: corp-proxy-ca                    # trust for an https:// proxy (name from trust.bundles)
    tlsInspection: true                        # the proxy terminates TLS (see section 5)
    maxClassification: internal                # data above this never goes through this proxy
  - name: partner
    url: http://proxy.partner.example:8080
trust:
  mode: system+extra                           # or extra-only
  bundles:
    - name: corp-root-ca
      file: /etc/openagentix/ca/corp-root.pem  # or secret: platform.corp-root-ca
clientCertificates:
  - name: llm-gateway
    certSecret: platform.gateway-client-cert
    keySecret: platform.gateway-client-key
routes:                                        # ordered, first match wins
  - match: { hosts: ["*.vpce.amazonaws.com", "*.privatelink.openai.azure.com", ".svc.cluster.local"] }
    via: direct
  - match: { hosts: ["llm-gateway.corp.example"] }
    via: direct
    clientCertificate: llm-gateway
  - match: { hosts: ["*.partner.example"], purposes: [mcp, webhook] }
    via: partner
  - match: { hosts: ["*"] }
    via: corp
tenantSelectable: [corp]                       # proxies a tenant may pick for its own connections
```

- **Purposes** label every outbound call: `model`, `mcp`, `webhook`, `identity` (OIDC, JWKS,
  token, LDAP), `catalog`, `git` (ADR 0010), `probe` (change-gate probes), `telemetry` (OTLP),
  `node-egress` (the run-node egress proxy's upstream, section 7), `test` (section 8).
- `match.hosts` uses the allowlist grammar of `OAX_AIRGAPPED_ALLOW` (host, `.suffix`/`*.suffix`,
  IP, CIDR, optional port) through the same parser; `match.purposes` is optional.
- `via`: `direct`, a proxy name, or `deny` (refuse with `egress_denied`, usable to forbid a
  destination class).
- `resolveRoute(url, purpose, scope) -> { via, proxy?, ca, clientCert?, routeName }` is a pure
  function in `packages/core/src/network/` (no I/O). A dispatcher factory in
  `packages/providers/src/network/` turns the result into an undici `Dispatcher` (direct `Agent` or
  `ProxyAgent`, both with the trust store and optional client certificate) and, for the AWS SDK, a
  `NodeHttpHandler` with matching agents. Dispatchers are cached per `(route, proxy, cert)` key,
  never per tenant credential (proxy credentials are platform secrets).

**Precedence** (highest first): a connection's explicit `network.proxy` selection (a name from
`tenantSelectable`, or `direct` where allowed, ADR 0012), the legacy per-connection `proxyUrl`
(deprecated, section 4), the configured `routes`, the legacy environment
(`HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` become an implicit last route so existing installs behave
exactly as today), direct.

The configuration is a file or an environment value, reviewed and deployed like the rest of the
platform configuration (Helm values, GitOps). The console shows it read-only (section 8); a write
API is not part of this ADR (open question 2).

### 2. Every outbound client uses the resolver

| Client | Today | After |
| --- | --- | --- |
| LLM providers (OpenAI family, Anthropic SDK, Ollama, Bedrock SDK) incl. streaming transports (W1-3b-5) | env or `proxyUrl` | resolver, purpose `model` |
| MCP streamable HTTP | env | resolver, purpose `mcp` |
| OIDC discovery, JWKS, token endpoint | env | resolver, purpose `identity` |
| LDAP/LDAPS | not proxied | not proxied (TCP); `ldaps` uses the trust store; a route with a proxy for an LDAP host is refused at start-up (`network_config_invalid`) |
| Outbound webhooks, output delivery (W3-4), notification channels (W2-5) | env/none | resolver, purpose `webhook` |
| Change-gate probes | env | resolver, purpose `probe` |
| Catalog refresh (`OAX_CATALOG_REFRESH_URL`, never in air-gapped mode) | env | resolver, purpose `catalog` |
| Git sync (ADR 0010) | - | resolver, purpose `git` |
| OTLP exporter | env | resolver where the exporter accepts an agent; otherwise the env mapping is derived from the route for the collector host (documented) |
| Kafka, PostgreSQL, Valkey | direct | direct (not HTTP); trust store applies to their TLS where the client takes a CA |

A lint test fails when a module under `packages/*/src` or `apps/*/src` calls global `fetch`,
`undici.request`, `https.request` or constructs an AWS client without the network factory
(allowlist of exceptions with a reason).

### 3. Trust store and client certificates

- `trust.mode: system+extra` (default) = Node's root store plus the bundles; `extra-only` = only
  the bundles (for fully private PKI). Bundles are PEM files or secret references; they are
  re-read when the file changes (checked at most every 60 s), so CA rotation needs no restart.
- There is **no option to disable certificate verification**. The configuration schema refuses
  `insecure`, `rejectUnauthorized` and similar keys; `NODE_TLS_REJECT_UNAUTHORIZED=0` makes the
  api and worker refuse to start (`airgap_violation`-style start check, code `tls_insecure`).
- Client certificates (mTLS) are attached per route (`clientCertificate`) or per connection
  (`network.clientCertificate`, a name from the platform configuration; tenants cannot upload
  keys in this ADR). Key material is read from secret references, kept in memory only, never
  logged, and redacted like provider keys.
- `servername` (SNI) and certificate host checks always use the destination hostname, also when
  the TCP connection goes to a pinned address (section 6).

### 4. Per-tenant use and the legacy `proxyUrl`

- Tenants never define proxies. A tenant's connection may choose one of the platform's
  `tenantSelectable` proxies by name, or `direct` when the operator allows it
  (`tenantDirect: true`); otherwise the platform routes apply.
- The existing per-connection `proxyUrl` stays accepted for platform connections and env providers
  (deprecated, warning at start-up). On tenant, team and agent connections it is **refused for new
  or changed connections** (`proxy_url_not_allowed`, use `network.proxy`), because a tenant-chosen
  proxy URL receives the tenant's provider key in plain sight for `http://` targets and can point at
  internal hosts. Existing tenant connections with `proxyUrl` keep working until the next change and
  are listed on the Network page.

### 5. Data classification and TLS-inspecting proxies

A proxy marked `tlsInspection: true` sees prompts, responses and provider keys in clear text. The
resolver therefore caps what may pass: a call whose run classification is above the proxy's
`maxClassification` (default for inspecting proxies: `internal`) is refused before connecting
(`classification_exceeds_route`), audited like other egress refusals. The provider's own
`clearance` still applies; the effective clearance is the minimum of both. This is the network
counterpart of ADR 0012's data-flow rule.

### 6. Private destinations, DNS and rebinding

- For **direct** routes the resolver resolves the host once, checks every returned address
  against the private-range policy (`network.privateAllow` CIDRs, operator-only; loopback,
  link-local and metadata addresses never), and connects to the checked address (undici `connect`
  with a custom lookup that returns the pinned addresses; SNI and `Host` keep the name). A second
  lookup between check and connect is impossible, which closes DNS rebinding.
- Platform-configured provider endpoints and routes are trusted operator input; the private-range
  policy is applied to **tenant-supplied** destinations (tenant connections, Git bindings, outbound
  webhooks): their addresses must be public unless the operator opened a range in
  `network.privateAllow` for tenant destinations.
- For **proxied** routes the proxy resolves the name; the platform cannot see the address. The
  documentation says so, and tenant-supplied destinations through a proxy are still checked by
  name against IP-literal and metadata hostnames.
- In air-gapped mode both the target and the proxy host must be on `OAX_AIRGAPPED_ALLOW`; a proxy
  that is allowlisted is legal (an internal forward proxy). The Helm chart's blanket refusal of a
  proxy in air-gapped mode changes to "proxy host must be in the allowlist" (Helm task).

### 7. Interaction with the run-node egress proxy, the model proxy and the network guard

- **Model proxy (ADR 0009)**: model calls of isolated steps leave from the control node, so the
  `model` routes must be configured on the **api**. In-process steps call from the worker; both
  processes load the same file (Helm mounts one ConfigMap/Secret into both). Run nodes never see
  proxy configuration or proxy credentials for model access.
- **Run-node egress proxy (PR #76)**: gains an optional upstream: purpose `node-egress` resolves
  the next hop for each CONNECT target with the same routes. The order of checks in the egress
  proxy is unchanged (operator ceiling, grant, resolved address, air-gap) and runs **before** the
  upstream is chosen; the upstream proxy itself is operator configuration and may be private.
  Proxy credentials for the upstream are given to the egress proxy service only, never to nodes or
  the worker.
- **Child processes** (harnesses, toolbox commands, run nodes) never inherit `HTTP(S)_PROXY`
  variables with credentials: the spawn environment is built from an allowlist and proxy variables
  with userinfo are stripped (a test greps the child environment).
- **Network guard (air-gapped)** stays the inner wall; it now also counts refused proxy hosts.

### 8. Console: Network page (admins) and safe connectivity tests

`Settings > Network` (permission `settings:read` to view, `settings:write` to run tests):

- **Overview**: proxies (name, host, whether auth and inspection are set, never the credential),
  trust bundles (subject, expiry, fingerprint), client certificates (subject, expiry), routes in
  order, air-gapped state and allowlist size, `blockedAttempts`, connections still using the legacy
  `proxyUrl`.
- **Route explain**: `POST /v1/network/resolve { url, purpose }` returns which route, proxy, trust
  mode and client certificate would apply. It is the pure resolver: no DNS lookup, no connection,
  so it cannot be used to probe anything.
- **Connectivity test**: `POST /v1/network/test { target }` where `target` is a **reference to a
  configured destination** (`{ connection: <id> }`, `{ provider: <name> }`, `{ route: <name>,
  probeHost: <host from that route's match list> }`, `{ repository: <binding id> }`), never a free
  URL. The test performs DNS, TCP/proxy CONNECT, TLS handshake and, for HTTP destinations, a
  `HEAD`/`GET` of the destination's fixed health path, and returns only a category:
  `ok`, `dns_failed`, `connect_failed`, `proxy_auth_failed`, `proxy_refused`, `tls_untrusted`,
  `tls_hostname_mismatch`, `client_cert_rejected`, `http_error` (status class only: 4xx/5xx),
  `timeout`, `egress_denied`, plus the route used and a latency bucket (<100 ms, <1 s, >=1 s). No
  bodies, headers, addresses, certificate chains of the destination or exact timings are returned.
  Rate limit 10 per minute per admin, audit `network.tested` (target reference and category).
- Tenant admins get the same test for their own connections (`connections:write`), restricted to
  their tenant's destinations.

### 9. Private model endpoints

| Provider | Private connectivity | Configuration | Notes |
| --- | --- | --- | --- |
| AWS Bedrock | VPC interface endpoint (PrivateLink) for `bedrock-runtime` (and `bedrock` for model listing) | `endpoint` (runtime), new `controlEndpoint` (control plane, optional), new `signingRegion` (default `region`); route `*.vpce.amazonaws.com` `via: direct` | With private DNS enabled on the endpoint the regional hostname resolves privately: no override needed, only a direct route. SigV4 always signs for service `bedrock` and `signingRegion`, independent of the endpoint hostname (tested with recorded signatures). IRSA needs STS: use the STS VPC endpoint and `AWS_STS_REGIONAL_ENDPOINTS=regional`; documented. Streaming (`InvokeModelWithResponseStream`) uses the same handler. |
| Azure OpenAI | Private endpoint + private DNS zone `privatelink.openai.azure.com` | `endpoint` stays `https://<resource>.openai.azure.com`; route `direct` for it | New optional `auth: entra` (workload identity / managed identity token for `https://cognitiveservices.azure.com/.default`) next to `apiKeySecret`; the token endpoint `login.microsoftonline.com` needs its own route (often the corporate proxy) or a private Entra endpoint where available. |
| Google Vertex AI | Private Service Connect endpoint (`*.p.googleapis.com`) | future provider kind `vertex` with `endpoint` override and workload identity federation | Not implemented now; recorded as W10-3 (v1.0) so that the resolver and trust store already fit. |
| OpenAI-compatible gateways (LiteLLM and other LLM gateways, vLLM, Ollama, TGI) | internal URLs | `baseUrl` internal, `network.clientCertificate` for mTLS, `headerSecrets` for gateway keys, trust bundle for the internal CA | Gateways count as providers: clearance and region are set per connection (ADR 0012); the platform still measures cost from the reported usage (ADR 0009). |

### 10. Configuration surface

Environment (api and worker, same values):

| Variable | Meaning |
| --- | --- |
| `OAX_NETWORK_CONFIG_FILE` | path of the YAML/JSON network configuration (re-read on change, validated; an invalid new file is ignored with an error metric and the old one stays) |
| `OAX_NETWORK_CONFIG` | the same as inline JSON (no reload) |
| `OAX_NETWORK_PRIVATE_ALLOW` | CIDRs that tenant-supplied destinations may reach (operator only; default empty) |
| `OAX_NETWORK_TEST_ENABLED` | `true` (default) / `false` to disable connectivity tests |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` | still honoured as the implicit last route |

Helm (`open-agentix-helm`): `network.proxies[]` (with `authSecretRef`), `network.trust.mode`,
`network.trust.bundles[]` (ConfigMap or Secret refs, mounted read-only), `network.clientCertificates[]`
(Secret refs), `network.routes[]`, `network.tenantSelectable`, `network.privateAllow`; the existing
`proxy.httpsProxy/httpProxy/noProxy` map to the legacy route. NetworkPolicy: model provider egress
(`networkPolicy.egress.providers`) must apply to the **api** as well once the model proxy is on;
proxies get their own egress rule. Air-gapped values: a proxy is allowed if its host is in
`airgapped.allow`.

### 11. Threat model

| Threat | Mitigation |
| --- | --- |
| **Proxy credential leakage** (in logs, errors, URLs, child environments, API responses) | Credentials only as secret references; never in a URL that is logged (userinfo redacted in every log and error), never in API responses (the Network page shows "auth: set"), stripped from child process environments, sent only as `Proxy-Authorization` to the proxy (CONNECT for https targets, so the destination never sees it). Tests search logs, errors, audit payloads and child environments for the value. |
| **TLS interception / CA trust** (an inspecting proxy or an added CA reads everything; a malicious bundle enables MITM) | Bundles only from operator configuration; tenants cannot add CAs; bundles listed with fingerprints and expiry; `tlsInspection` caps classification (section 5); no verification switch exists. |
| **SSRF through the test button** | No free URLs: tests take references to configured destinations; results are categories; rate limit and audit; route explain never touches the network. |
| **SSRF through tenant destinations** (connections, Git bindings, webhooks) | Private-range policy on resolved addresses with pinning; metadata addresses always refused; tenant `proxyUrl` refused; redirects to other hosts refused for `git` and `webhook` purposes. |
| **DNS rebinding** | Resolve once, check all addresses, connect to the checked address (section 6); proxied traffic depends on the proxy (documented). |
| **Proxy as an exfiltration path** (a route sends restricted data to a third-party proxy) | Classification cap per proxy; routes are operator configuration; audit of model calls records the route name. |
| **Misconfiguration silently disables air-gap** | Start-up check covers proxies and routes; a route `via: direct` to a non-allowlisted host is refused in air-gapped mode; `/readyz` reports the network config digest. |
| **Downgrade to plain HTTP** | Purposes `model`, `identity`, `git`, `webhook` refuse `http://` targets outside the private allowlist; proxies over `http://` are allowed (CONNECT tunnels TLS end to end) but flagged on the Network page. |

## Consequences

- Positive: one place decides how every request leaves the platform; corporate proxies, private
  endpoints, custom CAs and mTLS become configuration, not code; admins can see and test it safely.
- Positive: model calls through PrivateLink or private endpoints are first-class and documented.
- Negative: every outbound client has to be migrated to the factory (one lint rule enforces it);
  the AWS SDK path needs its own handler.
- Negative: the tenant-level `proxyUrl` is removed for new tenant connections (pre-1.0 behaviour
  change, listed in the changelog).
- Negative: DNS pinning means a change of a destination's addresses takes effect on the next
  connection, not mid-connection; long-lived streams keep their address.

## Alternatives considered

- **Keep environment variables only** (`HTTPS_PROXY`/`NO_PROXY`): cannot express per-destination
  proxies, credentials from secrets, CAs per route or mTLS. Rejected.
- **A sidecar proxy (Envoy) for all egress**: powerful, but another component to operate, and the
  platform would still need classification-aware decisions. Possible on top (point a route at it).
- **PAC files**: JavaScript evaluation at run time, poor reviewability. Rejected.
- **Tenants define their own proxies**: SSRF and key exposure. Rejected; tenants pick from
  operator-defined proxies.
- **A free URL test with a private-range check**: still an oracle for open ports and timing.
  Rejected.

## Open questions

1. Should `tenantDirect` default to `true` outside air-gapped mode (today tenants connect directly)?
2. A write API for the network configuration (audited, versioned), or file/Helm only?
3. Vertex AI priority: on the roadmap for v1.0 or earlier?
4. Azure Entra ID authentication for Azure OpenAI in W10-2, or as a separate item?
5. Should an `http://` proxy (CONNECT) be refused in production profiles, requiring `https://`
   proxies?
