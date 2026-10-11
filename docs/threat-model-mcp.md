# Threat model: MCP egress and authorization

This page summarizes what the platform defends against when it talks to MCP servers
([ADR 0016](adr/0016-mcp-egress-and-authorization.md), slices S0 to S8), where each defence is
enforced, how it is tested, and, as important, what it does **not** cover. The mechanisms
themselves are described in [`mcp.md`](mcp.md); air-gapped specifics in
[`airgapped.md`](airgapped.md); model-context hardening in
[`security-input-hardening.md`](security-input-hardening.md).

## What is trusted

| Party | Trust |
| --- | --- |
| api, worker (control node) | Trusted. Hold database credentials, the run-token secret, the key-encryption key and, while a call is made, OAuth tokens. They never start a tenant-defined command. |
| Run node (container, Kubernetes Job) | **Untrusted.** Holds a step-scoped run token, nothing else. No database, no KEK, no OAuth token, no header secret of an HTTP MCP server. |
| stdio MCP server inside a node | Untrusted. Same network and UID rules as the node, narrowed per server (see below). |
| Remote MCP server, authorization server | Untrusted. Their answers (tool definitions, metadata documents, redirects, results, error text) are attacker-controlled data. |
| Tenant administrator | Semi-trusted: can create connections of their own tenant, cannot widen operator ceilings. |
| Operator | Trusted. Sets the stdio command allowlist, the egress ceiling, private ranges, the KEK. |

## Boundaries and who enforces them

```text
tenant admin --> connection config --> control node (checks at save and before every step)
                                           |  HTTP MCP / OAuth: dispatcher (https, public address,
                                           |  pinned DNS, no redirects, size and time limits)
                                           v
 run node --(run token)--> relay on the control node --> remote MCP server
     |  stdio servers: own proxy account per server --> egress proxy --> allowed hosts only
     x  no route, no DNS, no OAuth token, no header secret
```

## Threats, status and evidence

"Real engine" means the opt-in suite described [below](#evidence-what-was-run-and-what-was-not);
"unit" means the normal test run (`pnpm test`).

| # | Threat | Status | Main defence | Evidence |
| --- | --- | --- | --- | --- |
| T1 | Malicious or compromised MCP server exfiltrates data | Mitigated for HTTP servers and for stdio servers with a grant; **not** for a server you run on the worker, and not against a determined server inside a shared node | Per-connection egress, relay, no secrets in nodes, result guard | real engine (egress), unit (`mcp-stdio-egress`, `mcp-relay`) |
| T2 | Tool poisoning (instructions in names, descriptions, schemas) | Partly: reviewed at pin time, hidden characters change the digest; the review is a human step | Snapshot review, ContextGuard | unit (`tool-pin`), real engine (rug pull) |
| T3 | Rug pull (definitions change after approval) | Mitigated for HTTP connections (fail closed, none of the connection's tools exposed). **stdio and in-memory servers are not pinned.** | Digest pin per version, re-approval | real engine, unit |
| T4 | SSRF through MCP URLs, metadata URLs, token endpoints, redirects | Mitigated for tenant connections. Operator-defined (platform) connections follow operator rules and server-derived URLs are trusted like the connection (#313 F6) | Dispatcher: https only, public addresses only, `redirect: error`, size and time limits | real engine, unit |
| T5 | DNS rebinding between check and connect | Mitigated: every address a lookup returns is checked and the checked address is dialled; a flipped answer is refused. Behind an HTTP proxy the proxy resolves again (ADR 0011) | Pinned lookup | real engine (real resolver) |
| T6 | DNS exfiltration from a node | Mitigated on the container runner (non-forwarding resolver). Kubernetes: off by default, opt-in with acknowledgement | `Dns: 127.0.0.1`, `OAX_K8S_DNS_EGRESS_ACK` | real engine (container runner); Kubernetes only rendered and unit-tested |
| T7 | Token theft (logs, errors, audit, API, step records, spans, node environment) | Mitigated by construction (tokens exist only in api and worker) and by redaction as a net. The net has known gaps (see residual risks) | Control-node-only tokens, envelope encryption, redactors | real engine (canaries), unit (`mcp-oauth-canary`, worker canaries) |
| T8 | Confused deputy, authorization-server mix-up | Mitigated: tenant-keyed tokens, pinned issuer, RFC 9207 `iss` check, `state`, PKCE, consent per instance | OAuth flow | unit (`mcp-oauth-*`); not part of the real-engine suite |
| T9 | Token passthrough | Mitigated: platform tokens are never forwarded; OAuth tokens carry `resource` and are sent only to that URI. Static `headerSecrets.authorization` is whatever the operator stored | Resource binding | unit |
| T10 | Cross-tenant use of a connection or token | Mitigated for OAuth tokens (AAD binding, tenant keys); central instances do not use user-delegated tokens | Key service | unit |
| T11 | Prompt injection through tool results | **Not solved.** Reduced by least privilege, approval gates, egress limits and the guard | ContextGuard, policy gate | unit |
| T12 | stdio server escapes via the network | Mitigated per server on the container runner. **Not** on Kubernetes (one policy per Pod). Platform stdio servers in the worker share the worker's network | Per-server proxy account, internal network | real engine (egress) |
| T13 | Supply chain of MCP server binaries | Partly: allowlist of absolute paths, run-time installers refused, no installation at run time. Image signing and SBOM are separate (#29). No `container` transport yet | `OAX_MCP_STDIO_COMMANDS` | unit |
| T14 | Setup phase as a side door | Not applicable: there is no setup phase, and a `setup` key is refused | Strict schema | unit |

## Residual risks

These are known, accepted for now, and tracked. None of them was introduced by the abuse suite and
none was fixed by it.

**Isolation**

- stdio servers of one node share a UID and can read each other's environment, including the
  proxy account (#140). The per-server grant stops honest and buggy servers and simple
  supply-chain payloads, not a determined attacker inside the node. The strong wall (a `container`
  MCP transport, ADR 0016 section 3.3) is **not implemented**; until then keep third-party servers
  out of nodes that also run something you care about.
- On Kubernetes a server without `egress` still has the Pod's raw network (a NetworkPolicy applies
  to the whole Pod); the runner accepts a server's `egress` only if the step already lists it.
- Platform stdio servers run inside the worker process tree and share its network. In air-gapped
  mode that needs `OAX_AIRGAPPED_STDIO=trusted`.
- An egress grant is host-level: the proxy relays TLS bytes and cannot see what a server sends to
  an allowed host. Behind an HTTP proxy for model or MCP traffic, the proxy resolves names itself.

**Tool definitions**

- Pinning covers the six fields the model sees, for HTTP connections only. Servers with more than
  500 tools cannot be pinned. `OAX_MCP_REQUIRE_TOOL_PIN` defaults to `false`, so versions published
  before pinning run (with an audit warning) until the operator turns it on.
- There is no outbound notification channel: a changed definition shows up in the audit log, the
  console badge and a metric.
- The credential scan of fetched definitions is a safeguard, not a guarantee.
- Tool **results** are not pinned or reviewed; they are only guarded.

**Redaction of stored tokens (a net, not the control)**

- The redactor registry is per process (#304) and responses that aggregate tenants use the caller's
  tenant only (#307).
- A value shared by two tenants is redacted for one of them, hex and base64url spellings are not
  indexed in logs, audit and responses (the run's ContextGuard covers model context only), escaped
  slashes are not matched, and the automaton cache has an eviction weakness (#309).
- A platform connection's token is registered under the platform tenant, so tenant-scoped scrubbing
  of a tenant whose run used it does not know it (#313 F7).
- A live node test of the "no token in a node" property exists only in the narrow form described
  below; the end-to-end version needs the worker image (#305).

**OAuth and key management**

- Renewal holds a database connection during the token request, up to 10 s (#313 F5).
- Platform OAuth connections trust the URLs their server's metadata names (#313 F6); tenant
  connections do not.
- After a credential-version conflict a freshly issued token may stay valid at the token server
  (#313 F8). Revocation assertions use the revocation endpoint as audience.
- Abandoned consents are not reaped, DCR client lifetime is not handled, pending rows are not fully
  sealed to user, redirect URI and endpoints, concurrent step-up 403s can lose a scope set (#319).
- The key service has no nonce usage counter or data-key rotation, no KEK rotation, and crypto
  shredding does not cover backups (#303).
- Access tokens are opaque to the platform; audience validation is the server's duty. DPoP and
  per-end-user delegation are not supported.

**Operations**

- Relay sessions and limits are per api replica; the relay reads the secret store on every request.
- A stdio command allowlist is only as good as the binaries on it; name-based deny lists for shells
  and installers are a best-effort second layer.

## Evidence: what was run and what was not

The real-engine suite lives in `apps/api/test/mcp-abuse-*.integration.test.ts` and is **opt-in**
(`OAX_TEST_DOCKER=1`, never part of `pnpm test`). How to run it and what each file proves is in
[`mcp.md`](mcp.md#abuse-suite-against-a-real-container-engine). In short:

- It runs the real `ContainerRunner`, the real `EgressProxy`, the real outbound dispatcher, the real
  gateway, pinning code and OAuth discovery against lab servers in throwaway Docker containers.
- It does **not** run the platform's own run-node program (that needs the worker image), the
  Kubernetes runner, Podman, an air-gapped full run with an allowlisted MCP server, or the OAuth
  authorization-code flow against a container. Those stay covered by unit tests only.
- Passing is not a proof of absence: the suite shows that the listed attacks failed against the
  listed lab servers on one engine.
