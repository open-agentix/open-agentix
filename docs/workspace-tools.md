# Workspace tools for harness steps (DOG-2)

Part of the [dogfooding plan](dogfooding-phase-1.md) (D3, option A) and
[ADR 0008](adr/0008-agents-md-data-flow-and-isolation-contract.md) Amendment 2. Package:
`@openagentix/workspace` (`packages/workspace`).

A harness step runs Claude Code with `--tools ""`. The checkout in the run node is reachable only
through the MCP server `workspace`, whose tools pass the policy gate one by one.

## Tools

| Tool | Class | Arguments | Limits |
| --- | --- | --- | --- |
| `list_files` | read | `path` (default `.`), `depth` 1 to 3 | 500 entries; forbidden paths hidden; links listed, never followed |
| `read_file` | read | `path`, `offset` (lines to skip), `limit` (lines) | file at most 256 KiB, 64 KiB per call, text only |
| `search` | read | `pattern`, `path`, `literal` (default true), `ignoreCase` | 200 matches, 64 KiB; regex runs in a worker that is stopped after 2 s |
| `diff` | read | none | patch of all changes against the seed; reports a refusal code instead |
| `edit_file` | write | `path`, `old`, `new` | `old` must occur exactly once; result at most 64 KiB |
| `write_file` | write | `path`, `content` | at most 64 KiB, at most 50 new files |
| `run_tests` | write | optional `file` | fixed command, see below |

Results are JSON (`{ ok: false, code, message }` with `isError` on failure). Error messages contain
only the relative path the model sent.

## Rules enforced by the server (and again by the grant)

- Paths: relative, `/`-separated, no `..`, `.` or empty segments, no absolute paths, backslashes or
  control characters, at most 300 characters and 24 levels.
- Symbolic links are refused on every component, for every operation. Files are opened with
  `O_NOFOLLOW` and re-checked with `realpath`; FIFOs and devices are refused.
- Forbidden for every operation, at any depth, case-insensitive: `.git`, `.github`, `.gitea`,
  `.gitlab`, `.circleci`, other CI files (`Jenkinsfile`, `.gitlab-ci.yml`, ...), `.gitattributes`,
  `.gitmodules`, `.env*`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `credentials*`, `secrets*`, ...
- Writable only where `writable` matches (default `^(src|test)/[A-Za-z0-9._/-]{1,200}$`), with
  portable names and no hidden files.
- Budgets (second wall): 80 tool calls and 20 minutes per workspace, tool calls are serialised.

## `run_tests`

Configured by the node, never by the model:

```json
{
  "root": "/tmp/workspace",
  "tests": {
    "command": "/usr/local/bin/node",
    "args": ["--test"],
    "filePattern": "^test/[a-z0-9-]+\\.test\\.js$",
    "timeoutMs": 60000,
    "memoryMb": 1024,
    "maxRuns": 8
  }
}
```

The process starts without a shell (`spawn` with an argument array), in its own process group
(killed after every run, so nothing survives a call), with this environment only: `PATH`, a
throwaway `HOME`/`TMPDIR`, `LANG`, `CI`, `NO_COLOR` and the fixed `env` of the configuration. The
group's resident memory is polled and the group is killed above `memoryMb`. Output is cut at the
output cap. **There is no network sandbox in the process**: no network is the node's property
(internal container network, no egress grant, `OAX_HARNESS_EGRESS_ALLOWED` unset); the Linux
container limits (PIDs, memory, CPU) are the hard walls, the watchdog and timeout are the soft ones.

## The final patch

`Workspace.finalize()` is called by the node after the harness ended. It is not a tool.

```ts
{ patch: { ok: true, patch, patchSha256, changedFiles } | { ok: false, code, message, paths },
  lastTestRun, testedFinalTree, toolCalls, denied }
```

The diff is built in process from the baseline (taken when the workspace opens, from the seed) and
the current tree, so no `git` binary runs and a planted `.git/config` cannot execute anything. The
format is a normal `git apply` patch (tests apply it with `git apply --check`). Refusal codes:
`forbidden_path_changed`, `unsafe_entry` (link or special file), `mode_change`, `binary_file`,
`too_many_files`, `patch_too_large`, `file_too_large`, `tree_too_large`.

## Using it

```ts
const ws = await Workspace.open({ root, tests: { command, args } });
// in-process (fake harness, tests):
inMemoryServers({ workspace: () => createWorkspaceMcpServer(ws) });
// as a stdio server: oax-workspace --config config.json --result result.json
```

Connection: `workspaceToolDeclarations()` for the tool classes; agent definition:
`tools: workspaceToolGrants()` (all arguments listed, write paths constrained, call caps 20/40/20/
20/10/8/5). Three policy denials in a row end the run (control agent), so an injected instruction
that keeps trying is stopped.

## Threats covered by tests

Path traversal and absolute paths, symlinks (file, directory, dangling, planted by test code),
FIFO, huge and binary files, oversized writes and outputs, output floods, timeouts with child
processes, memory growth, environment leakage into tests, command injection through the file
argument and fixed arguments, catastrophic regular expressions, hostile file contents, call and time
budgets, and every denial through the real policy gate and harness runner (`test/gate.test.ts`).

## Residual risks

- Test code runs with the node's privileges and can create or change any file in the workspace; the
  patch refusal catches changes outside the writable area, but it cannot judge what the code in
  `src/` and `test/` does. The human review of the draft pull request stays the control.
- A race between a check and a use (a test process swapping a directory for a link while a tool
  runs) is narrowed by `O_NOFOLLOW` and the `realpath` re-check, not excluded; tools run one at a
  time and tests are finished before the next call.
- `testedFinalTree` and `lastTestRun` are reported by the node and can be wrong if the node is
  compromised; the reviewer re-runs the tests.
