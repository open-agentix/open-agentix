# ADR 0016: MCP egress and authorization: per-connection network rules, contained stdio servers, pinned tool definitions and OAuth 2.1 for MCP connections

- Status: Proposed
- Date: 2026-10-10
- Plan items: W5-5 (#47, "MCP catalog governance: review states, per-server egress and container
  MCP servers"), W12-1 (#113, #114); abuse suite W1-3b-10. Ideas 9 and 10 of the competitive
  landscape review; slice issues #230 to #238 (egress for everything in a node, including MCP servers and setup steps; MCP
  authorization specification for MCP connections)
- Builds on: [ADR 0008](0008-agents-md-data-flow-and-isolation-contract.md) (run nodes, credential
  broker, egress proxy), [ADR 0011](0011-outbound-network-proxies-and-private-endpoints.md)
  (outbound resolver and dispatcher, purposes, DNS pinning),
  [ADR 0012](0012-connections-instances-scopes-and-data-protection.md) (connection types and
  instances, central grants, data keys)
- Amends: ADR 0012 (adds `egress`, `auth` and the tool snapshot to MCP connection instances; decides
  its open question 2 in favour of a control-node MCP relay)
- Related: [ADR 0015](0015-opentelemetry-genai-tracing.md) (MCP trace propagation, metadata-only
  telemetry), [docs/mcp.md](../mcp.md), [docs/airgapped.md](../airgapped.md),
  [docs/runners.md](../runners.md), [docs/security-input-hardening.md](../security-input-hardening.md),
  issues #29 (toolbox supply chain), #100 (clients to the outbound dispatcher), #140 (test code UID)
- External references (read as reference data only): MCP specification, revision 2026-07-28,
  "Authorization" with its pages "Authorization Server Discovery", "Client Registration" and
  "Security Considerations"; OAuth 2.1 (draft-ietf-oauth-v2-1-13); RFC 6750, RFC 7591, RFC 8414,
  RFC 8707, RFC 9207, RFC 9728; OAuth Client ID Metadata Document (draft-00).

## Context

### Why now

A hosted coding agent we compared against ships an egress firewall for its agent process, but the
firewall did not cover MCP servers or the repository's setup steps: both could reach any host. The
lesson for us is a design rule, not a feature: **an egress rule must hold for every process that
runs on behalf of a step**, and we must be able to prove it with a test that counts connections.
Separately, the MCP authorization specification now defines how an MCP client obtains
audience-bound OAuth tokens (protected resource metadata, resource indicators, PKCE). Our MCP
connections only know static header secrets.

### What exists on `main` (commit `9a3ff92`, verified)

**MCP connections** (`packages/mcp/src/config.ts`, `apps/api/src/services/catalog.ts`):

- Three transports: `stdio` (`command`, `args`, `env`, `envSecrets`), `streamable-http` (`url`,
  `headers`, `headerSecrets`) and `in-memory` (host-registered, tests and demo). Tools are declared
  with an access class and grouped into profiles (ADR 0008 section 1.3, `docs/mcp.md`).
- `prepareConfig` validates the schema, the tenant prefix of secret references and, in air-gapped
  mode only, the URL of a streamable-HTTP server against `OAX_AIRGAPPED_ALLOW`. There is **no
  private-range or metadata check** on a tenant's MCP URL (model connections have one:
  `blockPrivateDestinations` in `services/models.ts`), and there is no connection test for MCP
  (`POST /v1/connections/{id}/test` sends a model completion).
- **Any tenant admin can create a `stdio` connection with any `command`** (the schema comment says
  "pinned binary, never `npx <latest>`", nothing enforces it; `apps/api/test/run-nodes.test.ts`
  creates tenant stdio connections with `command: 'x'` and expects 201).

**Where MCP servers run and what network they get:**

| Situation | Process | Network today | Gap |
| --- | --- | --- | --- |
| In-process step (`runner: in-process`, default), `stdio` | child of the **trusted worker** (`apps/worker/src/worker.ts` builds a `ToolGateway` from `catalog.mcpConfigs`) | the worker's network: unrestricted outside air-gapped mode | A tenant-defined command runs next to the worker's database credentials and run-token secret, with full egress. The air-gapped network guard patches sockets of the **Node process only**; a child process is not covered, and `connectionEndpoints` (`apps/api/src/airgap.ts`) returns nothing for stdio, so the start-up check does not see it. |
| In-process step, `streamable-http` | worker | `createProxyAwareFetch` (environment proxies), not the ADR 0011 dispatcher | No DNS pinning, no private-range check for tenant URLs, redirects follow fetch defaults. Migration to the dispatcher is open (ADR 0011 amendment 3, #100). |
| Run node (`container`), `stdio` | child of the run node inside the toolbox image | internal Docker network; exits only via the egress proxy with the **step's** grant | The child receives `HTTPS_PROXY` with the node's proxy account (`mergeCredentials` in `apps/worker/src/run-node.ts`), so every stdio server of a step can reach every host of the step's `runtime.egress`. There is no per-server rule. Children share the node's UID (#140), so they can read each other's environment. |
| Run node, `streamable-http` | run node | via the egress proxy, host must be in `runtime.egress` | Nothing checks at publish that the MCP host is in the step egress (runs fail late); the broker hands the node the **header secret values** (`StepCredentials.connections[].headers`). |
| Run node (`kubernetes-job`) | Pod | per-node NetworkPolicy from CIDRs; host names are not opened (handed to an egress gateway as `OAX_EGRESS_ALLOW`); optional `dnsEgress` to kube-dns | With `dnsEgress: true` the cluster resolver forwards any name, which is a DNS exfiltration channel. |
| Container runner DNS | Docker embedded resolver on the internal network | not configured by the runner | Whether external names resolve from an `internal: true` network is not tested. |

**The egress proxy** (`packages/runners/src/egress-proxy.ts`) is solid: CONNECT only, signed
per-node grants, operator ceiling, every resolved address checked (private, metadata, loopback,
link-local refused unless the operator opens a range), connection to the checked address
(`addresses[0]`), tunnel caps and idle timeouts.

**Setup steps.** The platform has **no run-time setup phase**: no `npm install`, no package download
before a step. Toolbox images are built in CI with pinned versions (`toolboxes/README.md`; signing
and SBOM are #29). The workspace `run_tests` tool runs a fixed command inside a node without egress
(ADR 0008 amendment 2). This is the right baseline, but it is a convention: nothing stops a stdio
connection with `command: npx` and `args: ["-y", "some-server@latest"]` from installing code at run
time.

**Tool definitions.** `McpConnection.listTools()` caches the list per connection object (per run);
`ToolGateway.exposedTools` guards descriptions and schemas with `ContextGuard` (invisible Unicode,
known secret values) and never trusts annotations to widen access. Nothing records **what** a tool
description said when a version was published: a server can change descriptions or schemas later
("rug pull"), and the next run sends the new text to the model.

**Credentials.** Static only: secret references resolved by the static resolver (environment or
files) and delivered by the credential broker (ADR 0008 section 2). The platform stores **no**
credential values in its database today. Platform secrets are never brokered to nodes
(`platform_secret`). ADR 0012 open question 2 (a control-node MCP relay) is undecided.

**Telemetry** (ADR 0015 S8): MCP trace context propagation is opt-in and default off; spans are
metadata only.

## Decision

### 1. Principles

1. **One rule for every process of a step.** Whatever a step can start (toolbox binaries, stdio
   MCP servers, test commands, harness CLIs) is inside the same network boundary, and that boundary
   is enforced by the network (container network, egress proxy, NetworkPolicy), not by a library
   inside the process.
2. **Deny by default, per connection.** An MCP server reaches exactly the destinations of its
   connection, nothing else; a step's `runtime.egress` is for its own toolbox binaries.
3. **Tenant code never runs in a trusted process.** The api and the worker never spawn a
   tenant-defined command.
4. **No installation at run time.** Code reaches a node only through a digest-pinned image.
5. **Credentials stay where the trust is.** OAuth tokens and long-lived MCP secrets live in the
   control node; run nodes and models never see them.
6. **What was reviewed is what runs.** Tool definitions are pinned at publish and re-approved on
   change.

### 2. Threat model

| # | Threat | Today | Mitigation (section) |
| --- | --- | --- | --- |
| T1 | **Malicious or compromised MCP server** (supply chain update, hijacked vendor) reads data it should not and sends it out | stdio server has the step's (or the worker's) egress; HTTP server can return anything | per-connection egress (4), contained stdio (3), result guarding (existing), relay keeps tokens out of reach (6) |
| T2 | **Tool poisoning**: instructions hidden in tool names, descriptions or schemas | ContextGuard strips invisible Unicode and secrets | review at publish with the pinned snapshot (5); descriptions stay data, never system text; the snapshot is shown to the reviewer |
| T3 | **Rug pull**: definitions change after approval | not detected | digest of the granted tools pinned in the version; mismatch fails closed until re-approval (5) |
| T4 | **SSRF via MCP URLs, metadata URLs and redirects** (tenant points a connection at `169.254.169.254`, an internal admin API, or a server that redirects there; PRM or AS metadata names internal hosts) | only the air-gapped allowlist | tenant-destination checks at save and at connect, DNS pinning, `redirect: 'error'`, discovery fetches through the dispatcher with size and time limits (4.3, 7.3) |
| T5 | **DNS rebinding** between check and connect | proxy pins; worker path does not | dispatcher pinning for all MCP and discovery traffic (4.3); nodes cannot resolve names themselves (4.5) |
| T6 | **DNS exfiltration** from a node (data in query names) | kube-dns optional; Docker untested | no external resolution from nodes (4.5) |
| T7 | **Token theft**: access or refresh tokens leak via node memory, child environment, logs, audit payloads, tool results, model context, errors, telemetry | n/a (no tokens) | tokens only in the control node and trusted worker, encrypted at rest, registered with ContextGuard and the redactor, never in any API response (6, 7.5) |
| T8 | **Confused deputy**: the platform (one OAuth client) obtains tokens that one tenant can use against another tenant's resources, or a malicious AS tricks the platform into sending a code or token to it (mix-up) | n/a | tokens keyed by tenant, connection and credential version; issuer pinned per connection; RFC 9207 `iss` check; `state` and PKCE; consent per connection; no user-delegated tokens on central instances (7) |
| T9 | **Token passthrough**: a token issued for the platform (console login, OIDC) or for another resource is forwarded to an MCP server, or an MCP server forwards ours upstream | static headers can hold any token | the platform never forwards its own inbound tokens; OAuth tokens are requested with `resource` = the server's canonical URI and used only for that URI (7.4); the operator documentation warns that `headerSecrets.authorization` must hold a credential issued for that server |
| T10 | **Cross-tenant connection use** | platform connections visible to all tenants (ADR 0012 gap) | ADR 0012 grants; OAuth tokens never shared across tenants; central OAuth instances use client credentials only (7.6) |
| T11 | **Prompt injection through tool results** | ContextGuard, least privilege, typed handovers | unchanged (ADR 0008, `docs/security-input-hardening.md`); egress per connection limits what an injected step can send out; token values registered with the guard so a server echoing them is redacted |
| T12 | **stdio server escapes via the network** (opens sockets, ignores `HTTPS_PROXY`, uses another child's proxy account) | in-process: unrestricted; node: step egress | no stdio for tenants in trusted processes (3); per-server proxy accounts (4.2); container isolation for servers that need a strong wall (3.3) |
| T13 | **Supply chain of MCP server images and binaries** (runtime `npx`/`uvx`, mutable tags) | convention only | command allowlist, refusal of run-time installers, images by digest with signature checks (3.2, #29) |
| T14 | **Setup phase as a side door** (dependency install with open network before the "real" run) | no setup phase exists | rule 4: no run-time installation; if a setup phase is ever added, it gets its own narrower egress and ends before credentials are issued (4.4) |

### 3. Containing stdio MCP servers

#### 3.1 Where stdio may run

- **Platform connections** (operator-defined) may use `stdio` in-process: the command is operator
  configuration, like any other binary in the worker image.
- **Tenant, team and agent connections** with `transport: stdio` run **only in run nodes**
  (`container`, `kubernetes-job`). Publish refuses a step on `in-process` or `local` that holds a
  grant on such a connection (`mcp_stdio_requires_isolation`); the worker repeats the check before
  building the gateway and fails the step with the same code (second wall, also for versions
  published before the change).
- `in-memory` stays host-registered only.

#### 3.2 What may be started

- `command` must be an **absolute path** and must match the operator allowlist
  `OAX_MCP_STDIO_COMMANDS` (paths or `prefix/*`, default: the binaries shipped in the platform and
  toolbox images, such as `/usr/local/bin/oax-workspace`). A catalog type (ADR 0012) may name its
  command; tenant instances inherit it and cannot change it.
- Refused regardless of the allowlist (`mcp_command_forbidden`): shells (`sh`, `bash`, `zsh`,
  `dash`, `busybox`, `env`), interpreters with an inline program flag (`node -e`, `python -c`,
  `deno eval`), and run-time installers (`npx`, `npm exec`, `pnpm dlx`, `yarn dlx`, `bunx`, `uvx`,
  `pipx run`, `docker`, `podman`, `curl`, `wget`).
- `env` keys follow the reserved-name rules of `agents[].credentials` (ADR 0008 section 1.4: no
  `PATH`, `LD_*`, `NODE_OPTIONS`, proxy variables, `OAX_*`).

#### 3.3 Container MCP servers (W5-5)

A new transport `container` (`image` by digest, `args`, the same `env`/`envSecrets`) runs the
server as a **sibling container** of the run node on its own internal network, with its own egress
grant, its own UID and the isolation profile of ADR 0008 section 3.5. The node talks to it over a
per-step unix socket or loopback port. This is the strong wall for servers the operator does not
trust (any third-party server); stdio inside the node (3.2) remains for small, reviewed binaries
shipped in the toolbox image. On Kubernetes a NetworkPolicy applies to a whole Pod, not to one
container, so a container server runs as its own Pod with its own NetworkPolicy, labelled with the
run and node (detail in the slice).

### 4. Egress model

#### 4.1 Per-connection egress

MCP connection instances get `egress: string[]` (grammar of `runtime.egress`, `parseEgressEntry`):

- `streamable-http`: implicitly the origin of `url`; listing it is optional. Additional entries are
  refused (an HTTP server is contacted at its URL, nothing else). For OAuth (section 7) the
  authorization server endpoints pinned at consent are added automatically with purpose `identity`.
- `stdio` and `container`: the hosts the server itself needs (for example `api.jira.example.com`).
  Empty means **no network**.
- Effective egress = connection egress, within the operator ceiling (`egressAllow` of the runner,
  `assertWithinCeiling`) and, in air-gapped mode, within `OAX_AIRGAPPED_ALLOW`. A catalog type can
  declare the egress of its instances (tenants may narrow, never widen; same floor rule as tool
  classes).
- A step's `runtime.egress` no longer has to include MCP hosts. It applies to the step's own
  toolbox binaries only.

#### 4.2 Enforcement per execution path

| Path | Enforcement |
| --- | --- |
| HTTP MCP, in-process | the ADR 0011 dispatcher, purpose `mcp`, scope = the connection's tenant; tenant origin pinned, private and metadata ranges refused, `redirect: 'error'`, 64 MiB response cap; the request URL must be the connection URL's origin (`mcp_egress_denied` otherwise) |
| HTTP MCP, run node | the **control-node MCP relay** (section 6): the node never connects to the server; the relay uses the in-process path above |
| stdio in a node | per-server proxy account: the runner mints one egress grant per `(node, connection)` with the connection's effective egress and passes it **only** to that child (`HTTPS_PROXY` of that child); the step's own account is no longer passed to MCP children; a child with empty egress gets no proxy variables |
| container MCP server | own internal network and own grant (container runner); own Pod and NetworkPolicy (Kubernetes) |
| platform stdio, in-process | operator responsibility; documented: in-process stdio servers share the worker's network; in air-gapped mode the start-up check refuses platform stdio connections unless `OAX_AIRGAPPED_STDIO=trusted` is set (the guard cannot see child sockets) |

Residual risk (accepted until #140): stdio children in one node share a UID and can read each
other's proxy account from `/proc/<pid>/environ`; the per-server account therefore stops honest and
buggy servers and simple supply-chain payloads, not a determined attacker in the node. Untrusted
servers belong in containers (3.3). The documentation says so.

#### 4.3 Destination checks at save time and at connect time

- Creating or changing a tenant MCP connection runs the ADR 0011 tenant-destination checks on the
  URL and on every egress entry: no IP literals in metadata or private ranges, no `localhost`, no
  non-canonical numeric spellings; TLS only (`https://`) for tenant servers (already decided in ADR
  0011 amendment 2 item 6). Refusal: `422 egress_denied` with the resolver code.
- At connect time the dispatcher resolves once, checks every address and connects to the checked
  address (rebinding closed). Behind a proxy the ADR 0011 residual risk (the proxy resolves again)
  applies and is reported in the audit record (`proxyResolves: true`).
- `POST /v1/connections/{id}/test` gains an MCP mode (`initialize` + `tools/list`, categorized
  result as in ADR 0011 section 8; never a body, never a description). It is the only way to fetch
  a tool snapshot for review (section 5).

#### 4.4 Setup and run phases

- **Rule:** dependencies, MCP server binaries and language runtimes are installed at **image build
  time** in CI (toolbox supply chain, #29), never during a run. Section 3.2 enforces it for stdio
  commands; toolbox images keep "no package manager in the final image".
- If a setup phase is introduced later (for example dependency installation for workspace tests),
  it must be a separate phase of the node with its own `runtime.setup.egress` (package mirror
  only, operator ceiling `OAX_SETUP_EGRESS_ALLOW`), it runs **before** the credential broker issues
  anything and before any MCP server or model call, and its egress grant is revoked (grant expiry
  plus proxy-side revocation by node id) before the run phase starts. The egress test (section 10)
  must prove zero connections from the run phase to setup destinations. Until then a `setup` key in
  `agents.md` is refused by the strict schema (as today).

#### 4.5 DNS

- Run nodes do not resolve external names: the egress proxy resolves (CONNECT by name). The
  container runner sets the node's DNS to a non-forwarding resolver (`Dns: ["127.0.0.1"]` with no
  listener, or the runner's own stub that answers only the control node and the proxy names); a
  test proves that resolving an external name from a node fails.
- Kubernetes: `dnsEgress` stays off by default; turning it on is documented as an exfiltration
  channel and requires `OAX_K8S_DNS_EGRESS_ACK=true`; recommended alternative is an egress gateway
  that resolves.
- In air-gapped mode the existing network guard covers DNS of the Node processes; nodes are covered
  by the rule above.

#### 4.6 Air-gapped mode

- Stored MCP connections: URL, egress entries and pinned authorization server endpoints must be on
  `OAX_AIRGAPPED_ALLOW` (start-up check extended from the URL to all three).
- OAuth discovery and token requests use the same allowlist; Client ID Metadata Documents (7.2)
  need the authorization server to fetch our document, which an air-gapped installation usually
  cannot offer: there, pre-registered clients only.
- Platform stdio connections: see 4.2.

### 5. Pinning and change detection for tool definitions

- **Snapshot.** For each MCP connection the control node stores tool snapshots
  (`mcp_tool_snapshots`: `connection_id`, `digest`, `tools` (jsonb), `status: pending | approved |
  rejected`, `fetched_at`, `approved_by`, `approved_at`). `digest` = SHA-256 over the RFC 8785
  canonical JSON of the list of tools, each reduced to `{ name, title, description, inputSchema,
  outputSchema, annotations }`, sorted by name. A snapshot is fetched by the MCP test (4.3) or by
  `POST /v1/connections/{id}/tools/refresh`; it is `pending` until an admin approves it in the
  console after seeing the definitions (guarded text, with a diff to the last approved snapshot).
- **Publish.** The profile expansion (ADR 0008, `docs/mcp.md`) additionally records, per
  connection, `toolsDigest`: the digest over the **granted** tools of the latest approved snapshot.
  Publish refuses when no approved snapshot exists (`mcp_tools_unreviewed`) or when a granted tool
  is not in it (`mcp_tool_unknown`). The value is part of `expansionDigest`.
- **Run.** When the gateway first lists tools in a session it computes the digest over the granted
  tools it actually received. If it differs from the version's `toolsDigest`, the gateway exposes
  **none** of that connection's tools and the step fails with `mcp_tools_changed` (fail closed);
  audit `mcp.tools.changed` with connection, old and new digest and the names of changed tools
  (never descriptions); a notification goes to the connection's admins; the live list is stored as
  a new `pending` snapshot.
- **Re-approval.** An admin approves the new snapshot with one of two scopes: `new-versions` (only
  versions published afterwards use it) or `existing-versions` (allowed only when names and access
  classes of the granted tools are unchanged; then every published version that pinned the previous
  digest accepts the new one; the version stays immutable, the acceptance is a connection-level
  record `mcp_tool_snapshot_acceptances (connection_id, from_digest, to_digest, by, at)`). Both are
  audited (`mcp.tools.approved`).
- **During a session** the list is fetched once and never re-read; `notifications/tools/list_changed`
  is ignored for the running step (already true: `McpConnection` caches the list).
- Changes to tools that are not granted do not affect the digest and are only shown in the console.

### 6. Control-node MCP relay (decides ADR 0012 open question 2)

- `POST /v1/worker/runs/{id}/mcp/{server}` with the step-scoped run token: body is one MCP request
  (`tools/list` or `tools/call`), response is the guarded result. The api checks the session, that
  `server` is a connection of the step, the policy gate decision for `tools/call` (the gate already
  runs on the control node for nodes), the tool digest (5), and then calls the server through the
  in-process path of 4.2 with credentials it resolves itself.
- Every `streamable-http` connection used by a run node goes through the relay. Consequences: the
  node needs no egress for HTTP MCP servers, the broker no longer hands out `headerSecrets` values
  (only `envSecrets` for stdio servers), OAuth tokens never leave the control node, and central
  shared-credential HTTP instances become usable by run nodes (ADR 0012 section 3 table, column
  "central instance") without `central_mcp_node_unsupported`.
- Limits: per-session concurrency (4), per-call timeout (connection `timeoutMs`), result cap
  (`maxResultBytes`), rate limit per session; MCP sessions are per run and per connection, keyed
  `(tenant_id, connection_id, credential_version, run_id)` as ADR 0012 section 4 requires.
- Streaming results and server-initiated requests (sampling, elicitation) are not relayed in v1; a
  server that requires them fails the call with `mcp_capability_unsupported`.

### 7. Authorization for HTTP MCP connections (OAuth 2.1 per the MCP specification)

#### 7.1 Connection `auth`

```jsonc
{
  "transport": "streamable-http",
  "url": "https://mcp.example.com/mcp",
  "auth": {
    "kind": "oauth",                         // "none" | "static" | "oauth"
    "grant": "client_credentials",           // or "authorization_code"
    "client": {
      "registration": "preregistered",       // "preregistered" | "cimd" | "dcr"
      "clientIdSecret": "acme.jira-client-id",
      "clientAuth": "private_key_jwt",       // "private_key_jwt" | "client_secret_basic" | "none"
      "keySecret": "acme.jira-client-key"     // or "clientSecretSecret"
    },
    "scopes": "from-profiles",               // or an explicit list
    "issuer": "https://auth.example.com"     // optional pin; filled at first discovery otherwise
  }
}
```

- `static` is today's `headerSecrets` (kept, see 9). `oauth` and `headerSecrets.authorization`
  together are refused (`auth_conflict`).
- Secrets for the client (id, secret, private key) are **secret references** (tenant prefix rules
  unchanged). Tokens are not configuration; they are stored state (7.5).

#### 7.2 Flows

| Flow | Use | Notes |
| --- | --- | --- |
| **Client credentials** (`client_credentials`) | service connections: event-driven runs with nobody present; the default | Defined as an MCP authorization extension, not in the core flow; supported because most runs are unattended. `private_key_jwt` preferred over a client secret. On `insufficient_scope` the call fails (`mcp_insufficient_scope`); no automatic step-up. |
| **Authorization code + PKCE** (`authorization_code`) | the remote system requires a user's consent (SaaS MCP servers without machine clients) | An admin with `connections:write` performs the consent once per connection instance in the console. PKCE `S256` always; the platform refuses an authorization server whose metadata lacks `code_challenge_methods_supported` with `S256` (as the specification requires). `state` (CSPRNG, single use, 10 min), the expected `issuer` and the code verifier are stored server-side with the pending request; the callback checks `state` and, per RFC 9207, `iss` (reject on mismatch; reject when the server advertises `authorization_response_iss_parameter_supported` and `iss` is missing). Redirect URI: `https://<OAX_PUBLIC_URL>/v1/oauth/mcp/callback`, exact match. The resulting tokens belong to the **connection instance**, not to the user; the console shows "authorized by <user>, at <time>, scopes". Step-up: on `insufficient_scope` the connection shows "re-authorization needed" with the union of scopes; runs fail closed until an admin re-authorizes. |
| Per-end-user delegation (token of the user who triggered a run) | not in v1 | Runs are mostly event-triggered; see open question 3. |

Client registration, in the specification's priority order:

1. **Pre-registered** (`preregistered`): the operator or tenant registers a client at the
   authorization server and stores the references. Always available; the only option in air-gapped
   mode.
2. **Client ID Metadata Document** (`cimd`): the platform publishes one document per installation
   at `https://<OAX_PUBLIC_URL>/oauth/mcp-client.json` (`client_id` equals that URL, `client_name`,
   `redirect_uris` = the callback, `grant_types: [authorization_code, refresh_token]`,
   `token_endpoint_auth_method: none` or `private_key_jwt` with a platform JWKS). Used only for
   `authorization_code` and only when the authorization server advertises
   `client_id_metadata_document_supported`. Needs a public URL, so it is off unless
   `OAX_MCP_OAUTH_CIMD=true`.
3. **Dynamic client registration** (`dcr`, RFC 7591): deprecated by the specification; off by
   default (`OAX_MCP_OAUTH_DCR=false`). When on: one registration **per tenant and authorization
   server** (never shared across tenants), `application_type: web`, stored like a pre-registered
   client (7.5), audited; the registration endpoint must pass the tenant-destination checks.

Client credentials are bound to the authorization server's `issuer` (specification:
"Authorization Server Binding"): if the protected resource metadata later names another issuer,
the platform refuses to use the stored client and marks the connection `reauthorization_required`.

#### 7.3 Discovery with SSRF-safe fetching

- Order per the specification: an unauthenticated `initialize` that returns `401` with
  `WWW-Authenticate: Bearer resource_metadata=...` (and optional `scope`); otherwise the well-known
  URIs `/.well-known/oauth-protected-resource/<path>` then `/.well-known/oauth-protected-resource`
  (RFC 9728). Then authorization server metadata: RFC 8414 with path insertion, OIDC discovery with
  path insertion, OIDC discovery with path appending (or the two root forms for an issuer without
  a path).
- **Every** discovery request goes through the ADR 0011 dispatcher with the connection's tenant
  scope (purpose `mcp` for the resource metadata, `identity` for authorization server metadata,
  token, registration and JWKS endpoints): HTTPS only, DNS pinning, private/metadata ranges refused
  for tenant connections, `redirect: 'error'`, response limit 64 KiB, timeout 5 s, `application/json`
  only, strict parsers (unknown fields ignored, wrong types refused).
- Additional checks: `resource` in the protected resource metadata must equal the connection's
  canonical URI (RFC 9728 section 3.3; mismatch: `mcp_resource_mismatch`); the
  `resource_metadata` URL must be on the MCP server's origin unless the connection lists another
  origin explicitly; the `issuer` in authorization server metadata must equal the issuer used to
  build the URL; the selected issuer must be in `auth.issuer` when pinned, otherwise it is pinned at
  first successful authorization and shown to the admin; authorization, token, registration and
  JWKS endpoints must be HTTPS and pass the tenant-destination checks, and they become part of the
  connection's effective egress (purpose `identity`). A later change of any of them requires
  re-authorization.
- Discovery results are cached per connection (max 1 h, never across tenants) and re-fetched on a
  `401` with a different `resource_metadata`.

#### 7.4 Audience, resource binding and passthrough

- Every authorization and token request carries `resource` = the canonical URI of the connection
  (lower-case scheme and host, no fragment, no trailing slash unless significant), also when the
  authorization server does not advertise support (RFC 8707, as the specification requires).
- A token is used only for requests to that exact canonical URI. Changing the connection `url`
  bumps `credential_version` and deletes the stored tokens.
- The platform never forwards a token it received (console sessions, OIDC tokens, API tokens,
  webhook signatures) to an MCP server, and the policy gate's own MCP server (`gate-http`) accepts
  only its loopback token and forwards nothing. Token exchange (RFC 8693) is not part of this ADR.
- The platform does not validate the audience of access tokens it receives from an authorization
  server (they are opaque to the client); audience validation is the server's duty. The console
  shows a warning when the authorization server does not list `resource` support.

#### 7.5 Token storage, refresh and revocation

- Table `mcp_oauth_tokens`: `tenant_id`, `connection_id`, `credential_version`, `issuer`,
  `client_ref` (registration row or secret reference), `resource`, `scopes`, `access_token_enc`,
  `refresh_token_enc`, `expires_at`, `status` (`active | refresh_failed |
  reauthorization_required | revoked`), `authorized_by`, `authorized_at`. Table
  `mcp_oauth_clients` for DCR results (per tenant and issuer, secret encrypted).
- **Encryption**: AES-256-GCM envelope encryption with the tenant's data key (ADR 0012 section 7.6,
  `tenants.data_key_id`); additional authenticated data = `tenant_id | connection_id | issuer |
  resource | credential_version`, so a ciphertext copied to another row does not decrypt. The
  key-encryption key comes from operator configuration first and from a KMS (customer-managed keys,
  owner decision for v1.0) later; destroying the tenant key makes the tokens unreadable
  (crypto-shredding). This is the first stored credential value of the platform; until ADR 0012
  slice W12-2 delivers tenant data keys, slice S6 of this ADR provides the minimal key service
  (one platform key-encryption key, one data key per tenant) that W12-2 then extends.
- **Who can read tokens**: the api (relay, refresh) and the trusted worker (in-process steps) via
  one internal service `McpCredentials.accessToken(connection, scope)`; never a run node, never a
  harness, never an API response, never the model context. Values are registered with the run's
  `ContextGuard` and the log redactor before use.
- **Refresh**: single flight per `(connection_id, credential_version)` under a PostgreSQL advisory
  lock; refresh 60 s before expiry; rotated refresh tokens are written atomically with the new
  access token; `invalid_grant` sets `reauthorization_required`, fails new calls closed
  (`mcp_auth_required`) and notifies the connection's admins. Access tokens are not cached in
  process memory beyond one call and never across tenants.
- **Revocation**: deleting or disabling a connection, revoking a grant (ADR 0012), rotating the
  client secret, changing the URL or issuer, and an admin's "disconnect" delete the stored tokens
  and call the authorization server's revocation endpoint (RFC 7009) when advertised (best effort,
  audited result).

#### 7.6 Tenancy

- Tokens and DCR clients are never shared across tenants; the key includes `tenant_id`.
- Central (platform) instances (ADR 0012 section 2): `client_credentials` only, with the
  `dataScope` rules of ADR 0012; `authorization_code` on a central instance is refused
  (`central_user_delegation`), because a human's consent cannot be shared with other tenants.
- Tenant instances may use either grant; pre-registered client references follow the tenant secret
  prefix rules.

#### 7.7 Scope minimisation per tool profile

- `scopes: "from-profiles"` (default) derives the requested scopes from the tools the connection's
  profiles contain: a catalog type maps tools to scopes (`tools.<name>.scopes`); for `custom-mcp`
  instances the admin declares the mapping. Without a mapping the platform requests the `scope`
  from the `WWW-Authenticate` challenge, else `scopes_supported` from the protected resource
  metadata (the specification's order), and shows the result for confirmation.
- A connection whose profiles are all `read` requests only the scopes of read tools; the console
  shows when the granted scopes exceed what the profiles need (a lint warning, `mcp_scope_wider`).
- `offline_access` is requested only for `authorization_code` and only when advertised.

#### 7.8 Audit entries (names and ids only, never values)

`mcp.oauth.discovered` (connection, issuer, resource, endpoint hosts), `mcp.oauth.authorized`
(connection, issuer, grant, scopes, by), `mcp.oauth.refreshed` (connection, outcome),
`mcp.oauth.refresh_failed` (connection, error code), `mcp.oauth.revoked` (connection, reason,
remote result), `mcp.oauth.client_registered` (tenant, issuer, method), `mcp.oauth.denied`
(connection, code: `pkce_unsupported`, `issuer_mismatch`, `resource_mismatch`, `state_invalid`,
`iss_mismatch`, `egress_denied`), `mcp.tools.changed`, `mcp.tools.approved`, `mcp.egress.denied`
(connection, destination class, never the full URL of a tenant).

### 8. Interplay with telemetry (ADR 0015)

- New attributes on `execute_tool` (allowlisted, metadata only): `oax.mcp.auth` (`none | static |
  oauth`), `oax.mcp.relay` (boolean), `oax.mcp.tools_digest_match` (boolean). No token, scope
  string, issuer URL of a tenant or tool description is exported.
- `traceparent` propagation (ADR 0015 S8) goes through the relay unchanged and stays default off.
- Metrics: `oax_mcp_egress_denied_total{reason}`, `oax_mcp_tools_changed_total`,
  `oax_mcp_oauth_refresh_total{outcome}` (no tenant or connection labels).

### 9. Compatibility and migration

- Existing `streamable-http` connections become `auth.kind: static` implicitly (no data change).
  They keep working; the relay (S4) moves their header secrets out of run nodes.
- Existing tenant `stdio` connections: kept, flagged in the console and the upgrade notes; steps
  that use them in-process fail with `mcp_stdio_requires_isolation` after S0 (pre-1.0 behaviour
  change, changelog "Breaking"). Commands outside `OAX_MCP_STDIO_COMMANDS` are refused on the next
  change and at run time.
- Existing published versions have no `toolsDigest`: they run with a warning and an audit entry
  `mcp.tools.unpinned` until `OAX_MCP_REQUIRE_TOOL_PIN=true` (default `false` in S3, `true` from
  v1.0, owner question 4).
- Steps whose `runtime.egress` lists MCP hosts keep working; the hosts become redundant after S2/S4
  and Agent Check reports them (`egress_unused`).

### 10. Test plan

| Area | Tests |
| --- | --- |
| Egress, zero unexpected connections | Real-engine integration test (opt-in, like `container.integration.test.ts`): a node with two stdio servers (A egress `a.test`, B none) and a toolbox binary; a fake egress proxy counts CONNECTs per account. Assert: A reaches only `a.test`, B reaches nothing (no proxy variables, raw socket to a public IP fails, DNS lookup of an external name fails), the step account is not in either child's environment, and the proxy log shows **exactly** the expected connections. Kubernetes: rendered NetworkPolicies per node and per container server, `dnsEgress` refusal without acknowledgement. In-process: a tenant stdio connection on an in-process step is refused at publish and at run time; a platform stdio connection in air-gapped mode refuses start-up without `OAX_AIRGAPPED_STDIO`. |
| Run-time installers | `npx`, `uvx`, `sh -c`, `node -e`, relative paths and commands outside the allowlist refused with `mcp_command_forbidden` (table test). |
| Rug pull | Fake MCP server changes a description, a schema, an annotation, adds a granted-name tool, renames a tool: each yields `mcp_tools_changed`, zero tools exposed, audit and pending snapshot; non-granted changes do not; `existing-versions` approval refused when an access class changed; `list_changed` during a session ignored. |
| SSRF | Tenant MCP URL and egress entries: metadata IPs (v4, v6, mapped, decimal/hex spellings), `localhost`, private ranges, `http://` refused at save; redirect from the server, from PRM and from AS metadata to an internal host fails (`redirect: 'error'`); `resource_metadata` on another origin refused; issuer mismatch refused; oversized and slow metadata responses cut at 64 KiB / 5 s. |
| DNS rebinding | Resolver returns a public address at check and a private one later: connection goes to the checked address (dispatcher), for MCP calls, discovery and token requests. |
| OAuth flows | Fake authorization server: PKCE S256 present and verified; missing `code_challenge_methods_supported` refused; `state` replay and expiry; RFC 9207 `iss` matrix (four rows of the specification); `resource` sent in authorization and token requests; client credentials with `private_key_jwt`; refresh single flight under concurrency (one network refresh for 20 parallel calls); rotated refresh token persisted; `invalid_grant` sets `reauthorization_required`; issuer change refuses the stored client. |
| Token leak canaries | Tokens with a canary value: absent from logs, error messages, audit payloads, API responses (all connection endpoints), step records, model requests (simulated provider records the full prompt), node environment and memory dump of the node process, child environments, exported spans; a server echoing the token in a result gets it redacted by ContextGuard. |
| Tenancy | Tenant B cannot use, test, refresh or read status details of tenant A's OAuth connection; a ciphertext copied to another row does not decrypt (AAD); `authorization_code` on a central instance refused; DCR clients per tenant. |
| Relay | Node without HTTP egress completes a call through the relay; a revoked session, a foreign server name, a non-granted tool and a digest mismatch are refused; header secrets no longer in `StepCredentials`. |
| Air gap | Full run with an allowlisted internal MCP server and pre-registered OAuth client: `blockedAttempts == 0`; CIMD and DCR refused at start-up when air-gapped. |

### 11. Configuration, API and UI changes

Configuration (api and worker):

| Key | Default | Meaning |
| --- | --- | --- |
| `OAX_MCP_STDIO_COMMANDS` | shipped binaries | Allowlist of absolute stdio commands (paths, `prefix/*`). |
| `OAX_MCP_REQUIRE_TOOL_PIN` | `false` | Refuse runs of versions without `toolsDigest`. |
| `OAX_MCP_OAUTH_CIMD` | `false` | Publish the Client ID Metadata Document (needs `OAX_PUBLIC_URL`). |
| `OAX_MCP_OAUTH_DCR` | `false` | Allow dynamic client registration. |
| `OAX_MCP_RELAY_*` | see 6 | Concurrency, rate limit. |
| `OAX_AIRGAPPED_STDIO` | unset | `trusted` allows platform stdio connections in air-gapped mode. |
| `OAX_K8S_DNS_EGRESS_ACK` | `false` | Required with `dnsEgress: true`. |
| `OAX_SETUP_EGRESS_ALLOW` | reserved | Only with a future setup phase (4.4). |

API: `egress`, `auth` and read-only `authStatus` (`none | authorized | reauthorization_required`,
issuer host, scopes, authorized by/at; never a token) on MCP connections;
`POST /v1/connections/{id}/test` for MCP; `POST /v1/connections/{id}/tools/refresh`,
`GET /v1/connections/{id}/tool-snapshots`, `POST /v1/connections/{id}/tool-snapshots/{digest}/approve`
(`scope`), `.../reject`; `POST /v1/connections/{id}/oauth/authorize` (returns the authorization
URL), `GET /v1/oauth/mcp/callback`, `POST /v1/connections/{id}/oauth/disconnect`;
`GET /oauth/mcp-client.json` (CIMD, when enabled); worker endpoint
`POST /v1/worker/runs/{id}/mcp/{server}` (relay). Version detail gains `toolsDigest` per connection.

UI (MCP servers area of ADR 0012): tabs **Network** (effective egress, ceiling, last denials by
class), **Authorization** (method, connect/disconnect, status, scopes vs profile needs, issuer),
**Tools** (snapshots with status, diff view, approve/reject, which versions pin which digest);
publish errors and run failures link to the right tab; i18n EN and DE.

Helm: `mcp.stdioCommands`, `mcp.oauth.cimd`, `mcp.oauth.dcr`, `mcp.requireToolPin`; NetworkPolicy
of the api gains egress for MCP servers and authorization servers (the relay moves that traffic
from nodes to the api), mirrored as an issue in `open-agentix-helm`.

### 12. Rollout slices

Each slice is one PR for a Sonnet agent; the security-review points are checked by the reviewer
(Opus) before merge. Every slice adds its tests to section 10, keeps `pnpm test` and the OpenAPI
drift check green and adds its `[Unreleased]` changelog line.

| # | Slice | Content | Depends on | Security review |
| --- | --- | --- | --- | --- |
| S0 (#230) | Contain stdio MCP servers | `mcp_stdio_requires_isolation` at publish and in the worker; `OAX_MCP_STDIO_COMMANDS`, forbidden commands and env names; air-gapped start-up check for platform stdio; console flag and upgrade notes; refusal tests | – | yes: no tenant command reaches a trusted process; table of forbidden commands complete |
| S1 (#231) | HTTP MCP through the outbound dispatcher, destination checks | MCP client transport on `createOutboundDispatcher` (purpose `mcp`, tenant scope, pinning, `redirect: 'error'`); tenant-destination checks at save; MCP connection test (categorized); air-gap check of egress entries | ADR 0011 W10-1-2 (dispatcher, done) | yes: SSRF/rebinding suite green; no free-URL oracle |
| S2 (#232) | Per-connection egress and DNS | `egress` field and catalog floor; per-server proxy grants for stdio children; step account removed from MCP children; container runner DNS lockdown; Kubernetes `dnsEgress` acknowledgement; `egress_unused` lint; zero-unexpected-connections integration test | S0, S1 | yes: proxy accounts never cross children; DNS exfiltration test proves refusal |
| S3 (#233) | Tool snapshots and pinning | `mcp_tool_snapshots`, acceptances, digest (RFC 8785), approve/reject API, `toolsDigest` in expansion, run-time check with fail closed, audit and notification, `OAX_MCP_REQUIRE_TOOL_PIN`; console Tools tab | S1 | yes: digest covers every model-visible field; no description in audit or telemetry |
| S4 (#234) | Control-node MCP relay | worker endpoint, session/grant/gate/digest checks, limits, broker stops issuing header secrets, central HTTP instances usable from nodes; relay tests | S1, S3 | yes: node never sees header secrets or tokens; per-session limits |
| S5 (#235) | Key service and token store | minimal envelope encryption (platform KEK, per-tenant data key) shaped for ADR 0012 W12-2; `mcp_oauth_tokens`, `mcp_oauth_clients`; `McpCredentials` service; redaction and ContextGuard registration; leak canary suite | S4 | yes: AAD binding; no plaintext at rest; canaries absent everywhere |
| S6 (#236) | OAuth discovery and client credentials | PRM and AS metadata discovery per section 7.3; `client_credentials` with `private_key_jwt` and `client_secret_basic`; `resource` parameter; refresh single flight; revocation; audit entries; scope derivation from profiles | S5 | yes: discovery SSRF suite; issuer and resource binding; no token outside trusted processes |
| S7 (#237) | Authorization code with PKCE | authorize/callback endpoints, `state`, verifier and issuer storage, RFC 9207 checks, step-up as re-authorization, central-instance refusal, optional CIMD and DCR behind flags; console Authorization tab | S6 | yes: full OAuth review (mix-up, state, redirect URI, consent per instance) |
| S8 (#238) | Abuse suite, docs, Helm | W1-3b-10 extension with the egress, rug-pull, SSRF and token tests that need a real engine; `docs/mcp.md` (egress, auth, snapshots), `docs/airgapped.md`, `docs/security-input-hardening.md` link, threat model page; Helm mirror issue | S2, S4, S7 | no (doc review); the suite results are reported in the PR |

S0 can ship alone and first: it closes the largest gap found while writing this ADR. A future
container transport for MCP servers (3.3) is the remaining part of W5-5 and gets its own slice after
S2.

## Consequences

- Positive: the egress rule holds for every process of a step, including MCP servers, and a test
  proves it with connection counts; the Copilot-style gap (MCP and setup outside the firewall) is
  closed by design.
- Positive: OAuth-protected MCP servers (most hosted SaaS servers) become usable with
  standard-conformant, audience-bound tokens that never reach a node or a model.
- Positive: tool changes after review are detected and stop the run instead of silently reaching
  the model.
- Negative: tenants lose in-process stdio servers (pre-1.0 breaking change); they need an isolating
  runner or a container server.
- Negative: the relay adds a hop and load on the api for every HTTP MCP call of a node.
- Negative: the platform stores credential values for the first time; key management becomes a
  dependency earlier than ADR 0012 planned.
- Negative: re-approval of tool snapshots is new admin work, and a vendor that updates descriptions
  often will stop runs until someone approves.

## Implementation status

- **S0 (#230) implemented.** Differences from the text above, decided while implementing:
  `OAX_MCP_STDIO_COMMANDS` defaults to **empty** (no tenant stdio command) instead of "the binaries
  shipped in the images", because the platform cannot know which binaries are safe to run; an entry
  `dir/*` matches files directly inside `dir` only; the real path of a symlinked command must be
  allowlisted as well; allowlist entries naming a system directory as prefix, or lying in or below
  a temporary, virtual or run-writable directory (`/tmp`, `/dev`, `/proc`, `/run`, `/workspace`,
  ...), fail start-up; the `env` rule is the `agents[].credentials` rule plus further loader and
  interpreter hooks, compared case-insensitively; interpreters (`node`, `python`, ...) are accepted
  without code-injecting flags rather than refused outright, but only when the program file they
  run is itself an allowlisted absolute path with nothing but value-less options in front of it
  (`python -m`, `java -cp`, relative scripts refused; `bun` refused as a run-time installer);
  platform connections are exempt from the command and environment rules, and only platform
  operators may create, change or delete them; the step handover carries `stdio` so that the run
  node re-checks the real binaries of its image (real path allowlisted, file present, file and
  directory not writable by the node); the control node checks literal paths only and never
  resolves tenant paths on its own host; the handover ships exactly the configs that were checked
  (one fresh read); stored violations are reported at start-up, in
  `GET /v1/connections/stdio-violations` and as `warnings` on connections. The name-based deny
  lists are a best-effort second layer behind the allowlist (follow-up issues). See
  `docs/mcp.md`.

## Alternatives considered

- **Keep step-level egress for MCP servers**: simpler, but every server of a step gets the union of
  hosts, which is exactly the gap this ADR closes. Rejected.
- **Library-level egress control inside stdio servers** (preload hooks, `NODE_OPTIONS`): the child
  can ignore it, and non-Node servers are not covered. Rejected; the network is the wall.
- **Hand short-lived OAuth access tokens to run nodes through the broker**: no relay needed, but a
  compromised node gets a usable bearer token for its lifetime, and refresh logic would move to
  untrusted code. Rejected for v1 (open question 5).
- **Trust MCP tool annotations or descriptions without pinning**: rejected; annotations are hints
  and descriptions are attacker-controlled text.
- **Dynamic client registration as the default**: the specification deprecates it, and it creates
  unbounded registrations per tenant at third-party servers. Kept as an opt-in fallback.
- **Use the MCP SDK's built-in OAuth client helpers unchanged**: they perform their own discovery
  fetches; we would lose the dispatcher's pinning, limits and tenant checks. The implementation may
  reuse SDK types and parsers only where every network call goes through an injected, dispatcher-
  backed fetch.

## Open questions (owner decisions needed)

1. **Tenant stdio servers.** Recommendation: allow them only on isolating runners with commands
   from the operator allowlist (S0), and steer third-party servers to container servers (W5-5).
   Alternative: forbid tenant stdio entirely until container servers exist.
2. **Client registration.** Recommendation: pre-registered by default; Client ID Metadata Document
   behind a flag for installations with a public URL; dynamic client registration off by default
   and per tenant when enabled.
3. **Per-end-user delegation** (tokens on behalf of the user who triggered a run, for chat-like
   triggers). Recommendation: not in v1; connection-level consent only; revisit with chat inbound
   triggers.
4. **Tool pin enforcement.** Recommendation: refuse unpinned versions from v1.0
   (`OAX_MCP_REQUIRE_TOOL_PIN=true` default), warn before; block on any change of a granted tool's
   description, schema or annotations (not only on schema changes).
5. **Tokens to run nodes as a fallback** when the relay is disabled. Recommendation: no; HTTP MCP
   from nodes requires the relay.
6. **Client credentials grant** is an MCP authorization extension rather than core. Recommendation:
   support it (S6) because unattended runs are the main use case, and document it as such.
7. **DNS for run nodes.** Recommendation: no external resolution at all from nodes (proxy resolves);
   Kubernetes `dnsEgress` only with acknowledgement.
8. **A future setup phase** (dependency installation before tests). Recommendation: do not add one;
   build images instead. If needed later, implement 4.4 exactly (separate egress, before credentials,
   grant revoked before the run phase).
