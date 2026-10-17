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
checks.

`PINNED_AWP_FEATURES.requiredExtensions` in `packages/core/src/awp/types.ts` is `false`. A test fails when
the vendored schema disagrees, so a pin upgrade that adds AEP-0011 forces a deliberate switch. When it is
`true`, the same code writes the extensions and lists their names, sorted, in `metadata.requiredExtensions`
instead of refusing (tested with an override; it cannot be validated against the current schema).

### Other refusals

All refusals fail closed and name the source path.

| Code                         | Meaning                                                                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `owner_team_mismatch`        | `owner` is not the team the agent belongs to (an author can write any slug; checked at export). |
| `egress_not_representable`   | An egress entry that is not a plain host name (port, CIDR range, `*.suffix`).                        |
| `owner_team_required`        | An AWP owner is a team (D15). The agent belongs to no team; assign one before exporting.              |
| `wildcard_expansion_missing` | A wildcard grant (`get_*`, `*`) has no recorded tool list (see below).                                |
| `profile_expansion_missing`  | A profile grant was never expanded (a file, not a published version).                                 |
| `tool_name_not_representable`| `<server>.<tool>` is not an AWP action identifier.                                                    |
| `duplicate_grant_conflict`   | One tool is granted twice with different limits.                                                      |
| `trigger_not_representable`  | A cron schedule that is not five-field (a seconds field).                                             |
| `label_not_representable`, `secret_not_representable`, `pipeline_not_representable` | Names or order that AWP cannot hold. |
| `unknown_field`              | A stored field the exporter does not know (for example from a newer build): never dropped silently.   |
| `not_canonicalizable`        | A value outside the JSON data model (for example a lone surrogate).                                   |

A cron trigger without an explicit `timezone` is refused too (`agents.md` uses the process time zone,
AWP defaults to UTC, so exporting would silently change when it fires).

### Wildcards (D4)

AWP v1alpha1 has no prefix wildcards in permissions. Publish enumerates every wildcard grant into
`definition.wildcardExpansion` (key `server/pattern`), **only from the approved tool snapshot of a pinned
connection**: at run time the pin check (`toolsDigest`) blocks a tool added later, so the explicit list
is not narrower than what runs. For an unpinned connection nothing bounds a prefix grant (a tool added
later would match), so no list is recorded and the export is refused. At export the recorded list is
filtered again by the pattern, so a damaged record can only shrink the grant; an empty result is refused.
The export writes the tools explicitly; no `*` appears in any permission key or tool list (a bare `*`
is enumerated the same way). Versions published before this change have no record and are refused for
wildcard grants (republish). The record is not part of `expansionDigest` (a function of inputs that
digest already covers), so existing digests and review records do not change.

Overlapping grants of one tool (an exact grant and a wildcard, or a duplicate) are merged only if they
are identical in limits and approval; otherwise `duplicate_grant_conflict`, because at run time the exact
grant wins and a union would claim a control that does not exist.

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
the legacy format and goes to the legacy parser unchanged (its conversion is AWP-3b). The legacy parser
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
`yaml.cycle`, `yaml.unsafe-integer`, `yaml.non-json-value`, `digest.not-canonicalizable` are OpenAgentix's own.

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

Storing, publishing and running an AWP manifest; conversion of the legacy format (AWP-3b); source positions
(line and column) in findings; the `awp-check` profile selection by the caller; `kind: Agent` and `kind:
Policy` documents are validated but have no exporter counterpart.
