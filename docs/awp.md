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
| `owner_team_required`        | An AWP owner is a team (D15). The agent belongs to no team; assign one before exporting.              |
| `wildcard_expansion_missing` | A wildcard grant (`get_*`, `*`) has no recorded tool list (see below).                                |
| `profile_expansion_missing`  | A profile grant was never expanded (a file, not a published version).                                 |
| `tool_name_not_representable`| `<server>.<tool>` is not an AWP action identifier.                                                    |
| `duplicate_grant_conflict`   | One tool is granted twice with different limits.                                                      |
| `trigger_not_representable`  | A cron schedule that is not five-field (a seconds field).                                             |
| `label_not_representable`, `secret_not_representable`, `pipeline_not_representable` | Names or order that AWP cannot hold. |
| `unknown_field`              | A stored field the exporter does not know (for example from a newer build): never dropped silently.   |
| `not_canonicalizable`        | A value outside the JSON data model (for example a lone surrogate).                                   |

Warnings do not block: a cron trigger without `timezone` is exported as `UTC` (`agents.md` uses the process
time zone).

### Wildcards (D4)

AWP v1alpha1 has no prefix wildcards in permissions, and an export must not widen when a server later adds
a tool. Publish therefore enumerates every wildcard grant into `definition.wildcardExpansion` (key
`server/pattern`) from the reviewed tool list of the connection: the approved snapshot of a pinned
connection, else its declared tools. The export writes those tools explicitly; no `*` appears in any
permission key or tool list (a bare `*` is enumerated the same way). Without a recorded list the export is
refused. Versions published before this change have no record and are refused for wildcard grants
(republish to get one). The record is not part of `expansionDigest` (it is a function of inputs that
digest already covers), so existing digests and review records do not change.

### Digest and bytes

`metadata.integrity.digest` is `sha256:` over the RFC 8785 (JCS) form of the manifest without
`metadata.integrity`, `signature` and `provenance` (AWP spec 9.1), computed with the repository's own
`jcs` and cross-checked in tests against the vendored reference implementation. Extension values are part
of it. The digest does not depend on YAML formatting or key order of the source (property test).

The API sends the RFC 8785 bytes, so the body is exactly what the digest covers (plus `integrity`), and the
same stored version always yields the same bytes. The digest of the `agents.md` **source** stays an
OpenAgentix value (`agent_versions.digest`, header `x-oax-source-digest`); it is deliberately not written
into the manifest, because it changes with formatting and would break the property above. The owner team
is the stored `owner` slug when the agent belongs to a team, not the live team record, so renaming a team
does not change a published export.

### Verification

`packages/core/test/awp-export*.test.ts` validate every exportable example offline against the vendored
schema with the repository's `ajv`, run the vendored semantic rules with digest verification and compare
the digest with the vendored reference implementation. Golden manifests are in `examples/awp/*.awp.json`
(regenerate with `UPDATE_GOLDEN=1`, then `pnpm format`). Nothing is fetched at build or run time.
