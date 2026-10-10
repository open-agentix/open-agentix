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
   command. Entries that are relative, contain other glob characters, or name a system directory as
   prefix (`/*`, `/usr/bin/*`, `/bin/*`, `/tmp/*`, `/workspace/*`, ...) fail start-up. Use dedicated
   directories of reviewed binaries.
3. Symlinks: the run node resolves `command` with `realpath`; the **real path must also be
   allowlisted**, so a link cannot lead out of the list (list the target too when you install via
   links), and the real file's name is checked against rules 4 and 5. The control node resolves the
   path only when the file exists on its own host. A command missing in the node image fails the
   step.
4. Refused whatever the allowlist says (`mcp_command_forbidden`), by the lower-cased name of the file
   and of its real path, with a trailing version and `.exe/.cmd/.bat/.com/.ps1` removed (`pip3.11`,
   `python3.12`):
   - shells and multi-call binaries: `sh bash zsh dash ash ksh csh tcsh fish busybox toybox coreutils
     cmd powershell pwsh`, and programs that execute their arguments: `env sudo su doas xargs nohup
     timeout nice setsid chroot nsenter strace gdb find awk sed make tar rsync vim less man ...`;
   - run-time installers and package managers: `npx npm pnpm pnpx yarn bunx uvx uv pip pipx poetry
     conda gem cargo go composer apt apk dpkg brew corepack mvn gradle ...`;
   - container, network and VCS tools: `docker podman nerdctl kubectl helm curl wget nc socat ssh
     scp telnet openssl git svn`; the dynamic loader (`ld-linux*.so`, `ld.so`);
   - interpreters that take their program on the command line (`tclsh jshell Rscript irb ...`).
5. Interpreters that are useful for real servers (`node`, `python`, `perl`, `ruby`, `php`, `lua`,
   `java`, `deno`, `bun`, `dotnet`) are accepted, but arguments are refused when they inject or load
   code: `node -e/-p/-r/--eval/--print/--require/--import/--loader/--env-file/--inspect*/--run`,
   `python -c` and `-m pip|ensurepip|venv|http|code|...`, `perl -e/-E/-M/-I/-x`, `ruby -e/-r/-I`,
   `php -r/-d/-S`, `java -javaagent/-agentlib/@argfile`, `deno|bun` sub-commands that evaluate or
   install and URL arguments, a bare `-` (program from stdin). Short options are matched inside
   clusters (`-Sc`) and with attached values (`-ecode`), long options with `_` read as `-`. Arguments
   are scanned up to a `--`; an option of the script itself such as `node server.js -e x` is
   refused too (deliberate: the scan does not know where the script ends).
6. At most 64 arguments of 4096 characters, no NUL bytes. There is no field for a working
   directory, shell or uid (the schema rejects unknown keys); the child starts in the process
   directory with `env` plus `PATH` only.
7. `env` and `envSecrets` names must be valid identifiers and not reserved: the reserved names of
   `agents[].credentials` (`PATH HOME USER SHELL PWD TMPDIR LANG NODE_OPTIONS NODE_PATH`, proxy
   variables, `OAX_*`, `LD_*`, `DYLD_*`) plus other loader and interpreter hooks (`BASH_ENV ENV
   IFS PYTHON* PERL5* RUBYOPT JAVA_TOOL_OPTIONS CLASSPATH GIT_* NODE_* NPM_* PIP_* UV_* XDG_*
   SSL_CERT_* GLIBC_* MALLOC_* ...`), compared case-insensitively (`https_proxy`).

Allowlist the binary, not a launcher: `/opt/mcp/bin/jira-mcp` is a fine entry, `/usr/bin/env` and
`/bin/sh` are never accepted, and a wrapper script is as trusted as everything it calls. The
allowlist is only as safe as the directories it names: do not list a directory a run can write to.

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
enabled, because those run only in nodes on the closed runner network.

**Not covered yet** (ADR 0016 slices S2 and later): per-server egress rules (every stdio server of a
step shares the step's egress grant), the shared UID of a node's children, and signed toolbox
images.
