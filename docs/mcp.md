# MCP connections and tool profiles

An MCP server is added as a **connection** of kind `mcp` (Connections page or `POST /v1/connections`).
Secrets are referenced by name (`envSecrets`, `headerSecrets`), never stored. This page covers the
tool classification and the named **profiles** of
[ADR 0008](adr/0008-agents-md-data-flow-and-isolation-contract.md), section 1.3.

## Declare tool classes and profiles

```json
{
  "transport": "streamable-http",
  "url": "https://mcp.example.internal/jira",
  "headerSecrets": { "authorization": "jira-token" },
  "tools": {
    "get_issue": { "access": "read" },
    "search_issues": { "access": "read" },
    "create_issue": { "access": "write" }
  },
  "profiles": {
    "read": ["get_issue", "search_issues"],
    "write": ["create_issue"],
    "triage": ["get_issue", "create_issue"]
  }
}
```

Rules, checked when the connection is created or updated (HTTP 400 otherwise):

- `tools` declares the access class of each tool (`read` or `write`). **A tool that is not declared
  counts as `write`.** Tool names are literal: no wildcards, at most 500 tools.
- Every member of a profile must be a declared tool, without duplicates. Unknown tools are refused.
- Profile names are lowercase slugs. `read` and `write` are conventions; any name (`triage`) is
  allowed. A profile named `read` may only contain `read` tools, so a misleading name cannot smuggle
  in a write tool.
- MCP tool annotations are hints from the server and are never trusted to widen access: the declared
  class wins; without a declaration only a clear `readOnlyHint: true` (and no `destructiveHint`)
  counts as `read`. The gateway reports the derived class as `access` on each exposed tool.

## Grant a profile in agents.md

```yaml
agents:
  - id: research
    access: read-only
    tools:
      - { server: jira, profile: read }
  - id: action
    access: write
    tools:
      - { server: jira, profile: write, approval: required, maxCallsPerRun: 3 }
```

A profile grant takes `approval`, `maxCallsPerRun` and `classification`; argument constraints belong
on concrete grants (`tool:`). A concrete grant for the same `server/tool` wins over the expansion, so
a tool can be narrowed with constraints. Overlapping profile grants merge to the stricter values
(`approval: required` wins, the lower `maxCallsPerRun`).

## What happens at publish

1. The control node resolves the connections that apply to the agent (most specific scope wins per
   name) and expands every profile grant into one concrete grant per tool
   (`allowAdditionalArgs: true`, no argument constraints).
2. The expanded grants, an `expansion` record per profile grant (`{ agentId, server, profile, tools,
   connectionVersion }`), the classification of the used servers' tools (`toolAccess`) and an
   `expansionDigest` (SHA-256 over all of it) are stored in the immutable version's `definition`.
   The source digest stays the digest of the `agents.md` text. Editing a profile later never changes a
   published version; publish a new version to pick the change up.
3. Publish is refused with `validation_failed` (and an `agent.publish.denied` audit entry) when a
   connection or profile name is unknown, or when a step with `access: read-only` would receive a tool
   that is not classified `read`: through a profile, a direct grant, a wildcard (`jira/*`) or an
   undeclared tool. A successful expansion is audited as `agent.profiles.expanded`.
4. `POST /v1/agents/validate`, the dry run and `POST /v1/policies/evaluate` apply the same expansion,
   so authors see the errors before publishing.
5. For every `streamable-http` connection the version grants tools on, publish records the pinned
   tool definitions (`toolPins`, part of `expansionDigest`) and refuses with `mcp_tools_unreviewed`
   or `mcp_tool_unknown` when there is no approved snapshot or a granted tool is not in it; see
   [Pinned tool definitions](#pinned-tool-definitions).

`GET /v1/agents/{id}/versions/{version}` returns `expansion` and `expansionDigest`. The agent overview
shows which profile each grant came from.

## Run-time enforcement

For an agent with `access: read-only` the policy gate additionally requires the called tool to be
classified `read` in the version's `toolAccess` and denies everything else with the reason code
`profile_write_denied` (recorded in the `policy.decision` audit entry). This is a second wall: it
holds even if a write grant reached the stored version some other way. Without a classification
(for example a local run of an unpublished file) a read-only step cannot call tools: it fails closed.

## Limits

- Classification is declared by the integrator; the platform cannot verify that a tool declared
  `read` really has no side effects. Review profiles like any other grant.
- Argument constraints are not part of a profile; use concrete grants for narrowing.

## HTTP MCP servers (streamable HTTP)

A `streamable-http` connection is contacted at its `url`, nothing else. Every request of the MCP
client (initialize, calls, the event stream, session close) leaves through the outbound dispatcher
of [ADR 0011](adr/0011-outbound-network-proxies-and-private-endpoints.md) with the purpose `mcp`
([ADR 0016](adr/0016-mcp-egress-and-authorization.md) sections 4.2 and 4.3). Who defined the
connection decides how strict that is:

| Connection scope | Destination rules |
| --- | --- |
| `platform` (operator) | the operator's network configuration: proxies, `deny` routes, air-gapped allowlist. Plain `http://` and private addresses stay possible (in-cluster servers). |
| `tenant`, `team`, `agent` | **https only**; no `localhost`, no loopback, link-local, private, CGNAT, multicast or cloud-metadata address in any spelling (`169.254.169.254`, `2852039166`, `0xa9fea9fe`, `0251.0376.0251.0376`, `[::ffff:169.254.169.254]`, `[fd00:ec2::254]`, ...), no metadata host name. Only the platform can open a private range, with `privateAllow` in the network configuration (never loopback, link-local or metadata). Run nodes are different: the egress proxy of the node network applies its own `OAX_CONTAINER_EGRESS_PRIVATE_ALLOW`, not the network configuration's `privateAllow`. |

**When saving** (`POST`/`PUT /v1/connections`): the URL of a tenant connection is checked by the
resolver without any DNS lookup (a refused connection answers `422 egress_denied` with the rule code
only, so saving is never a name-resolution oracle). Independent of the scope, `400` is returned for
credentials or a fragment in the URL (`mcp_url_invalid`, use `headerSecrets`) and for a header the
platform owns (`mcp_header_forbidden`): `host`, `content-length`, `transfer-encoding`, `connection`,
`upgrade`, `te`, `trailer`, `expect`, `cookie`, `via`, `forwarded`, `x-forwarded-*`, `x-real-ip`,
`origin`, `accept`, `content-type`, `mcp-session-id`, `mcp-protocol-version`, `last-event-id`,
the trace context (`traceparent`, `tracestate`, `baggage`) and `proxy-*`, `sec-*`, `x-oax-*`; also
for the same header given twice (plain and secret-backed, or in two spellings) and for header
values with control characters. Authentication headers of the MCP server (`authorization`,
`x-api-key`, ...) stay yours. The optional `egress` list of an HTTP connection may repeat the host
(and port) of the `url` and nothing else; it is checked against the air-gapped allowlist.

**When connecting**: the dispatcher resolves the name once, refuses the connection if any answer is
non-public, and connects to the address it checked (no second resolution, so DNS rebinding cannot
swap the address after the check). Redirects are never followed (`redirect: error`), the request URL
must have the origin of the connection URL (`mcp_egress_denied` otherwise), TLS verification is
always on, and a response is limited to 64 MiB. Behind a proxy the proxy resolves the name; the
resolver and one pre-request lookup refuse private answers, but the proxy's own answer can differ
(residual risk of ADR 0011). A connection that was stored before these rules and breaks them fails
closed when a run uses it.

Run nodes never connect to HTTP servers: every call goes through the control node's relay, which
uses exactly the path above (see [Control-node relay for run nodes](#control-node-relay-for-run-nodes)).

### Test a connection

`POST /v1/connections/{id}/test` on an `mcp` connection (no body needed) runs `initialize` and
`tools/list` through the same path as a run and answers with a **category only**:

```json
{ "ok": false, "category": "egress_denied", "latency": "<100ms" }
```

For tenant, team and agent connections `dns_failed` is reported as `egress_denied`: a name that does
not resolve and a name that resolves to a private address read the same, so the test is no oracle
for internal names (split-horizon DNS). The operator's platform connections keep `dns_failed`.

Categories: `ok`, `config_invalid`, `egress_denied`, `dns_failed` (platform connections only), `connect_failed`,
`proxy_refused`, `tls_untrusted`, `tls_hostname_mismatch`, `auth_failed` (401/403), `http_error`
(with `httpClass` `4xx` or `5xx`), `protocol_error`, `timeout`, `error`. On success `toolCount` is
the number of listed tools. There is no response body, header, address, error text of the server,
tool name or description and no exact timing in the answer or the audit entry (`connection.tested`
with the category). It takes no URL (only a stored connection), is limited to 10 tests per minute
per user and replica, needs `connections:write`, tests a platform connection only for platform
operators, and refuses stdio connections (`400 mcp_test_unsupported`: a test would start a process).
A test ends after 30 seconds in total (`timeout`) and reads at most 8 MiB per response.

## Trace context propagation (opt-in)

By default an MCP server learns nothing about the run's trace: no `traceparent`, no `tracestate`, no
`baggage`, no header ([ADR 0015](adr/0015-opentelemetry-genai-tracing.md) section 6.4). Two switches
turn on one narrow exception, and both must be on:

| Switch | Who sets it | Default |
| --- | --- | --- |
| `OAX_OTEL_MCP_PROPAGATION=allow` | operator, platform-wide | `deny` |
| `"telemetry": { "propagate": true }` in the connection config | tenant admin (tenant, team, agent connections) or platform operator (platform connections) | off |

An integrator with `connections:write` can save a connection but gets `403` when turning
`propagate` on; turning it off is always allowed. The platform `deny` wins over every connection.

With both on, each `tools/call` of the run carries `params._meta.traceparent` (version `00`, the
trace id of the run and the span id of that call's `execute_tool` span, flags `00` or `01`) and
nothing else: no `tracestate`, no `baggage`, no other `_meta` key and no HTTP header (the
forbidden-header list above stays). `initialize`, `tools/list`, connection tests and tool refresh never
carry it. For a call relayed for a run node the control node opens the `execute_tool` span itself
(`oax.mcp.relay=true`); whatever the node sends (a `traceparent` header, `params._meta`) is dropped.
Harness steps and nodes without the relay send nothing. A running run keeps the connection config it
started with. The sampled flag is passed on as it is (an unsampled span goes out with `-00`).
Changing the destination (transport, url, command, args) of a connection that has `propagate` on
needs a tenant admin again, and a concurrent edit gets `409`.

**Shared collectors.** A server that receives the trace id can send spans with it to your collector
if it can reach it, and can set any attribute (for example `oax.tenant.id`) on them. Do not let a
shared collector trust span attributes of foreign spans for routing or tenant separation; route by
authenticated resource (see
[observability](observability.md#mcp-trace-context-and-shared-collectors)).

The server is untrusted and can see the run's trace id and call timing once you opt in; that is the
price of joining its own traces to yours. Nothing a server returns is used as a trace parent or
exported. The `execute_tool` span of a propagated call gets `mcp.method.name=tools/call`,
`mcp.protocol.version` (when known) and `oax.mcp.propagated=true`.

```json
{ "transport": "streamable-http", "url": "https://mcp.example.internal/jira",
  "telemetry": { "propagate": true } }
```

## Pinned tool definitions

Tool names, descriptions and schemas come from a server the platform does not control, and they
become part of the model's context. A server (or whoever took it over) can change them after you
reviewed them ("rug pull") or hide instructions in them ("tool poisoning"). Since
[ADR 0016](adr/0016-mcp-egress-and-authorization.md) section 5 the control node therefore pins them:
what was reviewed is what runs.

**Snapshot.** A snapshot is the list of tools of an HTTP connection at one moment, reduced to the six
fields the model can see: `name`, `title`, `description`, `inputSchema`, `outputSchema`,
`annotations`. Everything else of the wire format (`_meta`, icons, ...) is dropped. Its `digest` is the
SHA-256 (hex) of the [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) JSON of that list, sorted by
name; an absent field is omitted, an empty one is not. Any change to any of the six fields, an added,
removed or renamed tool, or a hidden character in a description gives another digest. The canonical
form is implemented in `packages/core/src/jcs.ts` (strict: values outside the JSON data model and
lone surrogates are refused instead of dropped) and checked against the test vectors of the RFC.

Snapshots are stored per connection (`mcp_tool_snapshots`, owned by the tenant of the connection) with
the status `pending`, `approved` or `rejected`. They are bounded (at most 500 tools, 64 KiB per tool,
1 MiB in total; more is refused with `422 mcp_tools_too_large`, malformed definitions with
`422 mcp_tool_invalid`, which includes a list that names a tool twice) and a list that contains
something that looks like a credential (the patterns of the context guard, or a secret value
resolved for the connection) is refused with `422 mcp_tools_contain_secret` and not stored.

Two limits to know about. **A server that lists more than 500 tools cannot be pinned**: refresh is
refused with `mcp_tools_too_large`, so no approved snapshot exists and publish is refused with
`mcp_tools_unreviewed`; put a narrower server (or a gateway that exposes only the tools an agent
needs) in front of it. **The credential scan is a safeguard, not a guarantee**: it finds known
patterns and the secret values resolved for the connection in clear text; a secret that the server
encodes (base64, split, obfuscated) is not detected. Reviewers read the diff; the platform does not
send secrets to `tools/list` in the first place.

| Call | Needs | Purpose |
| --- | --- | --- |
| `POST /v1/connections/{id}/tools/refresh` | `connections:write` | Connects like a run does (same dispatcher and destination rules) and stores the list as a `pending` snapshot, or finds the one with the same digest. Answers with the category of the connection test and the snapshot summary, never with tool text. Shares the rate limit of the connection test (10 per minute and user). `400 mcp_refresh_unsupported` for stdio connections. |
| `GET /v1/connections/{id}/tool-snapshots` | `connections:read` | Summaries: digest, status, source (`refresh` or `run`), count, which one is in use, how many published versions of your tenant pinned it. |
| `GET /v1/connections/{id}/tool-snapshots/{digest}` | `connections:read` | The definitions, the snapshot in use to diff against, the changed tool names and the versions that pinned it. The text is untrusted: show it as data. |
| `POST .../{digest}/approve` `{ "scope" }` | `connections:write` | `new-versions` or `existing-versions` (below). Audited as `mcp.tools.approved`. |
| `POST .../{digest}/reject` | `connections:write` | Marks a pending snapshot `rejected` (`mcp.tools.rejected`). A later explicit refresh that sees the same list reopens it. |

Approving needs `connections:write` (admin and integrator), which agent engineers, who publish, do not
have: whoever publishes an agent cannot approve the tools it will use. A platform connection can only
be refreshed, approved and rejected by platform operators; tenants can read its snapshots. A
connection or digest of another tenant answers `404`, exactly like one that does not exist.

**Publish.** The profile expansion records, per connection the version holds grants on,
`toolPins[<connection>] = { snapshotDigest, toolsDigest, granted }`: the digest of the latest approved
snapshot, the digest over **the granted tools** of it (exact names, `prefix*` patterns and the tools
of profile grants, over all steps of the version) and the grants themselves. It is part of
`expansionDigest` and shown by `GET /v1/agents/{id}/versions/{version}`. Publish is refused with
`400 mcp_tools_unreviewed` when the connection has no approved snapshot (a pending one does not
count) and with `400 mcp_tool_unknown` when a granted tool is not in it. A change to a tool that is
not granted does not change `toolsDigest`.

**Connection identity.** `toolPins` also records the id of the connection the snapshot belongs to.
`existing-versions` acceptances are honoured only for that connection: a connection of the same
name at a narrower scope (for example a tenant connection that shadows a platform one) that is
resolved for a run decides nothing for a version that pinned the other connection; such a run
accepts the pinned digest only.

**Run.** The gateway of the worker (and of a run node) lists the tools of a pinned server once per
session, computes the digest over the granted tools it actually received and compares it with the
version's `toolsDigest` and with the digests the control node resolved as accepted (below). On a
mismatch it exposes **none** of that connection's tools, refuses calls too (the harness gate calls
without listing first) and the step fails with `mcp_tools_changed`; the message names the
connection, never the changed text. The control node then writes the audit entry `mcp.tools.changed`
(connection, old and new digest, names of the changed tools, no descriptions), stores the live list
as a `pending` snapshot with source `run` (at most 20 are kept per connection, a list with a
credential is not stored), and increments `oax_mcp_tools_changed_total` (no labels). There is no
outbound notification channel in the platform yet: admins find the event in the audit log, the
`Seen by a run` badge in the Tools view of the connection and the metric. `notifications/tools/list_changed`
during a session is ignored; the next session sees the change. The definitions that were checked are
the ones that are exposed: for a pinned server the gateway keeps the verified granted tools of the
first list and never reads a second answer of the server, and a call to a tool that was not in the
verified list is refused with `mcp_tools_changed`, so a server cannot answer the check with the
approved definitions and the model with others.

**Re-approval.** An admin reviews the diff and approves the new snapshot. A list that a *run* reported
(source `run`) cannot be approved directly (`409 mcp_snapshot_unconfirmed`): an untrusted node may
have sent it. The admin first fetches the tools (`tools/refresh`); if the server returns exactly that
list, the snapshot becomes a normal pending one (source `refresh`) and can be approved; if the server
returns something else, the reported list stays unapproved. The Console disables Approve and says so.

- `new-versions`: only versions published afterwards pin it. Published versions stay blocked.
- `existing-versions`: every published version that pinned the previous approved snapshot (or one
  that already accepts it) also accepts the new one. It is refused with
  `409 mcp_tools_access_changed` (audited as `mcp.tools.approval_denied`) when for any such version
  the names of the tools it holds or their access classes (the declared class, else derived from the
  annotations like the gateway does) differ. The versions stay immutable; the decision is the
  connection-level record `mcp_tool_snapshot_acceptances (from_digest, to_digest)`. Acceptance is
  transitive along these records and is checked against every version it reaches. At run time the
  control node resolves, per version, the digests it accepts and hands them to the gateway.

**Recommendation.** Set `OAX_MCP_REQUIRE_TOOL_PIN=true` on new installations: every run then uses
pinned definitions. The default stays `false` so that upgrades keep running versions that were
published before pinning existed.

**Compatibility (decision).** Published versions are immutable and are never rewritten:

- A version published before this change has no `toolPins`. It keeps working: the run proceeds with a
  warning, audited as `mcp.tools.unpinned` (connection, version) once per run and server, until the
  operator sets `OAX_MCP_REQUIRE_TOOL_PIN=true`, which fails such runs with `mcp_tools_unpinned`.
  The default is `false`; it is meant to become `true` from v1.0 (ADR 0016, owner question 4).
  Publish a new version to pin an existing agent. An unchanged re-publish returns the existing
  version and does not add pins.
- **Publishing against an HTTP connection now needs a reviewed tool list**, also for agents that
  published fine before: refresh and approve the connection's tools once, then publish. This is the
  one behaviour change for existing installations and is listed in the changelog.
- Connections that cannot be pinned in this slice behave exactly as before: `stdio` connections (a
  refresh would start a process; container servers come with ADR 0016 S2/W5-5) and `in-memory`
  servers. They are never reported as unpinned and are not affected by `OAX_MCP_REQUIRE_TOOL_PIN`.
- A version whose connection is shadowed by a connection of the same name with another scope at run
  time is compared against the pinned digest of the version and the acceptances of the connection
  that is resolved; if that connection offers different tools the run fails closed.
- Run nodes get the pins in their handover (digests only) and enforce them in their gateway; they
  report the list they read to `POST /v1/worker/runs/{id}/mcp-tools-changed`. A node is untrusted, so
  the control node recomputes the digest, bounds and scans the list, accepts the report only for a
  server the step holds a pin and a grant for, ignores a report of an accepted digest and records at
  most 10 changes per run. The node's own check is a second wall: HTTP calls of a node go through the
  relay, which verifies the pin on the control node before any call reaches the server, so a
  compromised node cannot skip it.

Configuration: `OAX_MCP_REQUIRE_TOOL_PIN` (see [`configuration.md`](configuration.md)). Migration
`0024_mcp_tool_snapshots` adds the two tables; the down script drops them (published versions keep
their `toolPins`, which an older build ignores).

## Stored OAuth tokens and the key service

OAuth tokens of MCP connections (ADR 0016 section 7.5, slice S5) are the first credential values the
platform stores. Nothing is stored in plaintext.

- **Envelope encryption.** The operator provides a platform key-encryption key (KEK,
  `OAX_MCP_OAUTH_KEK_FILE`; `OAX_MCP_OAUTH_KEK` is read once and removed from the environment). Each
  tenant has one data key, created on first use, wrapped with the KEK and kept in `tenant_data_keys`.
  Tokens are sealed with AES-256-GCM under the tenant's data key; the additional authenticated data is
  the tenant, connection, issuer, resource and credential version, so a ciphertext copied to another
  row, tenant, issuer, resource or version does not decrypt.
- **Tables** (migration `0026_mcp_oauth_tokens`): `mcp_oauth_tokens` (tied to the tenant of its
  connection by a composite foreign key), `mcp_oauth_clients`, `tenant_data_keys`, and
  `connections.credential_version`. No API route selects the ciphertext columns.
- **What a stored value may be.** The value is chosen by the authorization server, and the redactors
  rewrite it wherever it occurs, so it must look like a credential and must not be able to blank
  ordinary text: RFC 6750 `b64token` characters, 20 to 2048 of them, enough estimated entropy for its
  alphabet (80 bits; a 20-character hex key passes), not compressible (periodic strings fail), not
  word-like, not digits only, no dashed UUID anywhere in it, and not containing the tenant or
  connection id. Public shapes are refused as well: paths (`runs/...`, `sha256/...`, `/api/v1/...`),
  names with separators and no upper case (host names, model ids, versions, trace headers), values
  with a date, and JWT fragments (a whole three-part JWT is fine). Anything else is refused with
  `token_invalid`. Hex keys of 20 or more characters, base64, base64url and JWTs are accepted.
- **Who can read a token.** Only `McpCredentials.accessToken(connection, scope, { guard })`, built by
  the api (`createServices(ctx)`) and by the worker (`createServices(ctx, 'worker')`). The connection's
  URL and credential version come from the database, not from the caller, and the call returns
  `{ token, resource }`: send the token to that resource only (the URL may change between the call
  and the request). The role check only documents the wiring; the boundary is that run nodes,
  harnesses and models have neither the KEK nor a database connection, and a test follows the imports
  from the run-node entry point (bare, subpath, `require` and dynamic imports) and fails if they
  reach this module. Expired, revoked or re-authorization-pending tokens, a moved URL, missing scopes
  and a destroyed tenant key fail closed (`mcp_auth_required`, `mcp_resource_mismatch`,
  `mcp_insufficient_scope`). A token that expires within a minute is renewed first (see
  [OAuth for HTTP MCP connections](#oauth-for-http-mcp-connections)).
- **Credential version.** Changing the connection URL to another canonical URI bumps
  `credential_version` and deletes the stored tokens in one transaction; writing a token locks the
  connection row and re-checks the version, so a write racing the bump cannot leave an orphan.
- **Redaction.** Before `accessToken` returns, the value is registered with the run's `ContextGuard`
  and with a bounded per-process registry (Aho-Corasick; scanning cost follows the text, not the number
  of tokens). Spellings indexed: the value, percent-encoded in either case, JSON-escaped and the three
  base64 alignments; hex and base64url are not indexed (the run's `ContextGuard` still matches them).
  Values belong to the tenant of the connection:
  - audit payloads (string leaves, before hashing), JSON responses, run and model event streams are
    scrubbed with the values of the tenant they are written or served for (run-token routes use the
    run's tenant), so one tenant's token can never alter another tenant's evidence. Audit entries
    without a tenant are not scrubbed (names and ids only). Responses that aggregate several tenants
    (subtree views) use the caller's tenant only (follow-up issue);
  - log lines, stdout/stderr, uncaught traces and span attributes cannot name a tenant. They use only
    values that are also long (32 characters or more), high in estimated entropy (128 bits) and not the
    shape of a UUID or a SHA digest (32, 40 or 64 hex characters, which are redacted per tenant only).
    Residual risk, accepted: a long random-looking value can equal a public string of the same shape, so
    such text in logs and spans could lose that string. This costs the integrity of log text, never
    confidentiality, and never reaches audit entries or other tenants' API data.
  Each re-registration of an unchanged token (every tool use) only refreshes its lifetime; a new or
  rotated token rebuilds the affected automata once, bounded by the caps (150,000 indexed characters
  in total, 40,000 per tenant, 256 values per tenant, 4096 in total; measured about 15 ms at the caps).
  The registry is per process: a token read in the worker is not known to the api. Entries leave at
  expiry (plus 5 minutes), on revocation or deletion of the connection and at the caps (the tenant over
  its quota loses its own oldest value first, then the tenant with the most). A warning is logged when a
  still-valid value is dropped, at most once a minute with the number dropped since. This in-memory set is
  a recorded deviation from "not cached beyond one call" in ADR 0016.

### Limits and operations

- **Crypto-shredding is partial.** `KeyService.destroyTenantKeys` removes the wrapped data keys from
  the live database (nothing calls it yet). While the KEK is unchanged, a database backup or WAL
  segment taken earlier still holds the wrapped key and the KEK unwraps it. Complete shredding needs a
  per-tenant key-encryption key or a KMS (ADR 0012 W12-2).
- **Runbook: the KEK is lost or must be replaced.** There is no rotation yet. A data key wrapped with
  another KEK id is refused (`key_unavailable`), and so is one wrapped with different key material
  under the same id (the error says the KEK differs). If the KEK is lost, the stored tokens are
  unrecoverable: stop the api and worker, delete the rows of `mcp_oauth_tokens`, `mcp_oauth_clients`
  and `tenant_data_keys`, start with the new KEK (and a new `OAX_MCP_OAUTH_KEK_ID`), and authorize the
  OAuth connections again. Back the KEK up with the database backups.
- **Where the KEK lives.** Keep the key file outside `OAX_SECRETS_DIR` (start-up refuses it there, also through symlinks or a link inside the directory that leads to it: the default secret resolver serves every file below it as a secret reference). Give it to the api and the worker only; the worker process reads it into
  memory, so keep key-holding workers on hosts or node pools that do not run untrusted run nodes (use
  the container or Kubernetes runner for those).

## OAuth for HTTP MCP connections

ADR 0016 section 7, slices S6 and S7. A `streamable-http` connection has an `auth` block: `none` (no
credential), `static` (the `headerSecrets` of earlier versions; also the meaning of an absent `auth`) or
`oauth`. `oauth` has two grants: **client credentials** with a pre-registered client (service
connections, nobody present; described first) and **authorization code with PKCE** with a
pre-registered client, a client ID metadata document or dynamic registration (the remote system needs a
person's consent; see [Authorization code with PKCE](#authorization-code-with-pkce)).

```jsonc
{
  "transport": "streamable-http",
  "url": "https://mcp.example.com/mcp",
  "auth": {
    "kind": "oauth",
    "grant": "client_credentials",
    "client": {
      "clientIdSecret": "acme.jira-client-id",       // secret references, never values
      "clientAuth": "private_key_jwt",               // or "client_secret_basic"
      "keySecret": "acme.jira-client-key",           // PEM: RSA, P-256 or Ed25519 (private_key_jwt)
      "keyId": "k1"                                  // optional `kid`
      // "clientSecretSecret": "acme.jira-client-secret"  (client_secret_basic)
    },
    "scopes": "from-profiles",                       // or an explicit list
    "issuer": "https://auth.example.com"             // optional pin
  },
  "tools": { "get_issue": { "access": "read", "scopes": ["issues.read"] } },
  "profiles": { "read": ["get_issue"] }
}
```

**`client_secret_basic` needs `auth.issuer`.** The client secret is sent to the token endpoint that the
authorization server metadata names, and the metadata is reached through the MCP server's own
documents: without an operator-pinned issuer a hostile or hijacked MCP server could name a token server
of its own and collect the secret. With `private_key_jwt` nothing reusable is sent: the assertion is
signed for exactly the endpoint it is sent to (`aud`), so another server cannot replay it, and the
issuer pin is optional (but still recommended).

Rules checked when the connection is saved (`400`): `oauth` or `none` together with an `authorization`
header, plain or secret-backed in any spelling, is `auth_conflict`; an `oauth` connection needs an
`https` URL without a query (the resource identifier is scheme, host and path); the client block needs
exactly the secret that its `clientAuth` uses, and `client_secret_basic` also an `auth.issuer`; the secret references follow the tenant prefix rules.

### Authorize, status, disconnect

| Route | Permission | Meaning |
| --- | --- | --- |
| `POST /v1/connections/{id}/oauth/authorize` | `connections:write` | Discovers the authorization server, pins it, and for `client_credentials` requests a token; for `authorization_code` it returns the `authorizationUrl` of the consent. Body `{ "issuer"?: "https://..." }` (needed when the resource names several servers: `409 mcp_oauth_issuer_required` lists them). Rate limited like the connection test. |
| `GET /v1/connections/{id}/oauth` | `connections:read` | Status, pinned issuer, scopes, expiry, last renewal error code, the authorization server hosts, `scopesWider`; for `authorization_code` also `registration`, `redirectUri`, `scopesMissing`, `requiredScopes`, `reauthorizationNeeded` and `pendingExpiresAt`. Never a token. |
| `POST /v1/connections/{id}/oauth/disconnect` | `connections:write` | Deletes the stored tokens and revokes them at the issuer; an open consent request ends too. |
| `GET /v1/oauth/mcp/callback` | none (browser redirect) | The redirect target of the authorization server; see below. |
| `GET /oauth/mcp-client.json` | none | The client ID metadata document, only with `OAX_MCP_OAUTH_CIMD=true` (otherwise `404`). |

Consent is explicit: runs never authorize a connection by themselves. A pin outlives a failed
renewal: when a connection needs a new authorization and the resource now names a different server than
the one pinned (by `auth.issuer`, or by the earlier authorization), `authorize` answers
`409 mcp_oauth_issuer_required` and contacts nobody; an administrator confirms a move by naming the new
issuer in the body (never possible against an `auth.issuer` in the configuration). A connection that was not
authorized fails with `mcp_auth_required`.

### Discovery (SSRF-safe)

In specification order: an unauthenticated `initialize` (`purpose mcp`) that answers `401` with
`WWW-Authenticate: Bearer resource_metadata="..."` and optionally `scope`; otherwise the protected
resource metadata at `/.well-known/oauth-protected-resource/<path>` and then
`/.well-known/oauth-protected-resource` (RFC 9728). Then, for the chosen issuer, RFC 8414 with path
insertion, OpenID Connect discovery with path insertion and with path appending (the two root forms for an
issuer without a path). A `404` moves to the next candidate; everything else (denial, redirect, size,
time, wrong type) stops.

Every request leaves through the outbound dispatcher ([ADR 0011](adr/0011-outbound-network-proxies-and-private-endpoints.md)):
purpose `mcp` for the resource server and `identity` for authorization server metadata, token and
revocation requests; the origin class of the connection decides the destination rules (tenant
connections: https only, no private, loopback, link-local or metadata address in any spelling, DNS
pinned at connect time, `redirect: error`). On top of that: the answer is cut at 64 KiB, the whole
exchange at 5 s (token requests 10 s), only `application/json` objects are parsed (wrong types are
refused, unknown members ignored) and error texts name a host, never a path, query or response body.

Checks on what the documents say:

- the `resource` of the protected resource metadata must equal the canonical URI of the connection
  (`mcp_resource_mismatch`; host case and default port do not matter, a trailing slash does);
- a `resource_metadata` URL from a challenge must be `https` and on the origin of the MCP server
  (`mcp_resource_metadata_origin`);
- `issuer` in the authorization server metadata must equal the issuer it was fetched for, character for
  character (`mcp_issuer_mismatch`, the mix-up defence of RFC 8414 section 3.3); the issuer must be one
  the resource names and, when `auth.issuer` is set, that one;
- every endpoint in the metadata (token, revocation, authorization, registration, JWKS) must be `https` and
  pass the tenant destination rules and the air-gapped allowlist (`egress_denied`), also those the
  platform does not call today;
- the server must support the configured grant and client authentication method when it
  publishes the lists (`mcp_oauth_unsupported`); a public client (`none`) is not checked against the list;
- for `authorization_code` the server must publish an `authorization_endpoint` and list `S256` in
  `code_challenge_methods_supported` (`mcp_pkce_unsupported`, audited as `pkce_unsupported`).

Refusals are audited as `mcp.oauth.denied` with a closed `code` (`issuer_mismatch`, `resource_mismatch`,
`resource_metadata_origin`, `endpoints_changed`, `egress_denied`, `pkce_unsupported`,
`registration_disabled`, and from the callback `state_invalid`, `iss_mismatch`, `iss_missing`,
`authorization_refused`, `forbidden`).

### Pinning

The first successful authorization pins the **issuer** and the **endpoints** with the tokens
(`mcp_oauth_tokens.issuer`, `endpoints`; migration `0027_mcp_oauth_client_credentials`). They become part of the
connection's effective egress with purpose `identity`: the status shows their hosts, the air-gapped
start-up check requires them (and `auth.issuer`) on `OAX_AIRGAPPED_ALLOW`. Before a token is renewed, the
resource metadata and the authorization server metadata are fetched again (at most once an hour per
connection and credential version) and compared with the pin (issuer, token endpoint and revocation
endpoint: the endpoints the platform calls; the others are stored for display and the air-gapped check). If the resource names another issuer, or any
pinned endpoint moved, **no request is sent**, the token becomes `reauthorization_required` and an
administrator must authorize again (which revokes the old tokens at the old issuer). Changing the URL, the
client block or `auth.issuer` of the connection is the same event: the credential version is bumped, the
tokens are deleted in the same transaction and revoked afterwards. Changing only the scopes keeps the
authorization (a server that wants more answers `insufficient_scope`: `mcp_insufficient_scope`).

### Tokens and scopes

- Every token request carries `grant_type`, `resource` (RFC 8707, the canonical URI, also when the server
  does not advertise support) and `scope`. The client authenticates with `client_secret_basic` (id and
  secret form-encoded before base64, RFC 6749 section 2.3.1) or with `private_key_jwt` (RFC 7523:
  `iss` = `sub` = client id, `aud` = the token endpoint, 60 s lifetime, random `jti`, RS256, PS256, ES256
  with P-256 or EdDSA by key type and what the server lists). Only `Bearer` tokens are accepted; DPoP and
  other types are refused.
- `scopes: "from-profiles"` requests the union of `tools.<name>.scopes` over the tools of the connection's
  profiles; without a mapping the challenge `scope`, else the `scopes_supported` of the resource metadata.
  An explicit list wins. The granted scopes are what the server returns (or what was requested). The
  status flags `scopesWider` when they exceed what the profiles need.
- A server-issued token (access and refresh) must satisfy the
  [token shape rules](#stored-oauth-tokens-and-the-key-service) (length, alphabet, entropy, no
  identifiers) and its `scope` must be valid scope tokens; otherwise the response is refused
  (`mcp_oauth_token_rejected`) before anything is stored or registered with a redactor, so a hostile
  server cannot make the redactors blank ordinary text (a host name, an error code) of the tenant. Client
  secrets and minted assertions are registered with the redactors only if they have that shape too; a weak
  secret stays protected by the run's guard only.
- The token is attached by the **control node** (relay, connection test) or by the **trusted worker**
  (in-process steps), per request, to the exact resource it was issued for; a connection whose URL changed
  meanwhile gets `mcp_resource_mismatch` and no request. A run node never holds a token: the relay answers
  it, with the token redacted from anything the server echoes. A `401` from the server marks the stored
  token expired and fails the call with `mcp_auth_required`; a `403` with `insufficient_scope` fails with
  `mcp_insufficient_scope`.

### Renewal

A token is renewed before use when it expires within 60 s, but never earlier than half of its
lifetime (a 30 s token is renewed after 15 s). One renewal runs at a time per connection: a
process-local single flight plus a PostgreSQL transaction-scoped advisory lock across replicas; a replica
that waited for the lock re-reads the row and finds the new token. A client-credentials connection is always renewed with a
new client-credentials grant (RFC 6749 section 4.4.3); a refresh token such a server may issue is ignored,
so a lost rotated token can never force a manual re-authorization. For the authorization-code grant
(later slice) a stored refresh token is used and a rotated one is written together with the new access
token in one row update inside the lock's transaction (a failure before the commit leaves the previous
pair untouched). The renewal only ever UPDATEs the row it read under the lock and never inserts, and every
deletion of the tokens (disconnect, URL or client change) takes the same advisory lock, so a renewal can
neither overlap a deletion nor bring the token back afterwards. Errors are reduced to the
closed RFC 6749 error code; `error_description` is dropped.

| Outcome | Stored status | Effect |
| --- | --- | --- |
| success | `active` | new token used |
| `invalid_grant`, `invalid_client`, `unauthorized_client`, `invalid_target`, `unsupported_grant_type`, moved issuer or endpoints | `reauthorization_required` | calls fail closed with `mcp_auth_required` until an administrator authorizes again |
| anything else (network, `5xx`, `temporarily_unavailable`) | `active` while the old token is valid, `refresh_failed` once it expired | the old token keeps being used until it expires; the next attempt waits 30 s; an expired token fails with `mcp_auth_refresh_failed` |

Audit: `mcp.oauth.refreshed` / `mcp.oauth.refresh_failed` (connection and closed code). Metric:
`oax_mcp_oauth_refresh_total{outcome}` (`ok`, `invalid_grant`, `reauthorization_required`, `failed`,
`skipped`; no tenant or connection label).

### Revocation

RFC 7009 requests to the pinned revocation endpoint (access token and refresh token, client
authenticated, through the dispatcher), best effort and audited as `mcp.oauth.revoked` with the reason
(`disconnect`, `config_changed`, `connection_deleted`, `reauthorized`) and the remote result (`ok`,
`failed`, `skipped` when the server publishes no endpoint). The local tokens are deleted whatever the
remote result is. A central grant revocation (ADR 0012) has no caller on `main` yet; it will call the same
`prepareRevoke` hook.

### Audit and what is never recorded

`mcp.oauth.discovered` (connection, issuer, resource, endpoint hosts), `mcp.oauth.authorization_requested`
(connection, issuer, grant, scopes, user), `mcp.oauth.authorized` (connection,
issuer, grant, scopes, user), `mcp.oauth.client_registered` (tenant, issuer, method), `mcp.oauth.step_up_required`
(connection, scopes), `mcp.oauth.refreshed`, `mcp.oauth.refresh_failed`, `mcp.oauth.revoked`,
`mcp.oauth.denied`. Names, ids, hosts and closed codes only: never a token, a client secret, a key, an
assertion, a URL path or a server text. Client secrets and minted assertions are registered with the
redactors when they are read, fresh tokens when they are issued (before they are stored or used).

### Authorization code with PKCE

ADR 0016 section 7.2, slice S7. For remote systems that need a person's consent (SaaS MCP servers
without machine clients). An administrator with `connections:write` consents **once per connection
instance**; the tokens belong to the instance, not to the person: every run that uses the connection uses
them, and the console shows "authorized by, at, scopes".

```jsonc
"auth": {
  "kind": "oauth",
  "grant": "authorization_code",
  "client": {
    // pre-registered, public client (PKCE is the proof) ...
    "clientIdSecret": "acme.jira-client-id", "clientAuth": "none"
    // ... or confidential: "clientAuth": "private_key_jwt" + "keySecret", or
    //     "client_secret_basic" + "clientSecretSecret" (then auth.issuer is required)
    // ... or the platform's metadata document:  "registration": "cimd"   (no secrets)
    // ... or dynamic registration:              "registration": "dcr"    (no secrets)
  },
  "scopes": "from-profiles"
}
```

**Flow.** `POST /v1/connections/{id}/oauth/authorize` runs the same discovery as the client-credentials
flow, then refuses an authorization server that does not advertise `S256` in
`code_challenge_methods_supported`. It stores a pending request (table `mcp_oauth_pending`, migration
`0029_mcp_oauth_authorization_code`) and answers with the `authorizationUrl`: `response_type=code`,
`client_id`, `redirect_uri`, `state`, `code_challenge` with `code_challenge_method=S256`, `resource`
(RFC 8707) and `scope`. The console opens that URL. After the consent the authorization server redirects the
browser to `GET /v1/oauth/mcp/callback`, which redeems the code (with the verifier, the exact redirect URI
and `resource`) at the **endpoints pinned when the request started**, stores the tokens for the connection
instance and revokes tokens a re-authorization replaced.

| Property | How |
| --- | --- |
| PKCE | `S256` always, 256-bit verifier from the CSPRNG; never `plain`; the verifier is stored sealed with the tenant data key (AAD: tenant, connection, issuer, resource, credential version, domain-separated from tokens) and never leaves the control node. |
| `state` | 256 bits, stored only as SHA-256, **single use** (the callback deletes the row in the statement that reads it, whatever the outcome), valid for 10 minutes, bound to the person, connection, tenant and credential version. A new request of the same person for the same connection replaces the old one; at most 200 open requests per tenant. |
| RFC 9207 | The callback checks `iss` before it looks at `code` or `error`: `iss` present must equal the issuer the request was started for (exact string, also for error responses); `iss` absent is accepted only when the metadata does not advertise `authorization_response_iss_parameter_supported`. Failures are `iss_mismatch` / `iss_missing`, nothing is redeemed. |
| Redirect URI | Exactly `<OAX_PUBLIC_URL>/v1/oauth/mcp/callback`, computed on the server; no request parameter can change it. `OAX_PUBLIC_URL` must be an `https` origin without path (`http` only for `localhost`/loopback); the console shows the URI so it can be registered at the authorization server. |
| Who | The route needs `connections:write` on the acting tenant. At the callback the person who started the request must still exist, be enabled and hold `connections:write` on that tenant and connection (`forbidden` otherwise, no token request). Platform (central) connections: `authorization_code` is refused at save and at authorize with `central_user_delegation` (a person's consent cannot be shared with the tenants that use a central instance). |
| Callback answer | A redirect to `<OAX_UI_URL>/connections?mcp_oauth=<result>&connection=<id>` (the id comes from the stored request; `result` is one of `ok`, `denied`, `state_invalid`, `state_expired`, `iss_mismatch`, `iss_missing`, `code_invalid`, `token_refused`, `forbidden`, `conflict`, `error`), or without a console URL a page of fixed text. Nothing from the query (error, description, state, code) is echoed; there is no `redirect`-style parameter. The page carries `default-src 'none'`, `frame-ancestors 'none'`, `no-store` and `no-referrer`. |
| Logs | The request log prints the callback path without its query. Neither the state, the code, the verifier nor a token is logged or audited; the audit has names, ids, hosts, scopes and closed codes. |
| Token shape | A token the server issues must have the shape of a credential before anything stores or registers it (as for client credentials). |

**Scopes and step-up.** The requested scopes are the profile scopes (or the explicit list), else the
challenge scope, else `scopes_supported`; `offline_access` is added only when the server advertises it. The
grant can be narrower than the request (the person may untick scopes): `scopesMissing` lists what the
profiles need and the grant lacks, and runs that need them fail closed with `mcp_insufficient_scope`.
When an MCP server answers `403 insufficient_scope`, the connection records the challenge's scopes
(`requiredScopes`), becomes `reauthorization_required` and **fails closed** (`mcp_auth_required`)
until an administrator authorizes again; the new consent asks for the **union** of the granted, the
required and the configured scopes, so no scope is lost, and the replaced tokens are revoked. This is
audited as `mcp.oauth.step_up_required`. A grant without a refresh token cannot be renewed: when the
access token expires the connection becomes `reauthorization_required` (it never falls back to another
grant).

#### Refresh token rotation

A refresh token may be single use. The renewal reads the stored pair under the advisory lock, asks the
server, and writes the new pair over exactly that row in the same transaction; the previous pair stays
in the row until then. If the write or the commit fails after the server answered, the commit is retried
in new transactions (three attempts, 250 ms, 1 s and 3 s), and a pair that still cannot be stored is kept
in memory (it is already registered with the redactors) and written, without a new request, by the next
renewal. If the row changed or the connection was deleted meanwhile, the new tokens are revoked at the
server. A crash between the server's answer and the first commit loses the pair; the server's reuse
detection then ends in `invalid_grant` and `reauthorization_required`, never in a token held by nobody.

#### Client ID metadata document (`OAX_MCP_OAUTH_CIMD=true`)

The platform publishes one document per installation at `<OAX_PUBLIC_URL>/oauth/mcp-client.json`
(`client_id` equals that URL, `redirect_uris` is the callback, `token_endpoint_auth_method: none`). It is
used only for `authorization_code`, only when the server advertises `client_id_metadata_document_supported`
(`mcp_oauth_unsupported` otherwise), and needs a public `https` `OAX_PUBLIC_URL` (start-up refuses it
otherwise). It contains no secret and nothing tenant-specific. Off by default; refused at start-up and at
save when off or air-gapped.

#### Dynamic client registration (`OAX_MCP_OAUTH_DCR=true`)

Off by default (the MCP specification deprecates it). When on, the first consent registers a client
(RFC 7591: `application_type: web`, the single callback URI, a public client when the server lists `none`,
else `client_secret_basic`) **per tenant and authorization server**; the next connection of the tenant at
that issuer reuses it, other tenants never share it, a changed `OAX_PUBLIC_URL` registers again. The
registration endpoint goes through the same destination checks as the other pinned endpoints (it is
pinned, `egress_denied` for internal hosts). The response is untrusted: the redirect URIs it states must be
exactly the callback, the client id must be printable ASCII, a secret must have the shape of a credential
and is stored sealed. Audited as `mcp.oauth.client_registered`.

#### Metrics

`oax_mcp_oauth_authorize_total{outcome}` with a closed set (`started`, `ok`, `state_invalid`,
`state_expired`, `iss_mismatch`, `iss_missing`, `denied`, `token_refused`, `forbidden`, `conflict`, `error`);
no tenant or connection label.

### Known limits

- The redactor registry is per process (#304); a platform connection used by a tenant's run keeps its
  token under the platform tenant, so tenant-scoped scrubbing of that tenant's audit/response text does not
  know it (the run's guard and the tenant-less log rule still do).
- A process that dies between the authorization server's answer to a refresh and the commit loses the
  rotated refresh token (see [Rotation](#refresh-token-rotation)); the connection then needs a new consent.
  Client-credentials connections are not affected (they never use a refresh token).
- The callback has no session (a browser redirect carries no bearer token). It trusts the single-use
  `state` alone, which is bound to the person, connection and tenant that started the request, so a
  victim who is tricked into opening someone else's authorization URL consents on that person's
  connection, never on their own (consent phishing is inherent to OAuth; the connection shows who
  authorized it and every consent is audited).
- Authorization code on a central (platform) instance is refused by design (`central_user_delegation`).

## Control-node relay for run nodes

ADR 0016 section 6 (slice S4); decides ADR 0012 open question 2. A run node never connects to an
HTTP MCP server and never holds its header secrets or tokens: the node's MCP client talks to the
control node, which holds the credentials and makes the call.

```text
node MCP client -- POST /v1/worker/runs/{id}/mcp/{server} (step-scoped run token) --> control node
                                                      session, grants, gate, approval, pin, guard
                                                      credentials resolved here, S1 dispatcher --> HTTP MCP server
```

- **Every** `streamable-http` connection of a step used by a run node goes through the relay; there is
  no fallback and no switch (a node of an older image fails closed, see below). The node needs no
  egress for HTTP MCP servers, and `runtime.egress` no longer has to list them.
- **What the node is told**: the handover announces `http: { relay: true }` and carries, for an HTTP
  server, only the tool classes and profiles: the `url` (a token may sit in its query string), the
  headers, `headerSecrets` and `egress` are replaced (`url` becomes `https://mcp-relay.invalid/`). The
  credential broker (`POST /v1/worker/runs/{id}/credentials`) no longer carries `headers`; it hands out
  `envSecrets` of stdio servers and the step's declared credentials only. Platform connections
  with header secrets used to be refused for nodes (`platform_secret`); through the relay they work,
  so a central shared-credential HTTP instance is usable from a node, with the operator's secrets
  never leaving the control node.
- **Methods** (JSON-RPC 2.0, one message per request, strict fields): `initialize`, `ping`, `tools/list`,
  `tools/call` and the notifications `notifications/initialized` and `notifications/cancelled`
  (`202`). Anything else is refused with `mcp_method_not_allowed`; `sampling/createMessage`,
  `elicitation/create` and `roots/list` with `mcp_capability_unsupported`. A server that asks the
  platform for sampling, elicitation or roots fails the call that needed it with
  `mcp_capability_unsupported` (the client declares no such capability; this also holds for
  in-process calls). Streaming results and server-initiated messages are not relayed: the control
  node reads the whole result (SSE included) and returns one JSON answer. `initialize` is answered by
  the relay itself (it announces `tools` only) and does not touch the server.
- **`tools/list`** returns the verified list: for a pinned server the tools the pin covers (the node
  recomputes the same digest), otherwise the tools the step holds grants on. The verdict is taken once
  per session. A changed tool fails with `mcp_tools_changed`, is recorded by the control node
  (`mcp.tools.changed`, pending snapshot, `oax_mcp_tools_changed_total`) and none of the server's tools
  is available.
- **`tools/call`** is checked again on the control node, because a node is not trusted to have asked:
  the step must hold a grant (`policy_denied` otherwise); the policy gate decides with the same rules as
  `POST /v1/worker/runs/{id}/gate`; a `require_approval` decision passes only with an **approved
  approval for exactly this call** (run, step, tool and the arguments as the approver saw them, that
  is with secret values redacted), used **once**
  (`approvals.consumed_at`, `approval_required` otherwise); the pin is verified; the call leaves through
  the S1 dispatcher (purpose `mcp`, tenant rules, pinned DNS, no redirects, response cap) with the
  connection's own origin class; the result is guarded with the secret values the connection resolved,
  so a server that echoes its token back is redacted before the node sees it. The values a connection
  url can carry (query parameters, user info) count as secrets too, and this redaction stays on when
  `OAX_REDACT_MODEL_CONTEXT` is off (that switch is about the model context of trusted processes).
- **Refusals look alike.** No or a bad token, an expired or revoked node session, a token of another
  run or of the orchestrator, a run that ended or lost its lease, a server the step holds no grant on,
  a connection of another tenant, an unknown name: always `404 {"error":"not_found","message":"MCP server not
  found"}`. The reason is in the audit log (`mcp.relay.refused`, at most 20 per node session) and
  never in the answer. A platform connection's errors reach the node as a code without server text.
- **Sessions** are keyed `(tenant, connection, credential version, run)`. The credential version
  hashes the connection's last change and the current values of its header secrets, so rotating a secret
  or editing the connection opens a new session and the old one is never used again (only the hash is
  kept). Sessions close when idle (`OAX_MCP_RELAY_IDLE_SECONDS`), when the run's node session is revoked
  on the same replica, when the replica evicts the least recently used one for a new one, and on
  shutdown; a session of a revoked node session is unusable anyway because every request re-checks the
  database.
- **Limits** (per session, i.e. per run and connection): concurrent calls
  (`OAX_MCP_RELAY_CONCURRENCY`, default 4, `429 mcp_relay_busy`), calls per minute
  (`OAX_MCP_RELAY_RATE_PER_MINUTE`, default 120, `429 rate_limited`), call time (the connection's
  `timeoutMs`, with a hard stop of three times that plus 2 s so that a stuck call always frees its
  slot), result size (the connection's `maxResultBytes` for the text; structured content larger than
  that is left out; a tool list over 1 MiB fails with `mcp_result_too_large`), request body
  (`OAX_MCP_RELAY_MAX_REQUEST_BYTES`, default 1 MiB, `413`; strict JSON: duplicate keys, `__proto__`
  and deep nesting are refused), the time to deliver it (`OAX_MCP_RELAY_BODY_READ_SECONDS`, 15 s, then the
  connection is closed) and open sessions per replica (`OAX_MCP_RELAY_MAX_SESSIONS`, default 256,
  `503 mcp_relay_busy` when all are in use). A node that disconnects cancels its upstream call.
- **Old images fail closed.** The bundle every container node receives (`oax-bundle:v3`, the same
  marker for the Kubernetes Secret) is not a URL and an unknown version for a node from before the relay,
  which refuses to start (`config_invalid`) instead of dialling the server without credentials. A new node
  refuses a bundle of marker `v2` and a handover with HTTP servers that does not announce the relay.
- **Audit and metrics.** `mcp.relay.call` for every tool call (tool, outcome, size, duration, guard
  counts), `mcp.relay.denied`, `mcp.relay.refused`. `oax_mcp_relay_requests_total{method,outcome}` (method
  `initialize|tools_list|tools_call|other`; outcome `ok|refused|denied|approval_required|tools_changed|
  unsupported|rate_limited|busy|timeout|error`) and `oax_mcp_relay_sessions`; no tenant, connection,
  tool or server label. A grant with `maxCallsPerRun` is counted from the relay's own audit entries as
  well as from the node's step reports, so a node that does not report its calls cannot exceed it (calls
  in flight at the same moment can overshoot it by up to the session's concurrency).

Every request of a node session is also throttled before any database or secret read
(twice `OAX_MCP_RELAY_RATE_PER_MINUTE` per minute, `429 rate_limited`), and every answer of the relay
route, refusals of the token check included, carries `cache-control: no-store` and the same
rate-limit headers.

Approval requests whose arguments the scrubber changed (`[REDACTED]`) are flagged
(`argsRedacted` on `GET /v1/approvals`, in the `approval.requested` audit entry and as a note on the
approval card), so approvers know the call has more than they see.

Migration `0025_approvals_consumed_at` adds the single-use column (approvals decided before the
upgrade are marked used, so the relay cannot spend them) and the `args_redacted` flag; the
down script drops both. Configuration: [`configuration.md`](configuration.md).

**What this does not do.** The relay trusts the connection's server like an in-process call does:
a malicious server can still return text that is only filtered by the context guard. Stdio servers
are not relayed (they run in the node). The credential version reads the secret store on every request,
a slow store slows the relay down. Replay of a request is harmless (`tools/call` is as idempotent as the
tool; the approval is single use). The limits and sessions are per replica.

## Stdio MCP servers

A `stdio` connection starts a child process. Who defined the connection decides where it may run and
what it may start (ADR 0016 section 3).

| Connection scope | Where it may run | Rules for `command`, `args`, `env` |
| --- | --- | --- |
| `platform` (operator) | worker process or run node | none: operator configuration, like any binary of the worker image |
| `tenant`, `team`, `agent` | **run nodes only** (`container`, `kubernetes-job`) | the rules below |

**Where.** A step on `in-process` or `local` (the pipeline default, or `agents[].runtime.runner`)
that holds a grant on a tenant-defined stdio connection is refused at publish with
`mcp_stdio_requires_isolation` (`POST /v1/agents/validate` reports it as well). The worker repeats
the check before it builds its gateway, so versions published earlier fail the run with the same
code and an audit entry `mcp.stdio.refused`; the worker's gateway additionally refuses to start any
stdio server that is not a platform one. Fix: `runtime.runner: container` (or `kubernetes-job`) for
those steps.

**What may be started** (checked when the connection is created or updated, again by the control
node when a run node is prepared, and by the run node against its own image):

1. `command` is an absolute, normalized path (no `.`, `..`, `//`, trailing `/`; no `PATH` lookup).
2. The path is listed in the operator allowlist `OAX_MCP_STDIO_COMMANDS`: comma-separated absolute
   files or `dir/*` (files directly inside `dir`, not below). The default is empty: no tenant stdio
   command. Entries that are relative, contain other glob characters, name a system directory as
   prefix (`/*`, `/usr/bin/*`, `/bin/*`, `/opt/*`, ...), or lie in or below a temporary, virtual or
   run-writable directory (`/tmp`, `/var/tmp`, `/dev`, `/proc`, `/sys`, `/run`, `/workspace`,
   `/work`; even a single file there) fail start-up. Use dedicated directories of reviewed
   binaries.
3. Symlinks and writability are checked by the **run node**, which holds the binaries: it resolves
   `command` (and the program file of an interpreter, rule 5) with `realpath`; the **real path must
   also be allowlisted**, so a link cannot lead out of the list (list the target too when you
   install via links), and the real file's name is checked against rules 4 and 5. A file that is
   missing in the node image, or that the node process could change (the file or its directory is
   writable, so it could be replaced between the check and the start), fails the step. The run
   node's root file system is read-only (container runner), so files of the image pass. The
   control node checks the literal path only: it never resolves tenant-chosen paths on its own
   host, so connection errors do not reveal which files exist there.
4. Refused whatever the allowlist says (`mcp_command_forbidden`), by the lower-cased name of the file
   and of its real path, with a trailing version and `.exe/.cmd/.bat/.com/.ps1` removed (`pip3.11`,
   `python3.12`):
   - shells and multi-call binaries: `sh bash zsh dash ash ksh csh tcsh fish busybox toybox coreutils
     cmd powershell pwsh`, and programs that execute their arguments: `env sudo su doas xargs nohup
     timeout nice setsid chroot nsenter strace gdb find awk sed make tar rsync vim less man ...`,
     init and privilege wrappers of container images (`tini dumb-init catatonit gosu su-exec capsh
     prlimit ...`), process runners (`cross-env concurrently nodemon pm2 just task ...`) and
     database shells or calculators with a shell escape (`sqlite3 psql mysql mongosh dc R ...`);
   - run-time installers and package managers: `npx npm pnpm pnpx yarn bunx bun uvx uv pip pipx
     poetry conda gem cargo go composer apt apk dpkg brew corepack mvn gradle ...` (`bun` installs
     missing packages at run time by default);
   - container, network and VCS tools: `docker podman nerdctl kubectl helm curl wget nc socat ssh
     scp telnet openssl git svn`; the dynamic loader (`ld-linux*.so`, `ld.so`, musl's `libc.musl*`);
   - interpreters that take their program on the command line (`tclsh jshell Rscript irb erl ...`).
5. Interpreters that are useful for real servers (`node`, `python`, `perl`, `ruby`, `php`, `lua`,
   `java`, `deno`, `dotnet`, and `tsx`/`ts-node`/`zx` on top of node) are accepted only when they
   run a **program file that is itself allowlisted** (strict default): listing `node` allows
   nothing by itself, `node /opt/mcp/jira/server.js` needs `/opt/mcp/jira/server.js` (or
   `/opt/mcp/jira/*`) in the list as well. The program file is the first argument after the
   interpreter options; only options that cannot take the next argument as their value may stand
   before it (long options as `--name=value`, and per interpreter a short list such as
   `--enable-source-maps`, python `-u -B -I -Wx -Xy`, java `-Xmx.. -Dk=v` followed by
   `-jar <file>`, `deno run --allow-...`). Therefore `python -m module`, `java -cp ... Main`,
   `dotnet <tool>` and relative program paths are refused. Arguments that inject or load code are
   refused anywhere before a `--`: `node -e/-p/-r/-i/--eval/--print/--require/--import/--loader/
   --env-file/--openssl-config/--experimental-config-file/--snapshot-blob/--inspect*/--run`,
   `python -c/-i`, `perl -e/-E/-M/-I/-x/-S`, `ruby -e/-r/-I/-x/-S/-C`,
   `php -r/-d/-c/-z/-S/--php-ini`, `java -javaagent/-agentlib/@argfile/--class-path=...`,
   `deno` sub-commands that evaluate or install, `--preload`/`--env-file`/`--import-map`, and URL or
   specifier arguments (`https:`, `npm:`, `jsr:`, `data:`), a bare `-` (program from stdin). Short
   options are matched inside clusters (`-Sc`) and with attached values (`-ecode`), long options
   with `_` read as `-`. Arguments are scanned up to a `--`; an option of the program itself such
   as `node server.js -e x` is refused too (deliberate: the scan does not know where the program's
   own arguments start).
6. At most 64 arguments of 4096 characters, no NUL bytes. There is no field for a working
   directory, shell or uid (the schema rejects unknown keys); the child starts in the process
   directory with `env` plus `PATH` only.
7. `env` and `envSecrets` names must be valid identifiers and not reserved: the reserved names of
   `agents[].credentials` (`PATH HOME USER SHELL PWD TMPDIR LANG NODE_OPTIONS NODE_PATH`, proxy
   variables, `OAX_*`, `LD_*`, `DYLD_*`) plus other loader and interpreter hooks (`BASH_ENV ENV
   IFS PYTHON* PERL5* RUBYOPT JAVA_TOOL_OPTIONS CLASSPATH GIT_* NODE_* NPM_* PIP_* UV_* XDG_*
   SSL_CERT_* GLIBC_* MALLOC_* OPENSSL_* DOTNET_* CORECLR_* COMPLUS_* QT_* GTK_* GIO_* GST_*
   SSH_* KRB5* ...`), compared case-insensitively (`https_proxy`).

Allowlist the binary, not a launcher: `/opt/mcp/bin/jira-mcp` is a fine entry, `/usr/bin/env` and
`/bin/sh` are never accepted, and a wrapper script is as trusted as everything it calls. The
allowlist is the wall; the name rules of 4, 5 and 7 are a second, best-effort layer and cannot be
complete: a shell copied or hard-linked under another name (`/opt/mcp/bin/helper` that is `bash`),
a script whose shebang or body runs its arguments (`exec "$@"`), or a server that reads a
configuration file named in its arguments is only as safe as the operator's review of that file.
The allowlist is only as safe as the directories it names: do not list a directory a run can write
to.

**Who manages platform connections.** Creating, changing and deleting a `platform` connection needs
platform operator access, also for an administrator of the tenant that stores it (the operator's
home tenant): platform stdio servers are exempt from the rules above and start in the worker.

**Existing connections.** Nothing is deleted or rewritten. A stored tenant stdio connection that
breaks the rules is reported at start-up (warning and gauge `oax_mcp_stdio_violations`), listed by
`GET /v1/connections/stdio-violations` (own tenant), shown as `warnings` on `GET /v1/connections`,
and refused at run time with `mcp_command_forbidden` (the run fails with the reason; audit entry
`mcp.stdio.refused`, metric `oax_mcp_stdio_refused_total{code}`). Fix it with `PUT` after the
operator listed the binary, or delete it.

**Air-gapped mode.** The air-gapped guard patches the sockets of the Node process; a child process is
invisible to it. Start-up (and creating a connection) therefore refuses platform stdio connections
unless `OAX_AIRGAPPED_STDIO=trusted` acknowledges that those servers share the worker's network, and
refuses tenant stdio connections unless an isolating runner (`container`, `kubernetes-job`) is
enabled, because those run only in nodes. What a node's network is, precisely: with the container
runner the node sits on an `internal` Docker network without a gateway, so TCP and UDP to other
destinations fail and HTTPS leaves only through the egress proxy. Each stdio server has its own
grant there (see "Egress of stdio servers"), whose entries must be plain hosts on
`OAX_AIRGAPPED_ALLOW` (wildcards and CIDRs are refused in air-gapped mode), and the proxy ceiling
must lie within the allowlist. Names are not resolved by the node (see "DNS"). With the Kubernetes
runner the per-node NetworkPolicy applies to the whole Pod, and `OAX_K8S_DNS_EGRESS=true` opens
kube-dns only with `OAX_K8S_DNS_EGRESS_ACK=true`.

**Upgrading (egress accounts).** When egress accounts are sent, line 2 of the node's stdin is the
marker `oax-bundle:v2`. A run-node image from before ADR 0016 S2 reads it as the step's proxy URL
and refuses to start (`config_invalid`), so a mixed install fails closed instead of handing the
step's account to every server. Bundles without egress are the bare token, as before.

**Upgrading.** The step handover carries a new field `stdio` when a tenant stdio server is
involved. Run-node images older than this change reject the unknown field (strict schema) and fail
such steps closed; update the worker and run-node images together. Steps without tenant stdio
servers are unaffected.

## Egress of stdio servers

A stdio server has **no network** unless its connection says otherwise (ADR 0016 section 4.1, slice
S2). The optional `egress` list (the grammar of `runtime.egress`: `host`, `host:port`, `*.suffix`,
address or CIDR) names the hosts the server itself needs:

```json
{ "transport": "stdio", "command": "/opt/mcp/bin/jira-mcp", "egress": ["acme.atlassian.net"] }
```

**Who may widen it.** For tenant, team and agent connections the entries must lie inside the
operator's grant for the program, `OAX_MCP_STDIO_EGRESS` (JSON object, program path to entries; the
program is the command, or for an interpreter the program file it runs). A program without a grant
gets no network, whatever a tenant writes (`422 egress_denied`), and an update can only narrow.
The operator's own (platform) connections choose freely. Further bounds, from the inside out: the
runner ceiling `OAX_CONTAINER_EGRESS_ALLOW` (applied by the runner **and** again by the egress
proxy), the proxy's address check (private, loopback and metadata addresses stay closed unless the
operator opened a range with `OAX_CONTAINER_EGRESS_PRIVATE_ALLOW`) and, air-gapped, the
allowlist. A malformed entry is `400 mcp_egress_invalid`. The control node checks the list when
the connection is saved **and again before every step** (a stored connection that no longer passes
fails the step with `422 egress_denied`, audit `mcp.egress.refused`, no node is started).

**What the container runner does.** It mints one egress grant per (node, connection), signed and
bound to the account `<node id>.<connection name>`, and the run node gives that URL to that server's
process only (`HTTPS_PROXY` and the other spellings). The step's own account is never passed to an
MCP server; a server without `egress` receives no proxy variable at all; proxy variables that a
connection, the credential broker or the step's credentials try to set are dropped. A grant is
valid only under its own account, so a server cannot use another server's or the step's account,
and the proxy counts connections per account (`EgressProxy.connectionCounts()`).

**Kubernetes.** A NetworkPolicy applies to a whole Pod, so the runner cannot give one server its
own network, so a server **without** `egress` can still reach every CIDR the Pod's policy opens
through raw sockets (there is no proxy variable to withhold; the NetworkPolicy is the only wall).
It accepts a server's `egress` only if the step's `runtime.egress` already lists each
entry (otherwise the step is refused) and does not widen the Pod's policy. Per-server isolation
needs the container runner (or, later, one Pod per server, ADR 0016 section 3.3).

**DNS.** The container runner starts every node with `Dns: ["127.0.0.1"]`, where nothing listens, and
`assertSafeCreateBody` refuses any other resolver, search domain or option. Container names on the
internal network still resolve through the engine's embedded resolver, but nothing is forwarded
upstream: a node cannot resolve an external name, so names cannot carry data out, and the egress
proxy resolves the host of a `CONNECT`. The control node and the proxy must therefore be reachable by
container name/alias or IP address. On Kubernetes DNS egress is off by default (see above).
Checked by hand on a Docker host (an `internal` network, alpine): an external name failed
(`SERVFAIL`) with and without the setting, and container names and aliases resolved in both cases,
so on that engine the setting makes explicit what the internal network already did; it does not
depend on that engine behaviour or on how the network was created (the runner also refuses a
network that is not `internal`).

**Lint.** `POST /v1/agents/validate` reports the warning `egress_unused` for a host in a step's
`runtime.egress` of a step on the container runner that may only serve a stdio server with its own
`egress`: the step's account no longer reaches it. Kubernetes steps are not reported (there the
entry must stay in `runtime.egress`). Hosts of HTTP MCP servers are not reported: a node does not
connect to them at all, the control-node relay (slice S4) does, so they never belong in
`runtime.egress`.

**What this does not do.**

- Children of one node run as the same UID and can read each other's environment through
  `/proc/<pid>/environ`, including the proxy account (#140). The per-server grant stops honest and
  buggy servers and simple supply-chain payloads, not a determined attacker inside the node; run
  untrusted servers in containers of their own (ADR 0016 section 3.3, not implemented yet).
- Platform stdio servers that run in the worker process (in-process steps) share the worker's
  network; `egress` has no effect there (operator responsibility; air-gapped mode needs
  `OAX_AIRGAPPED_STDIO=trusted`).
- A grant is a **host-level** allowance on port 443 (or the given port): the proxy relays TLS
  bytes and cannot see what a server sends to an allowed host.
- There is no connection-type catalog yet (ADR 0012), so the floor of a catalog type is the
  operator's `OAX_MCP_STDIO_EGRESS` per program. The proxy ceiling and the air-gapped allowlist are
  enforced as described; a signed-image check of toolbox binaries is separate (#29).
- The real-engine test (zero unexpected connections, raw socket and DNS from a node refused) is
  opt-in (`OAX_TEST_DOCKER=1`, `packages/runners/test/container.integration.test.ts`); the
  unit tests cover the proxy accounts and the run node, not the kernel's network namespace.

**Not covered yet** (later ADR 0016 slices): the shared UID of a node's children and signed toolbox
images.
