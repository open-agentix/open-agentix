# OpenCode harness: verification status

**Real-run verification: pending.** The adapter was written against the documented command-line
contract of OpenCode, because no `opencode` binary was available on the build host and nothing may be
downloaded at build or run time. Everything below the CLI boundary is covered by tests with a fake CLI
that speaks the same event format and talks to the real policy gate.

## Contract the adapter relies on (to be confirmed by the real run)

| Item | Assumption |
| --- | --- |
| Invocation | `opencode run --format json --model <provider>/<model> --agent oax`, prompt on stdin |
| Config | file named by `OPENCODE_CONFIG`; keys `provider`, `enabled_providers`, `mcp` (type `remote`), `tools`, `permission` (`"*": "deny"` plus per-tool rules), `agent.<name>` (`prompt`, `steps`, `tools`, `permission`), `plugin`, `autoupdate`, `share`, `snapshot`, `lsp`, `formatter` |
| Secrets | `{env:NAME}` substitution in the config |
| MCP tool names | `<server>_<tool>` (reported by the adapter as `mcp__<server>__<tool>`) |
| Events | one JSON object per line: `step_start`, `text`, `tool_use` (`part.callID`, `part.tool`, `part.state.{status,input,output,error}`), `step_finish` (`part.cost`, `part.tokens`), `error` |
| Environment switches | `OPENCODE_DISABLE_AUTOUPDATE`, `_LSP_DOWNLOAD`, `_MODELS_FETCH`, `_DEFAULT_PLUGINS`, `_CLAUDE_CODE`, `_PROJECT_CONFIG` (unknown switches are ignored by the CLI) |
| Bundled provider packages | `@ai-sdk/openai-compatible` and `@ai-sdk/anthropic` are bundled (no runtime package download) |

## How to complete the verification

```bash
OAX_TEST_OPENCODE=1 \
OAX_TEST_OPENCODE_CMD=/usr/local/bin/opencode \
OAX_TEST_OPENCODE_SHA256=<sha256 of the pinned binary> \
OAX_TEST_OPENCODE_BASE_URL=http://127.0.0.1:11434/v1 \
OAX_TEST_OPENCODE_MODEL=<model> \
  pnpm vitest run packages/runners/test/opencode.integration.test.ts
```

Then check by hand with `keepWorkDir` that (1) a built-in tool call is refused by the deny-by-default
permissions, (2) the config accepted every key above (OpenCode rejects unknown keys), (3) the CLI made
no connection other than the model endpoint and the loopback gate, and replace this note with a report
in the style of [claude-code-harness.md](claude-code-harness.md).

## What is verified today (fake CLI, always run in CI)

Happy path through the gate, denied (forbidden) tool call, built-in tool use reported as
`harness_unmanaged_tool`, step/cost/time limits and cancellation (process killed), air-gapped
refusal, secret redaction in text and tool output, minimal environment, temporary directory cleanup,
checksum pinning.
