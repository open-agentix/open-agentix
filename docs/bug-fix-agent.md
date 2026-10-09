# Running the bug-fix agent (DOG-4)

The example [`examples/agents/bug-fix-agent.md`](../examples/agents/bug-fix-agent.md) is the agent
of the [dogfooding plan](dogfooding-phase-1.md): it takes one issue of a test repository, fixes it
through the [workspace tools](workspace-tools.md) inside a run node, and the **worker** proposes the
result as a **draft pull request**. Nothing is merged by the platform. All data below is fictional
(`example.org`, `open-agentix/dogfood-sandbox`).

## What it may do

| Limit | Value | Enforced by |
| --- | --- | --- |
| Cost | 2 USD at list price per run | model proxy reservations |
| Turns, tool calls, time | 40, 80, 20 minutes | control agent, gate, platform timeout |
| Model | `claude-haiku-4-5` for the first run, then `claude-sonnet-5-5` | agent definition |
| Network | none (`runtime.egress: []`) | internal container network, `OAX_HARNESS_EGRESS_ALLOWED` unset |
| Tools | the seven `workspace` tools; writes only below `src/` and `test/` | grants (`workspaceToolGrants()`) and the server |
| Pull requests | draft only, at most 2 open under `oax/bug-fix/` | delivery code |

## Data flow

1. The worker reads the operator target (`OAX_PR_TARGETS`), checks the open pull request limit,
   resolves the base branch to one commit and builds the seed archive. Audit: `workspace.prepared`
   (commit, size, SHA-256).
2. The control node stores the seed with the step's session. The run node fetches it **once**
   (`GET /v1/worker/runs/{id}/workspace?agentId=`, step-scoped token), verifies the SHA-256 and
   unpacks it with its own checks (`seed_invalid` for `..`, absolute names, links, devices,
   non-UTF-8 names, size or count above the limits). Audit: `workspace.fetched`.
3. The node writes the configuration of the `workspace` server, runs the harness and, when the
   server shuts down, reads its result file. It attaches `{ patch, patchSha256, changedFiles,
   lastTestRun, ... }` to the step result.
4. The worker validates the patch again, applies it to the same commit, pushes a new branch
   `oax/bug-fix/issue-<n>-<run8>` and opens the draft pull request. Audit: `pull_request.pushed`,
   `pull_request.opened` or `pull_request.refused` (codes and digests only).

## Operator setup

Environment of the **worker** (see [configuration](configuration.md)):

| Variable | Meaning |
| --- | --- |
| `OAX_PR_TARGETS` | Path of the JSON file with the delivery targets. Unset: a step with a `pull-request` output fails with `pull_request_unavailable`. |
| `OAX_PR_DRY_RUN` | `true` stops after the local commit: nothing is pushed, no pull request is opened. Use it for the first runs. |
| `OAX_PR_PRIVATE_ALLOW` | Optional comma-separated private hosts/CIDRs allowed as Git destinations (self-hosted Git hosts). |

Environment of the **run node image** (defaults shown): `OAX_WORKSPACE_ROOT=/tmp/workspace`,
`OAX_WORKSPACE_STATE_DIR=/tmp/oax-workspace`.

Target file (secret references only, never values):

```json
{
  "targets": [
    {
      "name": "dogfood-sandbox",
      "url": "https://github.com/open-agentix/dogfood-sandbox",
      "baseBranch": "main",
      "branchPrefix": "oax/bug-fix/",
      "tokenRef": "dogfood-git-token",
      "extensionTokenRef": "dogfood-pr-token",
      "maxOpenPullRequests": 2,
      "pathAllow": ["^src/", "^test/"],
      "maxPatchBytes": 65536
    }
  ]
}
```

The `workspace` connection of the agent is a stdio connection started by the node inside the image:

```json
{
  "name": "workspace",
  "config": {
    "transport": "stdio",
    "command": "node",
    "args": [
      "/app/packages/workspace/dist/main.js",
      "--config", "/tmp/oax-workspace/config.json",
      "--result", "/tmp/oax-workspace/result.json"
    ],
    "tools": {
      "list_files": { "access": "read" }, "read_file": { "access": "read" },
      "search": { "access": "read" }, "diff": { "access": "read" },
      "edit_file": { "access": "write" }, "write_file": { "access": "write" },
      "run_tests": { "access": "write" }
    }
  }
}
```

Publish the agent, then start a run with the event built from the issue (data only):

```json
{ "issue": { "number": 1, "title": "applyDiscount rounds down", "body": "..." } }
```

## Refusals you may see

`pull_request_unavailable`, `issue_invalid`, `pr_limit_reached` (before the node starts),
`seed_invalid`, `workspace_seed_unavailable`, `no_changes`, `workspace_<code>` (patch refused by the
workspace, for example `workspace_forbidden_path_changed`), `tests_not_green`, `patch_path_refused`,
`patch_digest_mismatch`, `patch_too_large`, `secret_detected`, `branch_exists`.

## Honest limits

The test result is reported by the node; the reviewer re-runs the tests. Test code runs with the
node's UID (ADR 0008 Amendment 3), so the patch is also a possible exfiltration channel: the worker
scans it for credential patterns and for the exact tokens in use, but the human review of the
draft stays the control.
