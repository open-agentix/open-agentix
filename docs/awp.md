# AWP: vendored schema and conformance suite

The [Agentic Workflow Protocol (AWP)](https://github.com/open-agentix/agenticWorkflowProtocol.org) is a
**draft** (`v1alpha1`) maintained in our own sister repository. This page describes the pinned copy of its
JSON Schema and conformance suite that lives in this repository, and how to update it.

## Wording rule

Use exactly this wording about AWP anywhere (README, docs, UI, release notes):

> built to the AWP schema, conformance in progress (alpha)

openagentix is **not conformant** to AWP today and makes no conformance or compliance claim. The wording
stays like this until the conformance harness passes on `main`.

## What is vendored

`packages/awp/vendor/awp-v1alpha1/` is a byte-identical copy of these files from the AWP repository, at the
upstream relative paths (so the vendored checker runs unmodified):

| Path                             | Content                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------- |
| `schema/awp.v1alpha1.json`       | the JSON Schema                                                               |
| `schema/README.md`               | the rule catalogue (upstream name; the issue called it `schema-README.md`)     |
| `conformance/`                   | `index.json`, `valid/`, `invalid/`, `awp-check.mjs`, `semantic.mjs`, `README.md` |
| `package.json`, `package-lock.json` | the two pinned dev dependencies of the checker (`ajv`, `yaml`)             |
| `LICENSE`, `LICENSE-SPEC`        | the upstream licence texts                                                    |
| `PROVENANCE.json`                | source URL, commit SHA, retrieval date, licence and SHA-256 of every file       |

It is a plain copy, not a submodule. It is never edited by hand, excluded from prettier and eslint, marked
`-text` in `.gitattributes` (no line-ending normalisation), and **not part of any published package**
(`packages/awp` has no `package.json`; nothing publishes it, and nothing imports the checker at runtime).
Licences: code, schema and conformance manifests are Apache-2.0; Markdown prose is CC BY 4.0.

## Pin check

```sh
node scripts/awp/verify-pin.mjs
```

The check is offline (Node built-ins, local files only). It fails and prints the path when a file is changed
(hash mismatch), missing, extra (not listed), not a regular file (for example a symlink), listed twice or
with an unsafe path, or when `PROVENANCE.json` is malformed. CI runs it as job `awp-pin` on pull requests
and on `main`. Its tests are in `packages/awp/test/verify-pin.test.ts` (part of `pnpm test`).

The check detects accidental or unnoticed edits of the vendored files. It cannot stop a pull request that
changes a file **and** `PROVENANCE.json` together: such a change is visible in review and must be treated as
an AWP upgrade (below).

## Upgrade procedure

1. Update a local clone of the AWP repository and review it. Pick a release tag once AWP publishes releases,
   otherwise a commit SHA. Check out that revision (the checkout must be clean).
2. Replace the copy and regenerate the provenance (local paths only, no network access):
   `node scripts/awp/vendor-awp.mjs <path-to-awp-checkout> [--tag vX.Y.Z]`
3. Review the diff of `schema/awp.v1alpha1.json` and the conformance manifests; for the reviewer, compare
   with the upstream commit: `git diff --no-index <awp-checkout>/schema packages/awp/vendor/awp-v1alpha1/schema`.
4. Run `node scripts/awp/verify-pin.mjs`, `pnpm lint`, `pnpm typecheck` and `pnpm test`, add a
   `[Unreleased]` changelog line, and open a pull request (security review: supply chain).

## Manifest exporter: `agents.md` to an AWP manifest

AWP is a **draft** (`v1alpha1`). The exporter maps a published agent version to an AWP manifest that is
built to the pinned schema. The result is a **mapping**, not a conformance claim: openagentix is not
conformant to any AWP profile, and an exported manifest does not change that. Wording stays "built to
the AWP schema, conformance in progress (alpha)".

```sh
# API: the effective manifest of a published version (RFC 8785 bytes, same bytes on every call)
GET /v1/agents/{id}/versions/{version}/awp

# CLI: a file as parsed (needs --owner-team; no publish context, so no profile or wildcard grants)
oax awp export examples/awp/release-notes.agents.md --owner-team team-docs [--canonical]
```

The CLI has no client for the control node (outbound HTTP goes through the dispatcher of ADR 0011), so
`oax awp export <agent-id>@<version>` is refused with a pointer to the endpoint above.

Code: `packages/core/src/awp/` (`exportAwpManifest`, `awpManifestDigest`). The exporter is pure: it reads
the stored definition of the version and never parses the `agents.md` source again, so a newer parser
cannot change what an old version exports.

### What is mapped

The exporter writes the kind `Workflow`: front matter and the `## Agent:` sections (as `instructions`)
become `metadata` and `spec` per the alignment matrix of the AWP repository (identity, triggers, budgets,
approvals, per-agent tool grants and permissions, egress as `permissions.network`, credentials as
`spec.secrets`, pipeline as a `dependsOn` chain). Operational settings that AWP has no field for
(descriptions, model parameters, output formats, simulation fixtures, credential variable names, the
harness, `mode`) are written as `x-openagentix-*` extensions on the object they modify. They are safe to
ignore: a runtime that ignores them runs the agent with the same or stricter limits.

`spec.mcpServers` and `spec.actionGroups` are **not** written. Connections are platform objects; the
manifest names servers only, so an AWP validator reports the warning `mcp.server-unresolved` (a runtime
must bind the server). Profile grants are exported as the explicit tools they were expanded to when the
version was published.

### Critical fields: refused today

Some limits have no AWP v1alpha1 field. A runtime that ignored them would allow **more** than the
`agents.md` source allows. These are the critical fields: `when`, `input`, `output`, `schemas`, `access`,
tool `args`, `allowAdditionalArgs`, `maxCallsPerRun`, grant `classification`, `runtime.runner` /
`runtime.toolbox` (per step, per pipeline and `toolbox`) and `guidelines`. The pinned schema has no
`metadata.requiredExtensions` (AEP-0011, not part of v1alpha1), so a manifest cannot say that an extension
must not be ignored. Therefore (AWP decision D3) **the export is refused** with one finding per field:

```json
{ "code": "critical_extension", "field": "maxCallsPerRun", "extension": "x-openagentix-maxCallsPerRun",
  "path": "agents.0.tools.1.maxCallsPerRun", "message": "..." }
```

`allowAdditionalArgs` counts when it is `false`, which is the default: a grant without `args` only
allows calls without arguments, and AWP would read "no `args`" as unrestricted. In practice **an agent
that has a tool grant is exported only if the grant sets `allowAdditionalArgs: true` and nothing else
critical** (see `examples/awp/ticket-commenter.agents.md`). Agents without tool grants, and profile grants
without limits, export. This is a consequence of the draft, not a recommendation to loosen argument
checks. A grant that allows more arguments (`true`) **and** has constraints writes the `true` explicitly,
so a reader does not have to know the default of the format; that is one more critical field for such a
grant.

`PINNED_AWP_FEATURES.requiredExtensions` in `packages/core/src/awp/types.ts` is `false`. A test fails when
the vendored schema disagrees, so a pin upgrade that adds AEP-0011 forces a deliberate switch. When it is
`true`, the same code writes the extensions and lists their names, sorted, in `metadata.requiredExtensions`
instead of refusing (tested with an override; it cannot be validated against the current schema).

### Step conditions (`when`, AEP-0001)

[AEP-0001](https://github.com/open-agentix/agenticWorkflowProtocol.org/blob/main/aep/0001-conditional-steps.md)
proposes an optional step field `when` (status **Review**, not accepted, target `v1alpha2`). The pinned
`v1alpha1` schema has **no** step `when` (only policy rules have a `when`), so today:

- The exporter writes the condition of an `agents.md` agent as the critical extension
  `x-openagentix-when` and, like every critical extension, refuses the export until the pin offers
  `metadata.requiredExtensions` (see above). With `requiredExtensionsSupported` it is listed there.
  When `PINNED_AWP_FEATURES.stepWhen` is `true` (a pin that contains AEP-0001; a test fails while the flag
  and the vendored schema disagree) the same code writes the core field `when` and needs no extension.
  Both paths are tested against a **test-only copy** of the schema with the field added; the vendored
  files are never edited.
- The text is **translated, not copied**. `agents.md` reads `steps.<id>.output.<path>` and
  `event.<path>`; AEP-0001 reads `steps.<id>.outputs.<name>.<path>`, `inputs.<name>`, `event` and
  `execution.environment`. The exporter parses the condition, rewrites the tree and prints it again:
  `steps.a.output.severity` becomes `steps.a.outputs.result.severity` (every exported step declares
  the output `result`), and `event.data.<path>` becomes `inputs.event.<path>` (the payload is the
  declared input `event` of an event-triggered workflow). Strings are printed double-quoted with JSON
  escapes. What cannot be mapped is refused with `condition_not_representable`: `event.type`,
  `event.source` and other CloudEvent attributes, `event.data` without an event trigger, and a condition
  that exceeds an AEP limit after the longer paths (128 tokens, 512 characters). Nothing is dropped:
  `verifyNoWidening` also fails an export whose step lost the condition of its source agent.
- The grammar, the limits (512 characters, 128 tokens, depth 16, 16 path segments, 32 list items, strings of
  256 characters, indexes up to 10000), the strict typing and the fail-closed evaluation are the ones
  `agents.md` already has (ADR 0008): AEP-0001 is based on that grammar (decision D5).
- The validator reads `when` and `x-openagentix-when` and reports `when.syntax`, `when.limits`,
  `when.unknown-step`, `when.not-a-dependency` and `when.undeclared-output` (errors) and
  `when.undeclared-input` (warning), at the path of the field. It only parses; it never evaluates.
  The AEP's invalid conformance cases are not in the vendored suite yet, so the baseline is unchanged.

Safety properties, unchanged by the export: a condition can only **restrict** a step. A false condition
skips it and grants nothing, a true condition does not bypass permissions, policies or approvals of the
step, and a condition is not an authorisation mechanism (it may read model output, so combine it with
typed output schemas). The evaluator is a tree walker with no `eval`, no `Function`, no regular
expression on data, no functions, no coercion, only the documented roots and own properties, and it fails
closed.

Mapping of the run semantics (the AEP execution model against what the runtime does):

| AEP-0001 | OpenAgentix |
| --- | --- |
| step `skipped`, reason `condition` | run step `condition` / `skipped`, audit `step.skipped` `{ agentId, when, reason: "condition" }` (`agentId` is the step id, `when` the expression text, never the values it read) |
| evaluation error: step `failed`, reason `conditionError` | run step `condition` / `error`, audit `condition.error`, the run fails with `condition_error` (1:1; the pipeline is sequential, so no dependent step is left to skip) |
| execution succeeds with condition skips (D6) | the run is `succeeded` |
| reference to the output of a condition-skipped step | an error, except inside `exists()` which is `false` |
| `skipped`, reason `dependencyFailed` | not produced: a failing step fails the run and ends the pipeline |

Known differences (not conformance statements): (1) after a condition skip the next step without
`input.from` receives the output of the last step that **ran**, whereas the exported `task`
`${{ steps.<previous>.outputs.result }}` is an error in AEP-0001 (`missingOutput`); the AWP reading
fails closed, so it never runs more than the source. (2) String ordering uses UTF-16 code units
(`<`, `>`) where AEP-0001 says code points. (3) AEP-0001 allows `inputs.*` and `execution.environment`;
`agents.md` has no such roots, so they are validated but not evaluated by this product.

### Argument constraints, call limits and action groups (AEP-0002)

[AEP-0002](https://github.com/open-agentix/agenticWorkflowProtocol.org/blob/main/aep/0002-tool-argument-constraints.md)
proposes `args`, `allowAdditionalArgs` and `maxCalls` on a `permissions.tools` entry and gives prefix
wildcards (`jira.get_*`) no place in the format (status **Review**, not accepted, target `v1alpha2`; owner
decision D4). The pinned `v1alpha1` schema has none of the three fields, so today:

| `agents.md` grant | Written now (pin without AEP-0002) | Written once `PINNED_AWP_FEATURES.toolArgs` is `true` |
| --- | --- | --- |
| `args` (not empty) | `x-openagentix-args` | `args` |
| `allowAdditionalArgs: false` (the default) | `x-openagentix-allowAdditionalArgs: false` | nothing; `args: {}` is written when there are no `args` (AEP-0002 reads "no `args`" as no restriction, and ignores `allowAdditionalArgs` without `args`) |
| `allowAdditionalArgs: true` with `args` | `x-openagentix-allowAdditionalArgs: true` | `allowAdditionalArgs: true` |
| `maxCallsPerRun` | `x-openagentix-maxCallsPerRun` | `maxCalls` |
| `classification` | `x-openagentix-classification` | unchanged (no AEP field; a policy rule is the planned successor) |

The extensions are critical: like every critical extension they refuse the export until the pin offers
`metadata.requiredExtensions` (see above). Both paths are tested, the core path against a **test-only copy**
of the schema with the three fields added (never vendored); `awp-argument-constraints.test.ts` fails while
`PINNED_AWP_FEATURES.toolArgs` and the vendored schema disagree. The vendored files are not edited; the pin
bump that brings AEP-0002 is tracked in a follow-up issue.

**Rules that apply to every constraint** (authoring in `agents.md`, validation of AWP manifests, and the
exporter share one implementation, `arg-rules.ts`). They are the rule names of the AEP's schema changes:

- `args.pattern-invalid`: a `pattern` or `deny` entry must compile (ECMA-262, Unicode mode) and be accepted by
  the linear-time matcher, must not use a backreference or lookaround, must not quantify (including with `?`)
  a group that contains a quantifier, and must not repeat a group that contains an alternation at any depth
  (`(a+)+`, `(x(y+))?`, `(a|aa)*`, `((a|a))*`). These are conservative syntax checks, **not proofs**: the
  security property comes from the matcher (below), not from them.
- `args.pattern-unbounded`: a `pattern` needs a `maxLength` of at most 4096, and so do `deny` patterns (they run
  against the value). At run time no expression is run against a string longer than `maxLength` (the call is
  denied) or longer than `REGEX_INPUT_LIMIT` (16384 UTF-16 units).
- `args.type-mismatch`: `pattern`, `minLength`, `maxLength` need type `string`, `minimum`/`maximum` a numeric
  type, `maxItems` an array.
- `args.range`: `minimum > maximum`, `minLength > maxLength`.
- `args.with-deny` (AWP manifests): `args` or a call limit on an entry with `allow: false`.
- `args.limit`: more than 64 `deny` patterns on one argument (also in `agents.md`); in manifests also more than
  256 constrained arguments on one entry or more than 256 patterns in one document.

The path of a finding in a manifest is the member that breaks the rule, for example
`/spec/agents/0/permissions/tools/jira.get_issue/x-openagentix-args/key/pattern`. The AEP's invalid
conformance cases are not in the vendored suite yet, so the baseline is unchanged; they will be run when a
pin brings them. An export of a stored constraint that breaks a rule is refused with
`constraint_not_representable` (older versions may hold such a constraint; nothing is rewritten or dropped).

**Run time (policy engine).** Constraints only restrict. Beyond the AEP rules the engine fails closed where
the AEP leaves room: a bound that does not fit the type of the value (`minimum` on a string, `maxItems` on a
non-array, `pattern` on a number) denies instead of being skipped; the arguments of a call must be an object;
only own properties count as arguments (`toString` is not a declared argument); `maxLength` counts code
points; a `deny` rule that cannot look at the whole value (more than 4096 strings or deeper than 32 levels)
denies. Denial reasons name the argument and the rule, never the value.

**The no-widening check (`verifyNoWidening`)** runs on every export and on every re-serve of a stored
conversion, independent of the mapping. Besides the grants it compares the **values** of what restricts: the
argument constraints (equality), `allowAdditionalArgs` (a source that allows no further argument must say
so; a looser or missing value is a finding), the call limit (missing, malformed or higher than the source is a
finding; a lower one is accepted), the data class, and the access class, input, output, schemas, guidelines,
runner and toolbox of the source. Core and extension forms are read alike. When the manifest carries
`metadata.requiredExtensions` (or the pin has the list), every critical extension in use must be listed.
A value of the wrong type at a position that can carry a grant (`permissions.tools` as a list,
`permissions.secrets` or `allowHosts` as a string, a step of another type, a step naming an agent the
source lacks) is a `grant_widened` finding, never read as "empty".

**Matching is linear-time, and the contract is RE2, not ECMA-262.** `pattern`, `deny` and the policy-wide
`forbiddenArgPatterns` are matched with [`re2js`](https://github.com/le0pard/re2js) (pure JavaScript port of
RE2, pinned to an exact version, MIT, no dependencies, no install scripts, no native code), never with the
backtracking `RegExp`. A syntax check cannot exclude every slow pattern (`[a-z]*[a-z]*!` took 17 s on 4000
characters in `RegExp`). RE2 matching is linear in the input **times the size of the compiled program**, and
the program grows with every repeat bound (`.{0,1000}x` is about 2000 instructions, 381 ms on 4096 characters;
twenty of them 24 s), so the size is bounded too:

- one repeat bound is at most 200, the bounds of one pattern add up to at most 400, and the compiled
  program has at most 512 instructions (read from `re2Input.prog.inst`, an internal field of the pinned
  version; if it is missing nothing compiles and everything denies). Patterns above these are refused at
  validation (`args.pattern-invalid`) and never compiled at run time (the call is denied);
- a definition may hold at most 256 `pattern` and `deny` expressions (a manifest document too), a pattern is at
  most 1024 characters; validation does not fill the compile cache, the run-time cache is bounded by total
  program size;
- a string above 16384 units is denied; the work of all expressions of one decision is charged in
  **steps (characters scanned times program size)**, at most 10,000,000 per decision (about half a second
  at the measured 45 ns per step); a decision that needs more is denied (fail closed); a `deny` rule that
  cannot inspect the whole value denies; a pattern the matcher cannot take denies.

Semantics are those of RE2, which differ from ECMA-262 (pinned by tests): `.` matches CR (not LF) and the
Unicode line separators, so `^a.b$` accepts `a\rb`; `\s` does not match no-break space or vertical tab, so
`rm\s+-rf` does not catch `rm\u00a0-rf`; `\uXXXX`, `\u{...}`, `\p{Script=...}`, `[^]`, backreferences and
lookaround are not supported (refused, fail closed). Therefore `deny` patterns must not use `.` or `\s`
(spell them out: `[^\n]`, `[ \t\r\n\f\x0b\x{a0}]`); validation warns about `.` in a `pattern`. Policy-wide
`forbiddenArgPatterns` follow the same contract (match case-insensitively); an author who needs Unicode
whitespace writes the class out.
**Patterns are unanchored**: a `pattern` matches when it is found anywhere in the value (substring, like
`RegExp.test`); write `^...$` to match the whole value. Validation warns about an unanchored `pattern`.
Policy bundles are checked with the same rules when they are written (`POST/PUT /v1/policies`).

**Differences from the AEP text** (not conformance statements):

1. One grant decides a call (an exact grant wins over a wildcard of an older version); AEP rule 3 asks for
   "at least one matching entry" and rule 2 for "all applicable objects". The exporter refuses overlapping
   grants that differ (`duplicate_grant_conflict`), so a manifest never claims a union that does not exist.
   Policy bundles (`forbiddenArgPatterns`) apply in addition to the grant, as AEP rule 2 asks.
2. The call limit is `maxCallsPerRun`: it counts allowed calls of the run (all steps), denied calls do not
   count, and a reached limit is the reason `call_limit` (the AEP names `budget`).
3. Patterns are stricter than the AEP (nested repetition and alternation under repetition are refused; `deny`
   needs `maxLength`; at most 64 `deny` patterns).
4. Nested argument paths and policy-wide forbidden patterns (AEP open questions 1 and 3) are not supported.

**Action groups, not prefix wildcards (D4).** Publish **replaces** a prefix wildcard grant (`get_*`, `*`) in
the stored definition by one explicit grant per tool of the approved tool snapshot of a pinned connection,
each with the limits of the wildcard (`args`, `allowAdditionalArgs`, `approval`, `maxCallsPerRun`,
`classification`), so a constraint can only restrict. Overlaps resolve as at run time: an exact grant wins,
and of two wildcards the first wins. This happens in `expandProfiles`, so the review, the expansion digest
and the publish gate see exactly the expanded list (a tool added to the snapshot changes the digest; the
gate is not weakened). A wildcard without such a list fails the publish with `wildcard_unreviewed`, a
pattern that matches nothing with `wildcard_empty`; nothing is granted silently. Validation warns that a
prefix wildcard is deprecated. Versions published by an older build keep their wildcard grant and the
recorded list; they export as before. The export writes the tools as per-tool permission entries, not as
`actionGroups`: the pinned schema's `actionGroups` would need group names and a decision on how a group key
carries limits, which is left to the pin bump. Removal of wildcards from the authoring format follows the
D13 timing (a later release); this release deprecates them.

### Other refusals

All refusals fail closed and name the source path.

| Code                         | Meaning                                                                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `owner_team_mismatch`        | `owner` is not the team the agent belongs to (an author can write any slug; checked at export). |
| `egress_not_representable`   | An egress entry that is not a plain host name (port, CIDR range, `*.suffix`).                        |
| `owner_team_required`        | An AWP owner is a team (D15). The agent belongs to no team; assign one before exporting.              |
| `wildcard_expansion_missing` | A wildcard grant (`get_*`, `*`) of an older version has no recorded tool list (see below).             |
| `constraint_not_representable` | A stored argument constraint breaks a rule of AEP-0002 (pattern without `maxLength`, lookaround, ...). |
| `profile_expansion_missing`  | A profile grant was never expanded (a file, not a published version).                                 |
| `tool_name_not_representable`| `<server>.<tool>` is not an AWP action identifier.                                                    |
| `duplicate_grant_conflict`   | One tool is granted twice with different limits.                                                      |
| `trigger_not_representable`  | A cron schedule that is not five-field (a seconds field).                                             |
| `label_not_representable`, `secret_not_representable`, `pipeline_not_representable` | Names or order that AWP cannot hold. |
| `condition_not_representable` | A `when` condition that cannot be mapped to the AEP-0001 grammar (see above). |
| `unknown_field`              | A stored field the exporter does not know (for example from a newer build): never dropped silently.   |
| `not_canonicalizable`        | A value outside the JSON data model (for example a lone surrogate).                                   |

A cron trigger without an explicit `timezone` is refused too (`agents.md` uses the process time zone,
AWP defaults to UTC, so exporting would silently change when it fires).

### Wildcards (D4)

AWP v1alpha1 has no prefix wildcards in permissions. Publish replaces every wildcard grant by explicit
grants (see "Argument constraints, call limits and action groups" above) and also records the list in
`definition.wildcardExpansion` (key `server/pattern`), **only from the approved tool snapshot of a pinned
connection**; without one the publish fails. The export of a version published by an older build, whose
definition still holds the wildcard, filters the recorded list again by the pattern, so a damaged record
can only shrink the grant; an empty result, or a version without a record, is refused
(`wildcard_expansion_missing`, republish). No `*` appears in any permission key or tool list. The record is
not part of `expansionDigest`; the expanded grants are.

Overlapping grants of one tool (an exact grant and a wildcard of an older version, or a duplicate) are
merged only if they are identical in limits and approval; otherwise `duplicate_grant_conflict`, because at
run time the exact grant wins and a union would claim a control that does not exist.

### Egress

`permissions.network` (`egress: deny` plus `allowHosts`) is written only for a non-empty egress list of
plain host names. Egress is enforced by isolating runners; the in-process runner does not enforce it, so
an empty list is no claim (an isolating runner is a critical field and refuses anyway). Entries with a
port, a CIDR range or a `*.suffix` pattern are refused (`egress_not_representable`) instead of being
passed on with a different meaning.

### Digest and bytes

`metadata.integrity.digest` is `sha256:` over the RFC 8785 (JCS) form of the manifest without
`metadata.integrity`, `signature` and `provenance` (AWP spec 9.1), computed with the repository's own
`jcs` and cross-checked in tests against the vendored reference implementation. Extension values are part
of it. The digest does not depend on YAML formatting or key order of the source (property test).

The API sends the RFC 8785 bytes, so the body is exactly what the digest covers (plus `integrity`), and the
same stored version always yields the same bytes. The digest of the `agents.md` **source** stays an
OpenAgentix value (`agent_versions.digest`, header `x-oax-source-digest`); it is deliberately not written
into the manifest, because it changes with formatting and would break the property above. The owner team
is the stored `owner` slug, exported only when it resolves to the team the agent belongs to
(`owner_team_mismatch` otherwise); renaming a team therefore makes the export refuse rather than name
another team.

The bytes are recomputed from the stored definition on every call. They are stable for one exporter
version; a later exporter version (a new mapping rule, a pin upgrade) can change the bytes and digest
of old versions. The manifest digest is not stored at publish; consumers that need a fixed value should
record the digest they reviewed.

### Verification

`packages/core/test/awp-export*.test.ts` validate every exportable example offline against the vendored
schema with the repository's `ajv`, run the vendored semantic rules with digest verification and compare
the digest with the vendored reference implementation. Golden manifests are in `examples/awp/*.awp.json`
(regenerate with `UPDATE_GOLDEN=1`, then `pnpm format`). Nothing is fetched at build or run time.

## Manifest validation: reading AWP manifests (AWP-3)

AWP is a **draft** (`v1alpha1`). OpenAgentix validates AWP manifests; it does **not** store, publish or
run them yet, and it is not conformant to any AWP profile. Wording stays "built to the AWP schema,
conformance in progress (alpha)". Validation is offline: nothing is fetched at build or run time, and
the only inputs are the vendored copy (`packages/awp/vendor/`, never edited by hand) and the extension
schema of this repository.

```sh
# API: same endpoint as for agents.md; the response says how the source was read
POST /v1/agents/validate        { "source": "<agents.md, JSON or YAML text>" }   -> format: "awp" | "agents-md"

# CLI: only *.awp.yaml, *.awp.yml and *.awp.json are AWP documents (size checked before reading); an .md file
# is read as AWP when its front matter says apiVersion: awp.…, otherwise as the legacy agents.md
oax validate examples/awp/ticket-updater.awp.md
```

### Accepted forms

| Form | Example | Notes |
| --- | --- | --- |
| `agents.md` with AWP front matter | `examples/awp/ticket-updater.awp.md` | The front matter is one YAML document. `## Agent: <id>` sections supply `instructions`. |
| plain JSON or YAML | `examples/awp/*.awp.json` | One or more YAML documents (spec 3.1); every document is validated on its own. |

A text is treated as AWP when its `apiVersion` starts with `awp.`; a file with `openagentix.io/v1alpha1` is
the legacy format and goes to the legacy parser unchanged (it is deprecated; the transition, the one-time
conversion and `oax awp convert` are described in [agents.md: transition to AWP manifests](agents-md.md#transition-to-awp-manifests)). The legacy parser
refuses an AWP file with `awp_not_runnable` instead of listing dozens of unknown fields.

**Effective manifest and digest.** For `agents.md` the effective manifest is the front matter with the text
of each `## Agent: <id>` section injected as `instructions` of the inline agent `<id>` (trimmed, line endings
normalised); title, overview and other sections are documentation and do not change it. The digest is
`sha256:` over the RFC 8785 form without `metadata.integrity`, `signature` and `provenance` (spec 9.1), so
the JSON form, the YAML form and the `agents.md` form of one manifest give the same digest. A declared
`metadata.integrity.digest` is verified (`digest.mismatch`); the digest of the `agents.md` source stays an
OpenAgentix value and is not part of this. Decision: the heading keyword `Agent:` is case-insensitive, the id
is not (`## Agent: A` does not match agent `a`).

### Findings

The result lists findings with the AWP diagnostic `code` and the JSON Pointer `path` of the rule catalogue
(`schema/README.md`): the same codes and paths the reference checker reports, for YAML and JSON alike.
Structure comes first (`schema.<keyword>`, from the pinned schema); only a structurally valid document gets
the semantic rules (`id.duplicate`, `dependsOn.cycle`, `profile.unsupported`, `digest.mismatch`, ...). A
warning does not make a manifest invalid. Codes of the form `extension.*`, `wrapper.*`, `limit.*` and
`when.*` (step conditions, AEP-0001, see the exporter section), `yaml.cycle`, `yaml.unsafe-integer`, `yaml.non-json-value`, `digest.not-canonicalizable` are OpenAgentix's own.

**Where the code comes from.** `scripts/awp/generate-types.mjs` writes `packages/core/src/awp/generated/`
(the embedded pinned schema, the embedded extension schema and the TypeScript types `Awp*`), each file with
the hash of its input. The output is committed, never edited by hand; CI runs the script with `--check`
(job `awp-pin`) and fails on a stale or hand-edited file. The structural validator is the repository's `ajv`
compiled from that copy with the options of the reference checker. The semantic rules
(`manifest-semantic.ts`) are OpenAgentix's own port; `awp-semantic-diff.test.ts` runs them against the
vendored `semantic.mjs` on the whole conformance suite and on deterministic mutations and requires equal
findings, and `awp-manifest-conformance.test.ts` runs every vendored `valid/` and `invalid/` case.

### Fail closed

- **Unknown fields** are errors (`schema.additionalProperties`, the field is in the path). Other vendors'
  `x-` fields are ignored (spec 3.3).
- **Profiles.** Supported: `core`, `governance`, `mcp` (what the exporter writes). Fields of `audit`,
  `security` and `a2a` are rejected with `profile.unsupported` naming field and profile. Supporting a
  profile here means the validator checks its fields, not that anything enforces them: nothing runs from a
  manifest. `packages/core/test/data/awp-field-coverage.json` lists every schema property as `handled` or
  `rejected`; the drift test fails when the pinned schema gains a property that is in neither list.
- **`x-openagentix-*` extensions** are validated against `packages/awp/extensions/openagentix-extensions.v1alpha1.json`,
  per location (agent, step, tool permission, spec). Decision: the namespace is ours and stricter than
  AWP 3.3 requires, because a typo (`x-openagentix-maxCallPerRun`) would silently drop a limit. A name that
  is not in the schema is `extension.unknown`; a known name on the wrong object is `extension.misplaced`; a
  bad value is `extension.invalid` with the path inside the value; a credential-shaped literal inside an
  extension is `extension.secret` (the AWP rule `secret.literal-field` does not look into `x-` subtrees).
- **Critical extensions** (those that restrict behaviour, the list of "Critical fields" above) are valid
  but warned about as `extension.critical-not-declared`: the pinned schema has no
  `metadata.requiredExtensions` (AEP-0011), so the manifest cannot say that a runtime must not ignore
  them, and it is **not portable**. A manifest that carries `metadata.requiredExtensions` today fails
  structurally (`schema.additionalProperties /metadata/requiredExtensions`). When a pin upgrade adds the
  field, the same code switches on: every listed name must be known (`extension.required-unknown`, other
  vendors' names are refused because they cannot be honoured) and every critical extension must be listed
  (`extension.required-missing`); tests run this with a schema that has the field.
- **Limits** for untrusted input (`AWP_LIMITS`): 512 KiB of source, 50 000 nodes (shared across the documents
  of a file), depth 64, 1000 workflow steps and 1000 agents, 16 documents, 200 findings, and 50 YAML aliases
  in the parser's accounting (the expansion of aliases is in any case bounded by the node budget, which is
  checked on the parsed value). No custom tags, no non-string keys, no duplicate keys, no cycles, no
  `.inf`/`.nan`, no integers beyond 2^53, JSON read by the same YAML parser, YAML 1.2 core schema (so `<<`
  merge keys are an unknown field). The cycle search is iterative; a hostile document never throws.
  Prototype-polluting keys (`__proto__`, `constructor`) are plain data and, where the schema is closed,
  unknown fields.
- **Deliberate divergence from the reference checker.** The semantic rules for workflows are quadratic in
  the number of steps (transitive closure for `expr.not-a-dependency`, cycle messages). A workflow with
  more than 1000 steps or 1000 agents is therefore refused with `limit.steps` before the semantic and
  extension rules run; within the limits the findings are identical to the vendored `semantic.mjs` (the
  differential test). The semantic phase also stops collecting after the finding cap, and a cycle message
  is only built for a finding that is kept. The expression scan (`EXPR_RE`) is quadratic on a malformed
  `${{`, which is unreachable because the schema pattern for expression fields rejects such a string first;
  `awp-manifest-hostile.test.ts` keeps that invariant under test. There is no wall-clock budget for the
  semantic phase: the limits above bound its work instead.
- **Rate limit.** `POST /v1/agents/validate` is limited per token or IP to `OAX_RATE_LIMIT_VALIDATE_MAX`
  requests per minute (default 120, tighter than the global limit); it needs `agents:read` only, and a
  validation is CPU work.

### No privilege creation

Validation returns what the manifest states and creates nothing: no agent, no grant, no approval, no
connection. A tool or permission the manifest lists is not granted by being listed; when AWP manifests can
be stored and run (later slices), the existing grant, approval and connection rules apply to them like to
any `agents.md`. The `agents.md` wrapper never lets a section override front matter: a section next to
`instructions` or `promptRef` of the same agent is `wrapper.instructions-conflict`.

### Left out of this slice

Storing, publishing and running an AWP manifest (the legacy conversion of AWP-3b stores the
manifest next to a version but does not run from it); source positions
(line and column) in findings; the `awp-check` profile selection by the caller; `kind: Agent` and `kind:
Policy` documents are validated but have no exporter counterpart.

## Conformance harness (AWP-4)

AWP is a **draft** (`v1alpha1`). The harness measures what this build does with the vendored conformance
suite. It produces pass counts, not a statement: openagentix is **not conformant** to any AWP profile, there
is no badge and no claim anywhere, and the wording stays "built to the AWP schema, conformance in progress
(alpha)". A public statement is a separate, approved change (rule R1 of the AWP decision log) and needs a
public CI run.

```sh
pnpm awp:conformance                     # builds packages/core, runs everything, writes awp-report.json
node scripts/awp/conformance.mjs --baseline <file>   # extra baseline (CI passes the one of the base branch)
```

The harness is offline: its inputs are the vendored copy (`packages/awp/vendor/`, never edited), the
examples, `packages/awp/conformance/example-catalog.json` (the connections the example agents need) and
the built `packages/core`. It needs the repository's own `ajv` and `yaml`; nothing is installed or fetched.

| Group       | What runs                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------- |
| `validator` | every case of `conformance/index.json` through `validateManifestSource` (the suite's pass criterion: accept or reject, the indexed `code` at the indexed `path`, no error of another family; for a structural `schema.*` code the path decides and `codeMatch` records whether the code was the same) |
| `reference` | the vendored suite itself, `awp-check.mjs run`, unmodified, on a temporary copy of the vendored files (the specification examples are not vendored, so that directory is empty there) |
| `export`    | every `examples/**/*.agents.md` through the real exporter, a successful export through the vendored reference checker with `--verify-digest` and through the validator; no critical extension may be in it. A refusal is `skipped` (outcome `refused`, with the codes), not a pass |
| `golden`    | every `examples/awp/*.awp.json` equals the real export of its `agents.md` and passes the reference checker; an exported example under `examples/awp` without a golden file fails |

`awp-report.json` (not committed, uploaded by CI as artefact `awp-report`) lists the AWP commit and version
from `PROVENANCE.json`, the profiles of the suite and the profiles the validator supports, a summary per
group and every case. It has no timestamps or paths, so the same inputs give the same file locally and in
CI. The `validator` cases run with the profiles each case declares (default: all six profiles of the
suite), like the existing `awp-manifest-conformance` test. The validator supports `core`, `governance` and
`mcp` only; `atSupportedProfiles: "differs"` marks the cases whose verdict changes when only those three are
on, and the summary counts them. Those cases pass only because the harness switches on rules for profiles
the product does not support.

**Regression gate.** `packages/awp/conformance/baseline.json` lists the ids that pass on `main`. The run
exits 1 when one of them fails, is skipped or no longer exists (a pin upgrade or a removed example must
update the baseline in the same, reviewed change). On pull requests CI also passes the baseline of the base
branch, so a pull request cannot shrink the gate for itself. Cases that never passed are reported with the
pass rate and do not fail the run. When every `validator` and `export` case passes, the output says so; the
run never edits a file. Update the baseline deliberately with
`node scripts/awp/conformance.mjs --write-baseline` after adding a case; a unit test fails while the file
is stale.

**Real published agents.** `apps/api/test/agent-awp-conformance.test.ts` creates and publishes the AWP-native
examples through the API, fetches `GET /v1/agents/{id}/versions/{v}/awp`, and checks the body with the
reference checker (`--verify-digest`), with `POST /v1/agents/validate` and against the golden file.
It runs in the normal test job. The harness itself exports from the example catalog (a stand-in for the
reviewed tool lists of a publish), not from a database.

**Examples.** `manual-summarizer` (manual), `nightly-digest` (cron with time zone), `webhook-intake` (event),
`approved-publisher` (MCP tool grants, one with required approval) export without a critical extension.
Regenerate the goldens with `UPDATE_GOLDEN=1 pnpm vitest run packages/core/test/awp-export.test.ts` and
`pnpm format`.
