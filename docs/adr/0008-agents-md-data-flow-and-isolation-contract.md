# ADR 0008: agents.md data flow and isolation contract

- Status: Accepted
- Date: 2026-10-04
- Plan item: W0-1 ([implementation plan](../IMPLEMENTATION-PLAN.md), issue #23)
- Builds on: [ADR 0003](0003-policy-engine-audit-and-control-agents.md),
  [ADR 0005](0005-runners-and-external-harnesses.md),
  [ADR 0006](0006-control-node-and-worker-nodes.md),
  [ADR 0007](0007-tenants-as-isolation-boundary.md)

## Context

Wave 1 of the implementation plan builds six things in parallel: typed handovers and `when`
(W1-1), tool profiles (W1-2), the remote run node with a per-step credential broker and the
container runner (W1-3), the Kubernetes Job runner (W1-4), Agent Check / Agent Plan v1 (W1-5) and
the OpenCode adapter (W1-6). Four of them extend `agents.md`, three of them change what a worker
node receives, and all of them touch a handful of shared files (`executor.ts`, `openapi.yaml`,
migrations, i18n). Without one fixed contract, each item would redesign the others' interfaces.

Today (`main`, v0.1.0 plus unreleased changes):

- A step is one entry of `agents[]`, executed in `pipeline` order. The executor hands the previous
  step's full text (or its `JSON.parse`d value for `format: json`) to the next step. Nothing is
  validated, every step sees everything before it.
- A step's tools are hand-picked grants (`server` + `tool` + argument constraints).
- Secrets are references resolved by `DefaultSecretResolver` inside the worker process; every step
  of a run can reach every secret the worker can.
- The run token (`oaxrt.`) is run-scoped; only the in-process and local runners exist.

This ADR fixes the decisions all wave 1 items depend on. In this document a **step** is one entry
of `agents[]` (the plan and the concept also say "agent" for it). The schema changes of section 1
are implemented in `packages/core` by W0-1 itself (parsed and validated, no executor behaviour
yet); everything else is a contract that the named items implement.

## Decision

### 1. agents.md schema extension (additive, `apiVersion` stays `openagentix.io/v1alpha1`)

All new keys are optional. A file without them parses to exactly the same definition as before
(no new keys appear in the parsed object, digests are unchanged). `apiVersion` is not bumped: the
`v1alpha1` contract allows additive fields; `openagentix.io/v1` is frozen in W8-1. An older control
node refuses a file that uses the new keys (every object is strict), so a new file can never be
silently run without its guardrails.

```yaml
schemas:                                   # top level, optional, max. 32 entries
  Finding: { type: object, required: [severity], properties: { severity: { enum: [low, high] } } }
agents:
  - id: research
    access: read-only                      # read-only | write
    input:
      schema: { type: object, required: [ticket] }   # validates what the step receives
    outputs: [{ format: json }]
    output:
      schema: { $ref: "#/schemas/Finding" }
      onInvalid: fail                      # fail (default) | retry
    tools:
      - { server: jira, profile: read }    # profile grant (new)
      - { server: crm, tool: get_customer, args: { id: { type: string } } }   # unchanged
  - id: action
    access: write
    when: 'steps.research.output.severity == "high" && exists(event.data.ticket)'
    input: { from: [event, research] }     # explicit, minimal handover
    credentials:
      - { secret: jira-bot-token, env: JIRA_TOKEN }  # reference only, never a value
    runtime: { runner: container, egress: [jira.example.com] }
    tools:
      - { server: jira, profile: write, approval: required }
pipeline: [research, action]
```

#### 1.1 Typed handovers: `input`, `output`, `schemas`

- `agents[].output.schema` validates the step's final output; it requires an `outputs` entry with
  `format: json` (publish error otherwise). `onInvalid: retry` allows exactly one more model turn
  that receives the validation errors; a second failure fails the run.
- `agents[].input.schema` validates the value the step receives:
  - without `input.from` (legacy behaviour): the first step receives `event.data`, later steps the
    previous step's output;
  - with `input.from` (1..16 entries, `event` or ids of **earlier** pipeline steps): the step
    receives the object `{ <source>: value }` and **only** that. The prompt then contains this JSON
    and not the previous step's text (minimal handover). `event` always means the triggering
    event's `data`.
- A schema is inline or `{ $ref: "#/schemas/<name>" }`. Schema names match
  `^[A-Za-z][A-Za-z0-9_-]{0,62}$`.
- **JSON Schema subset** (2020-12 semantics), checked at publish by `checkJsonSchemaSubset`:
  - Keywords: `type`, `enum`, `const`, `properties`, `required`, `additionalProperties`, `items`,
    `minItems`, `maxItems`, `uniqueItems`, `minLength`, `maxLength`, `pattern`, `minimum`,
    `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `anyOf`, `$ref`, `$schema` (only the
    2020-12 dialect URI) and the annotations `title`, `description`, `examples`, `default`,
    `$comment`. **Any other keyword is refused** (fail closed): no `$id`, `$defs`, `$dynamicRef`,
    `if/then/else`, `patternProperties`, `format`, `contentSchema` and so on.
  - `$ref` only as `#/schemas/<name>` into the same file, never remote, never JSON pointers into
    other places; `$ref` cannot have sibling keywords (annotations excepted); recursive or mutually
    recursive references are refused, so every schema is a finite tree.
  - Limits: 32 KiB serialized per schema, depth 12 and 512 nodes after `$ref` resolution (a
    "reference bomb" stops at the node limit), 128 properties per object, 128 `enum` values,
    patterns of at most 512 characters, 32 named schemas.
  - Property names and `required` entries `__proto__`, `prototype`, `constructor` are refused.
  - `pattern` must compile with the `u` flag, must be in a **safe regex subset** (no
    backreferences, no lookarounds, no quantified group that itself contains a quantifier, e.g.
    `(a+)+`; deliberately conservative) and needs `maxLength <= 4096` in the same schema.
- **Runtime validation (W1-1)**: ajv 8 (already in the lockfile, pinned) with `strict: true`,
  `allErrors: true` capped at 20 reported errors, `validateFormats: false`, no `loadSchema`, no
  remote resolution; named schemas are registered under internal ids per published version and
  compiled once per schema digest. Instances larger than 256 KiB serialized or deeper than 32
  levels fail without being handed to ajv. Validation always runs in the trusted orchestrator
  (section 3), never only in a run node.
- **Violations** fail the run with error code `handover_invalid` (or trigger the single retry). Each
  violation is a step (kind `handover`, status `error`) and an audit entry `handover.invalid` with
  payload `{ agentId, direction: "input" | "output", attempt, schemaDigest, errors: [{ instancePath,
  keyword, schemaPath }] }`. **The offending value is never copied into the audit payload** (it can
  contain data); the step output itself stays in `run_steps` with the usual redaction. A retry
  writes `handover.retry`.

#### 1.2 Conditions: `agents[].when`

A condition decides whether a step runs. It is parsed at publish (`parseWhen`, an AST, no `eval`,
no `Function`, no regular expressions on data) and evaluated by W1-1 over that AST.

```text
expr    := or
or      := and ( "||" and )*
and     := unary ( "&&" unary )*
unary   := "!" unary | compare
compare := operand ( ( "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" ) operand )?
operand := literal | path | list | "exists" "(" path ")" | "(" expr ")"
path    := ( "event" | "steps" "." step-id "." "output" ) ( "." name | "[" index "]" )*
list    := "[" ( literal ( "," literal )* )? "]"
literal := string | number | "true" | "false" | "null"
```

- Strings in single or double quotes with the escapes `\\`, `\"`, `\'` only; numbers are JSON
  numbers (finite); names match `[A-Za-z_][A-Za-z0-9_-]*`; `index` is an integer 0..10000.
- Comparisons do not chain (`a == b == c` is refused); a list may only stand on the right of `in`;
  `in` takes a list literal or a path on the right.
- Path roots are only `event` (the CloudEvent: `event.type`, `event.source`, `event.data...`) and
  `steps.<id>.output` (the **validated** output of an earlier step). Segments `__proto__`,
  `prototype`, `constructor` are refused.
- Publish checks: grammar, limits (512 characters, 128 tokens, nesting 16, path 16 segments, list
  32 items, string 256 characters) and that every `steps.<id>` is a pipeline step that runs
  **before** this one; a referenced step without `output.schema` gives a warning.
- **Evaluation semantics (W1-1)**: strictly typed, no truthiness. `==`/`!=` compare JSON scalars
  by value and type (`1 != "1"`); `<`, `<=`, `>`, `>=` need two numbers or two strings (code unit
  order); `in` tests scalar membership in an array; `&&`, `||` short-circuit and need booleans,
  `!` needs a boolean; `exists(path)` is true when the path resolves (also to `null`). Reading a
  missing path outside `exists()`, comparing an object or array, a type mismatch or a non-boolean
  result is an **evaluation error**. Path lookups use own properties only.
- **Outcome**: `true` runs the step. `false` records a step (kind `condition`, status `skipped`) and
  an audit entry `step.skipped` `{ agentId, when }`; a skipped step has no output, so
  `exists(steps.<id>.output)` is false for later steps, and a later step that lists it in
  `input.from` fails with `handover_missing`. An evaluation error **fails the run** (fail closed)
  with `condition_error` and the audit entry `condition.error` `{ agentId, when, reason }`; it is
  never treated as `false`.

#### 1.3 Access class and tool profiles: `agents[].access`, `tools[].profile`

- `access: read-only | write` (optional; absent means "not declared", today's behaviour).
- A `tools[]` entry with `profile` is a **profile grant** `{ server, profile, approval?,
  maxCallsPerRun?, classification? }`; it may not carry `tool`, `args` or `allowAdditionalArgs`
  (argument constraints belong on concrete grants). The parser keeps concrete grants in
  `AgentSpec.tools` (unchanged type, the only thing the policy engine evaluates) and puts profile
  grants into `AgentSpec.profileGrants` (present only when used). Until W1-2 expands them, a
  profile grant grants nothing (fail closed).
- **Connection side (W1-2)**: an MCP connection declares `tools: { <tool>: { access: read | write } }`
  and `profiles: { <name>: [tool, ...] }`; profile names are slugs, `read` and `write` are
  conventions, any other name (`triage`) is allowed. Unknown tools in a profile are refused when
  the connection is saved; a tool without an access class counts as `write`.
- **Expansion at publish (W1-2)**: each profile grant becomes one concrete grant per tool
  (`allowAdditionalArgs: true`, no argument constraints, `approval`/`maxCallsPerRun`/
  `classification` from the profile grant). A concrete grant for the same `server/tool` wins over
  the expansion (so a write tool can be narrowed with constraints). The expanded grants and an
  `expansion` record `{ server, profile, tools, connectionVersion }` are stored inside the
  immutable version's `definition` (JSONB); a later change of the profile never widens a published
  version. The source digest stays the digest of the agents.md text; the version additionally
  stores `expansionDigest`.
- Publish errors: unknown profile name (`checkDefinition(def, { profiles })` in core already does
  this when the control node passes its catalog), a `read-only` step that receives a `write` tool
  directly or through a profile. Policy gate defence in depth: reason code `profile_write_denied`.

#### 1.4 Per-step credentials: `agents[].credentials`

- A list (max. 16) of `{ secret: <ref>, env?: <NAME> }`. `secret` uses the existing reference
  format (`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`); there is **no field for a value** and the strict
  schema refuses one. `env` (upper case) is the variable the step's tool processes receive; when
  absent it is derived from the reference (`ops.webhook` -> `OPS_WEBHOOK`).
- Duplicate secrets or env names are refused; reserved names are refused (`PATH`, `HOME`, `USER`,
  `SHELL`, `PWD`, `TMPDIR`, `LANG`, `NODE_OPTIONS`, `NODE_PATH`, the proxy variables and the
  prefixes `OAX_`, `LD_`, `DYLD_`).
- A step's credentials are the declared references plus the secret references of the MCP
  connections the step holds grants for (concrete or profile). Nothing else.

#### 1.5 Per-step runtime: `agents[].runtime`

- `{ runner?, egress? }`. `runner` overrides the pipeline's `runtime.runner` for this step (mixed
  pipelines are allowed: e.g. an in-process research step and a container action step). `egress`
  can only **narrow** the pipeline's `runtime.egress` (publish error otherwise). The existing
  `agents[].toolbox` stays the per-step toolbox override.
- Publish refuses a step runner that is not in `OAX_RUNNERS_ENABLED` (the api check is extended to
  per-step runners by W1-3).
- `harness?: claude-code | opencode` (ADR 0009 section 10 and amendment W1-3b-7): run the step through
  an external harness behind the model proxy. Needs an isolating runner and no `simulation`; the
  harness must be enabled by the operator (`OAX_HARNESSES_ENABLED`). The harness child holds only the
  step's model token and gets the policy gate as its only tool source.

### 2. Credential broker contract (W1-3; used by W1-4)

- **Pull model**: secret values are never put into container configuration, Job specs, Kubernetes
  Secrets, environment of the run node process or command lines (all of them are readable through
  the engine/cluster API or `inspect`). The run node fetches its step credentials itself, once,
  from the control node and keeps them in memory; it passes them only to the child processes that
  need them (MCP stdio servers, toolbox binaries) or as HTTP headers of the step's MCP
  connections. A file is written only to a per-step tmpfs when a binary insists on one.
- **Endpoint**: `POST /v1/worker/runs/{id}/credentials` with a step-scoped run token, body
  `{ agentId }`. Response `StepCredentials` (section 6). Rules:
  - the token's session must be active, the run must be `running`, `agentId` must be in the
    token's `steps`;
  - each reference must be allowed for the run's tenant (`tenants.secret_refs`, a list of globs
    added by migration 0009; default `*` for the default tenant and empty for every other tenant,
    i.e. fail closed; managed by admins through the tenant API);
  - issue **once per step and session** (`409 credential_already_issued` afterwards; a restarted
    run node gets a new session);
  - values have a lifetime of at most the session lifetime (`expiresAt`).
- **Credential sources**: `CredentialSource { issue(ref, scope) -> { value, expiresAt?, handle? };
  revoke?(handle) }`. v0.2 ships the `static` source (the existing env/file resolver). Dynamic
  sources (Vault, AWS STS, GitHub App installation tokens) plug in later and get real revocation.
  For static secrets "revocation" means: session revoked, run node destroyed, token useless; the
  ADR is explicit that a static secret value itself cannot be recalled.
- **Revocation**: at step end (success, failure, skip of the remaining group), cancellation,
  timeout, lease loss or run completion the orchestrator revokes the session; every worker API
  call checks the session, so the run token is dead immediately, not only at `exp`.
- **Audit** (names and ids only, never values): `runnode.started` `{ runId, nodeId, steps, runner,
  image }`, `credential.issued` `{ runId, nodeId, agentId, refs, connections, expiresAt, source }`,
  `credential.denied` `{ runId, nodeId, agentId, reason }`, `credential.revoked` `{ runId, nodeId,
  reason: step_end | cancelled | timeout | lease_lost | run_completed }`, `runnode.stopped`
  `{ runId, nodeId, exitCode, durationMs }`. Values are additionally covered by redaction (they
  are registered with the run's redactor before they are handed out).
- **What never leaves the control node** (and the trusted worker): database credentials, the run
  token HMAC secret, the audit signing key, provider/model API keys (see 3.4), secrets of other
  steps, secret references not allowed for the tenant, other tenants' anything, policy bundles
  beyond the step's effective grants, and other steps' outputs that the step does not reference.

### 3. Runner interface extension and the run node (W1-3, W1-4)

#### 3.1 Roles

- **Orchestrator**: the trusted worker process (`apps/worker`) keeps running `executePipeline`.
  It evaluates `when`, builds and validates handovers, enforces budgets and decides per step where
  the step runs. It never executes tools of an isolated step.
- **Run node**: an untrusted, short-lived process started by a runner (`oax run-node`, a target of
  the worker image; later inside toolbox images). It executes exactly the steps of its session with
  the same step executor, talking only to the control node through `HttpControlPlane`. It never
  connects to PostgreSQL or Valkey.
- v0.2: one run node per step for isolating runners (`container`, `kubernetes-job`); the token
  carries a `steps` list so that grouping consecutive steps with identical runtime and no
  credentials can be enabled later without a contract change. `in-process` and `local` run steps
  inside the orchestrator as today.

#### 3.2 Interfaces

```ts
// packages/runners/src/types.ts (additive)
export interface RunNodeSpec {
  runId: string;
  nodeId: string;            // uuid, also the token's workerId
  steps: string[];           // agent ids of this session (v0.2: exactly one)
  image: string;             // toolbox/worker image pinned by digest
  controlUrl: string;
  runToken: string;          // step-scoped; delivered as a file, never as env
  limits: { cpus: number; memoryMb: number; timeoutSeconds: number; pids: number };
  egress: string[];          // effective step egress (narrowed)
}
export interface RunNodeHandle {
  readonly nodeId: string;
  wait(signal?: AbortSignal): Promise<{ exitCode: number | null; reason?: string }>;
  stop(reason: 'step_end' | 'cancelled' | 'timeout' | 'lease_lost'): Promise<void>; // idempotent, removes the node
}
export interface IsolatingRunner extends Runner {
  startNode(spec: RunNodeSpec, ctx: { signal?: AbortSignal }): Promise<RunNodeHandle>;
}
```

`Runner.execute` stays for in-process/local. The executor gets one seam, `dispatchStep`, owned by
W1-3: when a step's effective runner is isolating, the orchestrator calls `startNode`, waits, and
reads the step result from the control node instead of running the step inline.

#### 3.3 Lifecycle of one isolated step

1. Orchestrator: `when` true; input assembled and validated; the control node creates a session
   (`run_node_sessions`: `id`, `run_id`, `node_id`, `steps`, `expires_at`, `revoked_at`,
   `revoke_reason`) and issues a **step-scoped run token**: claims `{ runId, workerId: nodeId,
   sid, steps, iat, exp }` with `exp <= now + step timeout + 60 s` (capped by
   `OAX_RUN_TOKEN_TTL_SECONDS`). Tokens without `sid` stay valid for the trusted worker only.
2. Runner `startNode`: container or Job with the token as a file (`/run/oax/token`, tmpfs or a
   projected Secret volume) and `OAX_CONTROL_URL`, `OAX_RUN_ID`, `OAX_STEP_IDS`,
   `OAX_RUN_TOKEN_FILE`. Audit `runnode.started`.
3. Run node: `GET /v1/worker/runs/{id}/handover?agentId=` (the step's own `AgentSpec`, its input,
   the resolved output schema; nothing about other steps), `POST .../credentials`, then the normal
   loop: gate, steps, approvals, budget, model calls (3.4), tool calls through its own MCP gateway.
   It may run the `onInvalid: retry` turn locally, then posts the final content with
   `POST /v1/worker/runs/{id}/handover/result`.
4. Orchestrator: on exit or result, revokes the session, `stop()`s the node (container removed /
   Job deleted), validates the output against `output.schema` itself (authoritative) and continues.
5. Cancellation, timeouts and lease loss revoke all sessions of the run and stop all nodes; the
   existing lease logic requeues the run (a new attempt gets new sessions).

#### 3.4 Model calls from run nodes

Run nodes call models only through the control node (`POST /v1/worker/runs/{id}/model`, same
request/response types as `ModelProvider`), so provider keys never leave the control node, egress
and air-gapped rules apply in one place, and token usage and cost are measured by the control
node rather than reported by an untrusted node. External harnesses (Claude Code, OpenCode) keep
running in the orchestrator in v0.2; harnesses inside run nodes are a later decision.

#### 3.5 Isolation requirements

- **Container runner (W1-3)**: non-root UID, read-only root filesystem, `cap-drop ALL`,
  `no-new-privileges`, default seccomp, PID/CPU/memory limits, tmpfs for `/tmp` and `/run/oax`, no
  host mounts, no engine socket inside, image by digest only. The node sits on an internal network
  (`internal: true`) whose only exits are the control node and an egress proxy that allows exactly
  the step's `egress` hosts (HTTP CONNECT allowlist); other protocols have no route.
  The worker reaches the engine **only through a socket proxy** (allowlisting create/start/wait/
  stop/remove/inspect of containers and networks, denying exec, build, volumes, privileged
  options) or a **rootless Podman** socket (`OAX_CONTAINER_ENGINE_URL`). The runner also refuses to
  send create options with `Privileged`, binds, devices, host network/PID/IPC (defence in depth).
  A raw `/var/run/docker.sock` is refused unless `OAX_CONTAINER_ALLOW_RAW_SOCKET=true`, which logs a
  warning at start and writes the audit entry `runner.unsafe_socket`.
- **Kubernetes Job runner (W1-4)**: one Job per step, restricted PodSecurity, no automounted
  service account token unless IRSA needs it, `activeDeadlineSeconds` and
  `ttlSecondsAfterFinished` set, per-run NetworkPolicy from the step egress. The short-lived Secret
  holds **only the run token** (and later the mTLS client certificate), owner-referenced to the Job
  and deleted at step end; step credentials come through the broker (this replaces "Secret holding
  the step's credentials" in the W1-4 text).
- **Opt-in**: nothing isolating runs by default. Container: `OAX_RUNNERS_ENABLED` contains
  `container` **and** `OAX_CONTAINER_RUNNER_ENABLED=true`; Kubernetes: `kubernetes-job` and the
  existing `OAX_K8S_JOB_ENABLED=true`. Publishing a definition that needs a disabled runner fails.

### 4. Agent Check and Agent Plan v1 (W1-5, advisory)

- **AgentPlan** (`packages/core/src/plan/`), YAML or JSON, strict:

  ```yaml
  apiVersion: openagentix.io/v1alpha1
  kind: AgentPlan
  name: payment-ticket-analysis        # slug
  version: 0.1.0                       # SemVer
  description: ...                     # the process in plain language (max. 4000 chars)
  schemas: { ... }                     # same subset and limits as agents.md
  steps:                               # 1..20
    - id: research                     # slug, unique
      purpose: ...                     # max. 1000 chars
      capabilities: [jira:read, crm/get_customer]   # see below
      access: read-only                # read-only | write
      approval: none                   # none | required
      input: { from: [event], schema: Ticket }      # schema names, optional
      output: { schema: Finding }
      when: 'steps.research.output.severity == "high"'   # same grammar as agents.md
  ```

  Capabilities are strings: `<server>:<profile>` (profile grant), `<server>/<tool>` (single tool,
  `*` suffix allowed but linted) or `model` (no tools). The separators make profile and tool names
  unambiguous.
- **Inputs to the model**: the description, connection names, profile names and tool access
  classes only; never secrets, never tool descriptions from MCP servers (untrusted text). The model
  output is data: it must validate against the AgentPlan schema (one repair attempt with the
  validation errors), otherwise the check fails with those errors.
- **Least-privilege lint** (deterministic, pure function of plan + offered capabilities + lint
  version; no model, no clock):

  | Code | Rule | Severity |
  | --- | --- | --- |
  | `LP001` | write capability without `approval: required` | warning |
  | `LP002` | step reads one system and writes another | warning |
  | `LP003` | step holds write capabilities of more than one system | warning |
  | `LP004` | capability not offered by the available connections | error |
  | `LP005` | step output used by a later step (`from`/`when`) without an output schema | warning |
  | `LP006` | `access: read-only` with a write capability | error |
  | `LP007` | `when`/`from` invalid or referencing an unknown or later step | error |
  | `LP008` | wildcard tool capability (`server/*`) | warning |

  Output format:

  ```json
  {
    "kind": "AgentPlanLint",
    "lintVersion": 1,
    "planDigest": "sha256:<hex of the canonical plan JSON>",
    "findings": [
      { "code": "LP001", "severity": "warning", "path": "steps.2.capabilities.0",
        "message": "write capability jira:write without approval", "source": "lint" }
    ],
    "summary": { "error": 0, "warning": 1, "info": 0 }
  }
  ```

  Findings are sorted by `path`, then `code`; messages come from fixed templates.
- **Model suggestions can only add findings**: the model may return `notes`; they become findings
  with `source: "model"`, `code: "MODEL"`, severity `info` or `warning` (never `error`), max. 20,
  500 characters each, appended after the lint findings. They cannot remove, downgrade or reword a
  lint finding and never change the plan or grant anything. A plan with `error` findings cannot be
  turned into an agents.md draft.
- **Generator**: plan -> draft agents.md is deterministic (no model): steps -> `agents[]`,
  capabilities -> profile or concrete grants with the step's `approval`, `access`, `input`,
  `output`, `when` and `schemas` copied; provider/model from the request or `simulated`. The draft
  must pass `validateAgentSource`; nothing is published automatically.
- Audit: `plan.checked` `{ planId, planDigest, model, findings summary, costMicros }`,
  `plan.saved` `{ planId, version, planDigest }`. The check is costed and budget-checked like a run
  step.

### 5. Shared files, migrations and merge order

**Migration numbers** (fixed; a PR never renumbers another item's migration):

| Number | File | Owner |
| --- | --- | --- |
| 0005 | `0005_agent_plans.sql` | W1-5 |
| 0006 | `0006_security_overrides.sql` | W2-3 |
| 0007 | `0007_evaluations.sql` | W2-4 |
| 0008 | `0008_agent_budgets_channels.sql` | W2-5 |
| 0009 | `0009_run_node_sessions.sql` (table `run_node_sessions`, column `tenants.secret_refs`) | W1-3 (new in this ADR) |

W1-1, W1-2, W1-4 and W1-6 need no migration: new step kinds/statuses are text values in
`run_steps`, profiles live in the connection's `config` JSONB, the expansion in the version's
`definition` JSONB. Drizzle's
`meta/_journal.json` and snapshots are regenerated on rebase (`drizzle-kit generate` in the owner's
PR), never hand-merged; a migration whose number is not yet the next free one waits for the lower
numbers to merge (a gap is allowed only if the lower item is explicitly deferred in its issue).

**Shared-file ownership**:

| File | Owner (may restructure) | Others (may only append) |
| --- | --- | --- |
| `packages/runners/src/executor.ts` | W1-1: loop head (`when`), input assembly, output validation | W1-3: the `dispatchStep` seam only; W3-4, W3-5, W4-5 later; hooks, no reshuffling |
| `packages/runners/src/types.ts` | W1-3 (section 3.2 types) | W1-1: step kinds/statuses |
| `packages/runners/src/stubs.ts` | W1-3 removes `container`, then W1-4 removes `kubernetes-job` | - |
| `packages/core/src/run-token.ts` | W1-3 (`sid`, `steps` claims, optional) | - |
| `packages/core/src/agents/*` | W0-1 (this ADR) | W1-1, W1-2: new files next to it (`handover.ts`, `conditions.ts`), no schema changes without an ADR amendment |
| `packages/core/src/policy/engine.ts` | W1-2 (`profile_write_denied`) | W2-3 (override input) after W1-2 |
| `packages/core/src/domain.ts` | W1-1 (`condition`, `handover` step kinds) | - |
| `packages/core/src/index.ts`, `packages/runners/src/index.ts` | - | everyone: append exports |
| `apps/api/src/config.ts`, `docs/configuration.md` | - | W1-3, W1-4: own block/section each |
| `apps/api/src/http/routes/worker.ts` | W1-3 | - |
| `apps/api/src/services/agents.ts` | W1-2 (publish expansion) | W1-3: per-step runner check |
| `openapi.yaml`, `apps/ui/src/api/schema.d.ts` | generated | every PR regenerates after its final rebase; never hand-merged |
| `apps/ui/src/i18n/locales/*.json` | - | append keys under the item's own namespace (`connections.profiles.*`, `plans.*`, `runs.handover.*`); conflicts are resolved by keeping both sides |
| `CHANGELOG.md` | - | append one bullet under `[Unreleased]`; keep both sides on conflict |

**Merge order**: inside wave 1 by item number where files overlap: W1-1 before W1-3 (executor),
W1-3 before W1-4 (stubs, run node, token), W1-2 before W2-3 (policy engine). W1-5 and W1-6 touch
disjoint files and merge whenever green. The later PR rebases, reruns tests and regenerates the
generated files. Any change to sections 1-4 of this ADR needs an amendment PR first.

### 6. OpenAPI additions (schema level only; generated by the owning item)

- `AgentDefinition` / agent version responses (W1-1, W1-2): agent objects gain the optional
  `input`, `output`, `when`, `access`, `credentials` (`[{ secret, env? }]`), `runtime`,
  `profileGrants`; definitions gain `schemas`; versions gain `expansion` and `expansionDigest`.
- `RunStep` (W1-1): `kind` adds `condition`, `handover`; `status` adds `skipped`.
- `Connection` config (W1-2): `McpToolAccess { access: "read" | "write" }`,
  `tools: { [name]: McpToolAccess }`, `profiles: { [name]: string[] }`.
- Worker API (W1-3), security `runToken`:
  - `StepHandover { agentId, agent: AgentSpec, input: any, outputSchema?: object, attempt }`
  - `StepHandoverResult { agentId, format, content, json? }`
  - `StepCredentialsRequest { agentId }`;
    `StepCredentials { agentId, expiresAt, credentials: [{ secret, env, value }],
    connections: [{ server, env?: { [name]: string }, headers?: { [name]: string } }] }`
    (response only, `Cache-Control: no-store`, never logged)
  - `WorkerModelRequest` / `WorkerModelResponse` (mirror the provider request/response, usage
    measured by the control node)
- Plans (W1-5): `AgentPlan`, `AgentPlanFinding { code, severity, path, message, source }`,
  `AgentPlanLint`, `AgentCheckRequest { description, connections?: string[], modelConnectionId }`,
  `AgentCheckResult { plan?, lint, errors?, usage }`, `PlanDraft { id, version, plan, lint,
  createdAt }`.
- Error codes: `handover_invalid`, `handover_missing`, `condition_error`, `when_invalid`,
  `profile_write_denied`, `credential_already_issued`, `credential_scope`, `run_node_session_revoked`.

## Consequences

- Positive: wave 1 items have fixed field names, AST, schema subset, endpoints, audit actions,
  error codes and file ownership; they can be built in parallel. Existing files and stored versions
  are untouched; new fields are validated at publish today, so authors get errors early.
- Positive: the trust boundary is explicit. Validation, conditions, budgets and model access stay in
  trusted components; a compromised step can at most misuse its own tools and credentials for the
  lifetime of its session.
- Negative: until W1-1..W1-3 land, the new fields are parsed and validated but have no runtime
  effect (profile grants grant nothing). Docs must say so (`docs/agents-md.md`).
- Negative: the regex subset is conservative (`^[a-z]+(?:-[a-z0-9]+)*$` is refused; write
  `^[a-z][a-z0-9-]*$`). The model proxy and the session table make W1-3 larger than the plan's
  first estimate.
- Negative: static secrets cannot be recalled once handed to a run node; real revocation needs
  dynamic credential sources (later).

## Alternatives considered

- **Bump `apiVersion` to `v1alpha2`**: no gain for an additive change; every existing file would
  need a conversion. Rejected; the strict schema already makes older control nodes refuse new files.
- **Full JSON Schema with remote `$ref`**: supply-chain and SSRF risk at validation time, unbounded
  work. Rejected.
- **CEL, JSONata or JavaScript for `when`**: CEL is a large dependency, JSONata and JavaScript are
  Turing-complete or close to it. A 9-operator grammar covers the pipeline use cases and is easy to
  audit. Rejected for v0.2.
- **Evaluation errors as `false`** (skip): hides broken conditions and can skip a guarding step.
  Rejected (fail closed).
- **Push model for secrets** (env vars or Kubernetes Secrets): values become visible through
  `inspect` and the cluster API and outlive the step. Rejected.
- **Provider keys issued to run nodes**: simpler, but leaks long-lived keys into untrusted nodes and
  lets a node misreport usage. Rejected.
- **Validating handovers in the run node only**: a compromised node could skip it. Rejected; the
  orchestrator validates authoritatively.

## Amendment 1 (W1-3a, 2026-10-04): what the implementation settled

Found while implementing the run node and the container runner; sections 1 to 4 otherwise stand.

- **Token delivery (3.3 step 2, 3.5)**: the engine refuses to copy files into a container with a
  read-only root filesystem (`docker cp`: "container rootfs is marked read-only", also for tmpfs
  mounts; verified on Docker 29.8), so `/run/oax/token` cannot be populated. The container runner
  attaches the container's **stdin before the start** and writes the token once (line 1; line 2 is
  the node's egress proxy account), then closes stdin. The node reads it from the file named by
  `OAX_RUN_TOKEN_FILE` (`/dev/stdin` in a container, a mounted Secret path for Jobs). Stdin is not
  visible through `inspect`, the environment or the command line. `/run/oax` stays a tmpfs for
  per-step files.
- **Session row (3.3)**: `run_node_sessions` additionally holds `handover` (the step's spec, input,
  output schema, stripped MCP configs), `result` (what the node posted) and `credentials_issued`
  (the once-per-step-and-session guard); `tenant_id` partitions it like every other table.
- **Handover payload (section 6)**: `StepHandover` also carries `run` (`name`, `version`,
  `classification`, `budget`) and `mcp` (the MCP connections of the step with secret references
  stripped; values arrive through the broker). `StepHandoverResult` also carries `usage` and, instead
  of an output, `failure { status, code, message }` so that a policy block stays a policy block.
- **Egress proxy (3.5)**: a separate, stateless service (HTTP `CONNECT`, image target
  `egress-proxy`) on the node network and an egress network only. Nodes authenticate with signed,
  expiring grants minted by the runner; the proxy applies the operator ceiling, the grant's rules
  and a check of the resolved address (private, shared, metadata, loopback and link-local ranges are
  closed to step authors; only an operator can open private ranges). No port means 443.
- **Credential scope (section 2)**: the tenant allowlist compares canonical names (the resolver maps
  `a.b-c` and `a-b.c` to the same secret), every tenant starts with an empty allowlist, platform
  secrets (provider keys, event sources, platform connections) are never delivered, and the same
  allowlist applies to in-process runs. Cost and token numbers of a node are not recorded until the
  model proxy (W1-3b) measures them on the control node; a node receives the REMAINING budget.
- **Migration number**: `0009_run_node_sessions.sql` keeps the reserved number; the journal index is
  5 because 0005 to 0008 are not used yet.
- **Model calls (3.4)** are **not** part of W1-3a: until W1-3b, a run node can only use the keyless
  `simulated` provider; every other provider fails the step with `model_proxy_unavailable`.

## Amendment 2 (DOG-2, 2026-10-09): workspace tools for harness steps

A harness step (Claude Code, `--tools ""`) has no filesystem tools of its own. The only way it can
read or change the checkout of its run node is the **workspace tool contract** below: an MCP server
named `workspace` (`@openagentix/workspace`, `oax-workspace` on stdio, or in-process) that the node
starts in the checkout, listed as a normal connection of the step. Every call is therefore decided
by the policy gate and recorded (`policy_decision`, `tool_call`, audit chain) like any other tool
call. Details and limits: [workspace tools](../workspace-tools.md).

- **Tools and classes** (declared in the connection, section 1.3): `list_files`, `read_file`,
  `search`, `diff` are `read`; `edit_file`, `write_file`, `run_tests` are `write` (they change the
  tree or execute code). The agent has `access: write`; the write is confined to the node's
  workspace.
- **Two walls per rule.** The grant (`workspaceToolGrants()`) lists every argument, constrains write
  paths to `^(src|test)/[A-Za-z0-9._/-]{1,200}$` with `deny: ["\\.\\.", "^\\."]`, caps calls per
  tool, and refuses unknown arguments. The server repeats every rule (paths, sizes, counts), so a
  grant that is too wide, or a call that bypasses the gate, still cannot leave the workspace.
- **Confinement.** Paths are relative and normalised (no `..`, absolute, backslash, control
  characters); each component is checked with `lstat` and symbolic links are refused everywhere (read,
  write, list, search); files are opened with `O_NOFOLLOW`/`O_NONBLOCK` and re-checked with
  `realpath`; writes go through an exclusive temp file and `rename`. Never accessible, at any
  depth: `.git`, `.github`, other CI configuration, and secret-like files (`.env*`, keys, tokens,
  `.npmrc`, credentials).
- **Limits** (operator configuration, defaults): read 256 KiB per file and 64 KiB per call, write
  64 KiB, tool output 64 KiB, 500 list entries, 200 search matches, 5 MiB seed, 80 tool calls and
  20 minutes as a second wall behind the gate and the platform timeout. Binary and non-UTF-8 files
  are refused.
- **`run_tests`.** The command is fixed by the connection (`command`, `args`, no shell, no model
  input); the model may add only one file argument matching an operator pattern (never starting
  with `-`). Scrubbed environment (`PATH`, throwaway `HOME`/`TMPDIR`, fixed extras: no `OAX_*`,
  `ANTHROPIC_*`, proxy or token variables), own process group, timeout, memory watchdog over all
  processes of the run, output cap, a maximum number of runs. At the end of every run all processes
  that belong to it (group, descendants, orphans of the same UID started during the run) are
  killed with `SIGKILL` and verified, and the call never waits for the output pipes to close. Network denial is the node's (no
  egress grant, internal network), not an in-process promise.
- **Patch computed by the node.** At the end the node (not the model) calls `finalize()`: it walks
  the tree, compares it with the baseline taken from the seed and builds the unified diff itself
  (no `git` binary, so a planted `.git/config` has no effect). The result
  `{ patch, patchSha256, changedFiles, lastTestRun, fullSuitePassed, treeMatchesLastRun,
  testedFinalTree }` goes into the step output.
  The whole patch is refused (`ok: false`, with a code) if anything outside the writable area
  changed, if a symbolic link or special file appears, on mode changes, binary files, more than 20
  files or a patch above 64 KiB. `testedFinalTree` is `fullSuitePassed && treeMatchesLastRun`: the
  last run was the **full suite** (no file argument), it passed, and the tree after it is exactly
  the tree the patch describes. A single passing test file never sets it.
- **Tool output is data.** Results are JSON values; file contents, search hits and test output are
  strings inside them, never instructions; the tool descriptions say so, and a hostile file cannot
  change any state (policy denials end the run after three, ADR 0003).
- **Not part of this amendment**: the seed endpoint, unpacking the seed, passing `patch` through
  the step output and the image that carries the server (DOG-1, DOG-3c, DOG-4).

## Amendment 3 (DOG-2 review, 2026-10-09): trust boundary of test code

`run_tests` executes model-written code **as the same UID as the node process** (the
`oax-workspace` server). The threat model of T4/T9 therefore treats **test code as equal to a
compromised node, including the gate**: it can write to `/proc/<ppid>/fd/1` (into the MCP stream),
read `/proc/<pid>/environ`, the token directory and every other file of the UID, and attach with
`ptrace` where `kernel.yama.ptrace_scope` is 0. The process rules of Amendment 2 (scrubbed
environment, group kill, reaping of stray processes) protect against honest mistakes, not against
hostile test code. The patch and the draft pull request can also become an **exfiltration channel**
(read data written into a source file). Required follow-ups, tracked as issues: run tests under a
separate UID or in a sibling container; seccomp denying `ptrace` and `process_vm_*` and
`ptrace_scope >= 1`; scan the patch for token patterns in the worker (DOG-3) before delivery. The
server logs a warning at startup when `ptrace_scope` is 0. Until then the human review of the
draft pull request is the control, and the dogfooding setup (own repository, no real secrets in
the run node) is the only supported use. Details: [workspace tools](../workspace-tools.md).
## Amendment 4 (DOG-1, 2026-10-09): harness nodes

- **Image per step kind (3.3).** The image of a node is no longer a function of the toolbox alone: a
  step with `runtime.harness` gets the image mapped for its harness (`OAX_CONTAINER_HARNESS_IMAGES`,
  digest-pinned, `harness_image_unknown` fails closed) and `RunNodeSpec` carries the `harness`. The
  runner refuses a harness step on any other image.
- **Egress.** A harness node has no egress grant by default; declared hosts need
  `OAX_HARNESS_EGRESS_ALLOWED=true` (publish and runner check, `harness_egress_denied`).
- **Resources.** The runner applies per-class sizes: `OAX_CONTAINER_HARNESS_MEMORY_MB` and
  `OAX_CONTAINER_HARNESS_TMP_MB` for harness nodes, `OAX_CONTAINER_MEMORY_MB` (512) and
  `OAX_CONTAINER_TMP_MB` for the others; the operator maximum `OAX_CONTAINER_MAX_MEMORY_MB` is a
  ceiling only and does not raise the default of ordinary nodes; `/tmp` may be at most half of the memory. The threat model is otherwise unchanged (read-only root,
  `CapDrop ALL`, `noexec` tmpfs). Details: ADR 0009, amendment DOG-1.
- **Images are exclusive (review fix).** A harness step may not set a toolbox; a step without a
  harness may not run on a harness image (publish check, and a runner check that allows it only if the
  operator also configured that image as default or toolbox image). The harness image carries no
  `org.opencontainers.image.source` label and may only be pushed to a private package.

## Amendment 5 (DOG-4, 2026-10-09): workspace seed endpoint and patch attachment

- **Seed (3.3).** For a step with a `pull-request` output the worker builds the seed from the
  operator target before the node exists (`OutputSchema.target`, `OAX_PR_TARGETS`) and stores it with
  the session (`run_node_sessions.workspace_seed`, base64, at most 5 MiB, the SHA-256 is computed
  by the control node). Audit `workspace.prepared`: commit, size, file count, digest.
- **Endpoint.** `GET /v1/worker/runs/{id}/workspace?agentId=` answers `application/x-tar` with
  `x-oax-seed-sha256` and `cache-control: no-store`. It needs a step-scoped run token of exactly
  this run and step; it answers **once** per session (`409 workspace_seed_already_fetched`), the
  bytes are deleted in the same statement and again when the session is revoked. Audit
  `workspace.fetched` carries size and digest only.
- **Node-side unpacking.** The node does not trust the packer: it verifies the digest, parses the
  whole archive first and refuses (`seed_invalid`) anything but regular files with the modes 0644 and
  0755, relative UTF-8 names without `..`, `.`, empty or `.git` segments, duplicates (also by case and
  Unicode form), links of any kind, devices, extended headers, size or count above the limits, and
  trailing data. The root must be empty. Nothing is written when the archive is refused.
- **Patch attachment.** The step result gains an optional `patch` (`{ patch, patchSha256,
  changedFiles, lastTestRun, fullSuitePassed, treeMatchesLastRun, testedFinalTree }`, at most 128 Ki
  characters) read by the node from the workspace server's result file. It is not rewritten by the
  secret scrubber (a changed byte would only break its digest); the worker scans it. Delivery
  requires `lastTestRun.passed` **and** `testedFinalTree` (the stricter rule of Amendment 2).


## Amendment 6 (input hardening, 2026-10-09): what is cleaned before the model sees it

Untrusted text (issue and event text, tool results, the previous agent's output) was already
treated as data by the system prompt and the policy gate. Two deterministic stages now run on it
before it enters a model context or a stored step output. Details and limits:
[input hardening](../security-input-hardening.md).

- **Choke points.** `ToolGateway.call` guards every tool result and the message of every failed
  call (all runners, run nodes and the harness gate go through it), `ToolGateway.exposedTools`
  guards tool descriptions and input schemas, and the executors guard the finished first prompt.
  The model proxy is not changed: text a harness generates inside its own process is out of scope
  (follow-up #170).
- **Invisible Unicode** (zero-width, bidi, tag block, variation selector supplement, runs of
  variation selectors, control codes, other invisible format characters and fillers) is removed;
  ZWJ and ZWNJ survive only between non-ASCII letters, marks or emoji, a single variation selector
  only after a visible character.
- **Secrets** (values the process knows to be in use, plus the token shapes shared with the
  pull-request scan) are replaced by `[redacted:<kind>]`. The credential broker's values and the
  node's run token are registered with the guard, so they cannot re-enter the context through a
  tool result.
- **Audit.** A `control` step `input_guard` with counts and class or kind names only. A run node may
  report exactly this one control step; the control node reduces it to the same shape.
- **Settings.** `OAX_STRIP_INVISIBLE_UNICODE` and `OAX_REDACT_MODEL_CONTEXT`, on by default, off only
  for diagnostics; an unrecognised value keeps the stage on.
