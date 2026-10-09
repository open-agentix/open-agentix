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
- Also forbidden: `.envrc`, `.pgpass`, `*.tfvars`, `terraform.tfstate*`, `.vault-token`,
  `.dev.vars`, `*.gpg`, `.s3cfg`, `.boto`, `service-account*.json`, `id_*`, `.npmrc*`, `.netrc`.
- Files with more than one hard link are refused (`hardlink_refused`): a link to a file outside the
  workspace is not a way in. Refusals by `invalid_path` and `arg_not_allowed` count as denied.
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

The process starts without a shell (`spawn` with an argument array), in its own process group,
with this environment only: `PATH`, a throwaway `HOME`/`TMPDIR`, `LANG`, `CI`, `NO_COLOR` and the
fixed `env` of the configuration. Output is cut at the output cap, and the absolute workspace and
home paths are replaced by `<workspace>` and `<home>` in it.

**Processes started by the test.** When a run ends (exit, timeout or memory limit) the server
kills with `SIGKILL`, and then verifies via `/proc`, every process that belongs to the run: the
process group, all descendants of the test process, and *orphans* (re-parented to init or a reaper
by `detached`, `setsid` or a double fork) of the same UID that were started after the run began.
The server itself and its ancestors are never touched. The call does not wait for the output pipes
to close (a surviving child can hold them open forever); it returns at the latest `timeoutMs` plus
1.5 s. `strayProcessesKilled` in the result counts processes that were still alive at the end of
the run; if one cannot be killed, `strayProcessesSurvived` is above 0 and the run is not `passed`.
The memory watchdog sums the resident memory of all these processes, not only the group.
Limits: without `/proc` (not Linux) only the group is killed; a process that changes its UID cannot
be reaped by an unprivileged server; a fork bomb is a job for the container PID limit. Because
the sweep is by UID and start time, the server should be the only workload of its UID (as in the
run-node container).

Tool calls are serialised and a run is over, with its processes killed and verified, before the
next call starts. **There is no network sandbox in the process**: no network is the node's property
(internal container network, no egress grant, `OAX_HARNESS_EGRESS_ALLOWED` unset); the Linux
container limits (PIDs, memory, CPU) are the hard walls, the watchdog and timeout are the soft ones.

## The final patch

`Workspace.finalize()` is called by the node after the harness ended. It is not a tool.

```ts
{ patch: { ok: true, patch, patchSha256, changedFiles } | { ok: false, code, message, paths },
  lastTestRun, fullSuitePassed, treeMatchesLastRun, testedFinalTree, toolCalls, denied }
```

`testedFinalTree` is `fullSuitePassed && treeMatchesLastRun`. `fullSuitePassed`: the **last** run
had no file argument and passed (one test file proves nothing about the rest of the suite).
`treeMatchesLastRun`: the tree after that run is exactly the tree the patch describes (a test that
writes files counts as part of what was tested). The diff and the tree walk have a time cap
(`maxFinalizeMs`, default 10 s) and fail closed with the code `timeout`.

The diff is built in process from the baseline (taken when the workspace opens, from the seed) and
the current tree, so no `git` binary runs and a planted `.git/config` cannot execute anything. The
format is a normal `git apply` patch (tests apply it with `git apply --check`). Refusal codes:
`forbidden_path_changed`, `unsafe_entry` (link or special file), `mode_change`, `binary_file`,
`too_many_files`, `patch_too_large`, `file_too_large`, `tree_too_large`, `timeout`. The header of
a deleted or added file carries its real mode (`100644` or `100755`). Directories count toward
`maxTreeEntries` like files.

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

## Trust boundary of test code (T4/T9 model)

`run_tests` executes code the model wrote. It runs **as the same UID as the node process** (the
oax-workspace server), so it must be treated as equal to a compromised node, including the
gate. Concretely, test code can:

- write to `/proc/<ppid>/fd/1` and so inject bytes into the MCP stream of the server (forged tool
  results, or a forged result around the gate);
- read `/proc/<pid>/environ`, the memory-mapped files and the token directory of the server or of
  the harness (any file the UID can read), and attach with `ptrace` where `kernel.yama.ptrace_scope`
  is 0;
- change any file in the workspace, including `src/` and `test/`, in ways the patch refusal cannot
  judge.

The scrubbed environment, the group kill and the path rules protect against an honest-but-wrong
test, not against hostile test code. The **patch and the draft pull request are therefore also an
exfiltration channel**: whatever test code read (a token, a file outside the workspace) can be
written into a source file and delivered with the patch.

Required follow-ups (before this runs on untrusted input outside the dogfooding setup):

1. Run the tests under a **separate UID** or in a **sibling container** that sees only the
   workspace (no server, no token directory, no shared PID namespace).
2. A **seccomp** profile that denies `ptrace` and `process_vm_readv/writev`, and
   `kernel.yama.ptrace_scope >= 1` on the host.
3. In the worker (DOG-3), **scan the patch for token patterns** (cloud, Git host and API keys,
   private-key headers, the run's own tokens) before it is delivered, and refuse delivery.
4. The human review of the draft pull request stays mandatory.

The server logs a warning at startup when `/proc/sys/kernel/yama/ptrace_scope` is 0 (check 2 is
then not met by the host; a container profile may still deny `ptrace`).

For DOG-3: whoever runs `git` on the checkout or the patch must set `safe.bareRepository=explicit`
(and `core.fsmonitor`/hooks off): a bare repository planted by test code inside `src/` or `test/`
must not be picked up as the repository.

## Residual risks

- Test code runs with the node's UID (see "Trust boundary of test code") and can create or change any file in the workspace; the
  patch refusal catches changes outside the writable area, but it cannot judge what the code in
  `src/` and `test/` does. The human review of the draft pull request stays the control.
- A race between a check and a use (a test process swapping a directory for a link while a tool
  runs) is narrowed by `O_NOFOLLOW` and the `realpath` re-check, not excluded; tools run one at a
  time, and a test run, with every process it started, is killed and verified before the next call.
- `testedFinalTree` and `lastTestRun` are reported by the node and can be wrong if the node is
  compromised; the reviewer re-runs the tests.
