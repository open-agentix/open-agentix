# Claude Code harness: real verification

Produced by a real run of the Claude Code CLI `2.1.289` on 2026-10-04:

```bash
OAX_TEST_CLAUDE=1 OAX_TEST_CLAUDE_REPORT=docs/verification/claude-code-harness.md \
  pnpm vitest run packages/runners/test/claude-code.integration.test.ts
```

Authentication: the existing login of the host user (default). No token was passed in, written to a
file or printed; the child process gets a minimal environment (`PATH`, `HOME`, `LANG`, no proxy,
CI or cloud variables) and runs in a temporary directory that is deleted afterwards.

Agent `harness-check`: model `haiku`, one granted tool `cve-db/lookup_cve` (argument `cveId`
must match `^CVE-\d{4}-\d{4,}$`), event `{"question":"How severe is CVE-2024-3094 and in which version is it fixed?"}`.

## Invocation

`claude -p --output-format stream-json --verbose --model haiku --mcp-config .openagentix/mcp.json
--strict-mcp-config --tools "" --permission-mode dontAsk --allowedTools mcp__oax-gate__cve-db__lookup_cve
--restricted --disable-slash-commands --no-session-persistence --max-turns N --max-budget-usd X`

- `--tools ""`: no built-in tools (no Bash, file or web access); the policy gate is the only tool source.
- `--strict-mcp-config` + the gate as streamable-HTTP MCP server on loopback, per-run bearer token.
- `--restricted --disable-slash-commands`: ignores user/project/local settings, CLAUDE.md files (also in
  parent directories) and skills of the host.
- The prompt is passed on stdin; limits are additionally enforced by the platform.

## Scenarios

### 1. Allowed tool call

Limits: `maxSteps: 3` (`--max-turns 3`), `maxCostUsd: 0.1` (`--max-budget-usd 0.1`), `timeoutSeconds: 120`.

| Field | Value |
| --- | --- |
| Run status | `succeeded` (error code: `-`) |
| Wall time | 4.5 s |
| Tokens in / out | 8784 / 280 |
| Cost reported by the harness | $0.0109 |
| Policy-gated tool calls | 1 |
| Audit chain | valid, 5 entries |

Recorded steps: `policy_decision:cve-db/lookup_cve:ok`, `tool_call:cve-db/lookup_cve:ok`, `model_call:claude-code/claude-haiku-4-5-20251001:ok`, `output:markdown:ok`

Answer (sanitized): > CVE-2024-3094 is **CRITICAL** (CVSS 10) and is fixed in version **5.6.2**.

### 2. Turn limit

Limits: `maxSteps: 1` (`--max-turns 1`: one tool call needs two turns).

| Field | Value |
| --- | --- |
| Run status | `failed` (error code: `control_budget_steps`) |
| Wall time | 3.2 s |
| Tokens in / out | 4251 / 171 |
| Cost reported by the harness | $0.0093 |
| Policy-gated tool calls | 1 |
| Audit chain | valid, 4 entries |

Recorded steps: `policy_decision:cve-db/lookup_cve:ok`, `tool_call:cve-db/lookup_cve:ok`, `model_call:claude-code/claude-haiku-4-5-20251001:error`

Answer (sanitized): (none)

### 3. Forbidden tool (global policy)

Limits: as in 1, plus a platform policy that forbids `cve-db/lookup_*`.

| Field | Value |
| --- | --- |
| Run status | `blocked_by_policy` (error code: `control_forbidden_action`) |
| Wall time | 3.2 s |
| Tokens in / out | 0 / 0 |
| Cost reported by the harness | $0.0000 |
| Policy-gated tool calls | 1 |
| Audit chain | valid, 4 entries |

Recorded steps: `policy_decision:cve-db/lookup_cve:denied`, `control:kill:error`, `model_call:claude-code/claude-haiku-4-5-20251001:error`

Answer (sanitized): (none)

## What this proves

- The CLI runs headless and every tool call goes through the policy gate: decided by the policy engine,
  executed by the MCP gateway, recorded as `policy_decision` / `tool_call` steps and chained into the audit log.
- A globally forbidden tool never reaches the tool server (scenario 3).
- Turn limits of the agent contract stop the harness (scenario 2).
- Tokens and cost reported by the harness are recorded on the `model_call` step and counted against the run budget.

## Limits of this verification

- One host, one CLI version, one small model; it shows the mechanism works end to end, not that
  every Claude Code version behaves identically. Re-run the command above after upgrading the CLI.
- When the platform kills a harness (policy kill, timeout, cancel) the cost it had incurred is not
  reported (scenario 3 shows 0 tokens); the per-run budget flag (`--max-budget-usd`) bounds it.
- The check that no built-in tool was used relies on the stream the CLI reports; `--tools ""`
  already removes the built-in tools, so the check is a second line of defence.
- The harness needs its own network access to the Anthropic API; it is not usable in air-gapped
  mode (see `docs/airgapped.md`): in air-gapped mode the harness refuses to start unless `api.anthropic.com` (or `anthropicUrl`) is on `OAX_AIRGAPPED_ALLOW`.

## Run-node image (DOG-1)

Verified on 2026-10-09 with the Dockerfile target `run-node-claude-code` (Claude Code `2.1.295`,
native musl build, SHA-512 `4bf70c9f...ed16` for amd64 checked at build time) in a throwaway container
with the hardening of the container runner (numeric user 10001, read-only root file system, all
capabilities dropped, `no-new-privileges`, 2048 MiB memory, 256 PIDs, `/tmp` tmpfs 256 MiB `noexec`)
on an `internal` Docker network that contained only a fake control node.

| Check | Result |
| --- | --- |
| `claude --version` | `2.1.295 (Claude Code)`, equals the pin (the build also fails otherwise) |
| `managed-settings.json`, `/etc/claude-code`, `CLAUDE_CONFIG_DIR` | none present |
| package managers (`apk`, `npm`, `npx`, `corepack`, `yarn`, `pip`) | none present |
| control node from inside the node | reachable (`GET /healthz` answered) |
| `api.anthropic.com`, `github.com` | unreachable (`bad address`: no DNS on the internal network) |
| direct IP (`1.1.1.1`) | `Network unreachable` |
| write outside `/tmp` | `Read-only file system` |
| `git init` and `git --version` in `/tmp` | works offline |

### Automated smoke test (review fixes, 2026-10-09)

`scripts/test-harness-image.sh <image>` repeats these checks automatically in throwaway containers
with the runner hardening (read-only root, `cap-drop ALL`, `no-new-privileges`, 512 MiB, 128 PIDs,
`/tmp` and `/run/oax` tmpfs `noexec,nosuid,nodev`). Result on LXC 110 (Docker 29.8.2): 17 checks, all
passed, among them `claude --version` = `2.1.295 (Claude Code)` and `claude --help` **with `noexec`
`/tmp`** (Claude Code starts; `noexec` is therefore kept), no setuid/setgid **files** (48 setgid
directories from the Node base image under `/usr/local` and `/home/node` are listed as info, they have
no effect), uid/gid 10001, writable paths for that uid on a writable root: only `/tmp` and `/var/tmp`,
and on an `--internal` network with a **fake** egress proxy: `CONNECT` without grant answered `407`,
with the fake grant `200`, `example.com` does not resolve and `1.1.1.1:443` is not reachable. The
fake proxy proves the network path (no DNS, no route, only the proxy neighbour); the grant logic of
the real egress proxy is covered by its unit tests and was **not** re-verified end to end here.
Not covered: a real Bash tool call of Claude Code under `noexec /tmp` (the adapter starts it with
`--tools ""`, so no shell is spawned; a future step with tools needs its own check).

Variable names and request shape of the **pinned CLI** against the proxy surface, with exactly the
invocation and environment of the adapter (`stream-json`, `--tools ""`, `--strict-mcp-config`,
`--permission-mode dontAsk`, `--restricted`, `--max-turns`):

- `ANTHROPIC_BASE_URL=<control>/v1/model-proxy/anthropic` is honoured; the CLI sends
  `POST /v1/model-proxy/anthropic/v1/messages?beta=true` (streaming), no other request (no
  `count_tokens`, no `GET models/{id}`, no telemetry, no update check).
- `ANTHROPIC_AUTH_TOKEN` is sent as `Authorization: Bearer ...`; no `x-api-key` header.
- `ANTHROPIC_MODEL` (and the `SMALL_FAST`/`DEFAULT_*` variables) decides the model id of the request.
- The request carries `tools: []`: no built-in tool is offered to the model (the `init` event lists
  `tools: []`, `skills: []`, `mcp_servers: []`).
- With only `ANTHROPIC_API_KEY` set the CLI sends `x-api-key` instead; the adapter does not use it.

Not part of this check: a real Anthropic upstream and the gate tools (DOG-2); the end-to-end run of a
harness step through the real container runner on the homelab is DOG-4b/DOG-5.

## Proxy mode

Through the model proxy (`agents[].runtime.harness`, ADR 0009 amendment W1-3b-7) the adapter sets
`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`,
`ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL`, `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`,
`DISABLE_TELEMETRY` and `DISABLE_ERROR_REPORTING`. The variable names above (`ANTHROPIC_BASE_URL`,
`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`) are now checked against the pinned binary (section
"Run-node image"); the remaining ones are accepted without complaint but their effect (for example
that a background call would use the small model) is not observable with a one-turn prompt. Still to
verify with a real control node: (a) the proxy receives `POST /v1/messages` with the model token,
(b) no request carries another model id, (c) the ledger lines have `via = 'proxy'`.
