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
| `tenant`, `team`, `agent` | **https only**; no `localhost`, no loopback, link-local, private, CGNAT, multicast or cloud-metadata address in any spelling (`169.254.169.254`, `2852039166`, `0xa9fea9fe`, `0251.0376.0251.0376`, `[::ffff:169.254.169.254]`, `[fd00:ec2::254]`, ...), no metadata host name. Only the platform can open a private range, with `privateAllow` in the network configuration (never loopback, link-local or metadata). |

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

Run nodes: the control node tells the node which HTTP servers a tenant defined (`http.tenantServers`
in the step handover); the node applies the tenant rules to them by name and literal address, and
the egress proxy of the node resolves and enforces the destination. The control-node relay of
ADR 0016 S4 will take HTTP servers out of nodes altogether.

### Test a connection

`POST /v1/connections/{id}/test` on an `mcp` connection (no body needed) runs `initialize` and
`tools/list` through the same path as a run and answers with a **category only**:

```json
{ "ok": false, "category": "egress_denied", "latency": "<100ms" }
```

Categories: `ok`, `config_invalid`, `egress_denied`, `dns_failed`, `connect_failed`,
`proxy_refused`, `tls_untrusted`, `tls_hostname_mismatch`, `auth_failed` (401/403), `http_error`
(with `httpClass` `4xx` or `5xx`), `protocol_error`, `timeout`, `error`. On success `toolCount` is
the number of listed tools. There is no response body, header, address, error text of the server,
tool name or description and no exact timing in the answer or the audit entry (`connection.tested`
with the category). It takes no URL (only a stored connection), is limited to 10 tests per minute
per user and replica, needs `connections:write`, tests a platform connection only for platform
operators, and refuses stdio connections (`400 mcp_test_unsupported`: a test would start a process).

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
destinations fail and HTTPS leaves only through the egress proxy with the **step's** grant (every
stdio server of the step shares it, and in air-gapped mode the proxy ceiling must lie within
`OAX_AIRGAPPED_ALLOW`); name resolution is not locked down yet (Docker's embedded resolver may
forward queries, a possible DNS exfiltration channel, ADR 0016 section 4.5, slice S2). With the
Kubernetes runner the per-node NetworkPolicy applies, and `dnsEgress: true` opens kube-dns.

**Upgrading.** The step handover carries a new field `stdio` when a tenant stdio server is
involved. Run-node images older than this change reject the unknown field (strict schema) and fail
such steps closed; update the worker and run-node images together. Steps without tenant stdio
servers are unaffected.

**Not covered yet** (ADR 0016 slices S2 and later): per-server egress rules (every stdio server of a
step shares the step's egress grant), the shared UID of a node's children, and signed toolbox
images.
