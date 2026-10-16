# AWP JSON Schema (v1alpha1)

[`awp.v1alpha1.json`](awp.v1alpha1.json) is a JSON Schema (draft 2020-12) for AWP manifests of the
API version `awp.agenticworkflowprotocol.org/v1alpha1`. It expresses the **structural** rules of the
[specification](../spec/v1alpha1/README.md). Rules that JSON Schema cannot express are listed below
as **semantic validation rules**; a validator that claims to accept exactly the manifests the
specification allows (spec section 11.1) must implement both layers.

**The schema is normative for document structure**: field names, types, required fields, closed
objects, enumerations and patterns (decided 2026-10-10, [decision log D2](../docs/alignment/decisions.md#d2-json-schema-is-normative-for-structure)).
Whether a manifest is written as YAML or JSON does not matter; YAML is parsed into the JSON data
model first. The specification text is normative for semantics and runtime behaviour, and the
semantic rules below are normative where they cite a section of it. A discrepancy between schema
and text is a defect that is fixed by an erratum in whichever artefact is wrong; until it is fixed,
validators follow the schema for structure. Implementations derive their types and validators
from the schema, not the other way round.

## Use

| Entry point | Validates |
| ----------- | --------- |
| `schema/awp.v1alpha1.json` | Any manifest; selects the kind-specific rules from `kind`. |
| `schema/awp.v1alpha1.json#/$defs/Workflow` | A manifest of kind `Workflow`. |
| `schema/awp.v1alpha1.json#/$defs/Agent` | A manifest of kind `Agent`. |
| `schema/awp.v1alpha1.json#/$defs/Policy` | A manifest of kind `Policy`. |

YAML manifests are parsed first (YAML 1.2 core schema; custom tags and non-string keys rejected,
spec 3.1) and the resulting JSON value is validated. Every document of a multi-document file is
validated on its own. The reference checker in [`conformance/`](../conformance/README.md) shows the
complete pipeline: YAML restrictions, then this schema, then the semantic rules.

## Design decisions

- **Closed objects.** Every object with defined fields has `additionalProperties: false`, with one
  exception: properties matching `^x-` are allowed and unconstrained (spec 3.3). Maps whose keys
  are data (`labels`, `annotations`, `actionGroups`, `permissions.tools`, `environments`, `env`,
  trigger `filter`) are not field sets: all of their keys are data, and `x-` has no special
  meaning there.
- **Fail closed on profiles is not structural.** Whether a field belongs to a profile the validator
  supports (spec 3.3, item 3) depends on the validator; the schema accepts all fields of all
  profiles. See semantic rule `profile.unsupported`.
- **Agent entries** are discriminated by their fields: `ref` selects the agent reference form,
  `protocol` the remote agent form, otherwise the inline form. Mixed forms (for example `ref` plus
  `model`) are rejected by the closed objects of the selected form.
- **Step types** are checked with `if`/`then`: a step has exactly the fields of its type (spec
  5.6.1). `type` defaults to `agent`.
- **Expressions.** Expression-enabled fields (`task`, `env` values, `permissions.tools.*.resources`
  entries, `approval.message`) use the `Expression` pattern: any `${{ ... }}` must contain exactly
  one of `inputs.<name>`, `steps.<id>.outputs.<name>`, `execution.id`, `execution.environment`
  (spec 3.9). Output names are otherwise unconstrained by the specification; inside expressions
  they must not contain whitespace, `.`, `{`, `}` or `$`. Fields that are not expression-enabled
  (notably `command`) are not scanned.
- **Digests** (spec 3.8): `sha256`, `sha384` and `sha512` have their fixed hex length; other
  algorithms are accepted syntactically (`<algorithm>:<lowercase hex>`) and reported as the warning
  `digest.algorithm-unknown`.
- **`maxRetries`** is validated as a positive integer because spec 5.7 requires all limits to be
  positive; `retries` on a step may be `0`.
- **Dates** use the `full-date` shape; calendar validity (for example `2027-02-30`) is a semantic
  rule. No JSON Schema `format` keyword is used, so validators need no format plugins.
- Event envelopes, reproducibility records and conformance statements (spec 10 and 11.3) are not
  manifests and are not covered by this schema.

## Semantic validation rules

These rules apply to documents that are structurally valid. They are implemented by the reference
checker (`conformance/semantic.mjs`) and exercised by the conformance suite. Codes are stable
identifiers for diagnostics ([docs/cli.md](../docs/cli.md#3-diagnostics)).

### Errors

| Code | Spec | Rule |
| ---- | ---- | ---- |
| `yaml.parse-error`, `yaml.custom-tag`, `yaml.non-string-key` | 3.1 | The document is well-formed YAML 1.2 without features that have no JSON equivalent (custom tags, non-string keys). |
| `id.duplicate` | 3.4, 5.6.3, 8.2 | Agent ids, step ids and rule ids are unique within their list. |
| `name.duplicate` | 5.5.1 | MCP server names are unique (they are the reference key of tool sources). |
| `dependsOn.unknown-step` | 5.6.3 | Every `dependsOn` entry names an existing step. |
| `step.unknown-agent` | 5.6.3 | The `agent` of an agent step names an existing entry of `spec.agents`. |
| `dependsOn.cycle` | 5.6.3 | The steps form a directed acyclic graph (a self-dependency is a cycle). |
| `expr.unknown-step` | 3.9 | `steps.<id>` names an existing step. |
| `expr.not-a-dependency` | 3.9, 5.6.3 | `steps.<id>` is used only in a step that depends on `<id>` directly or transitively. |
| `expr.undeclared-output` | 5.6.3 | Only outputs declared in the `outputs` of that step are referenced. |
| `expr.step-reference-outside-step` | 3.9 | `steps.<id>` appears only inside a step (not in workflow-level `permissions` or `approval`). Conservative reading: outside a step there is no dependency that could justify the reference. |
| `retries.exceeds-budget` | 5.6.1 | A step's `retries` does not exceed `budget.resources.maxRetries` (workflow or step level, minimum). |
| `actionGroup.nested` | 5.5.4 | A group does not contain another group. |
| `secretRef.undeclared` | 7.9 | A `secretRef` names a secret declared in `spec.secrets` of the same manifest. |
| `secretRef.scope` | 7.9 | The `scope` of that secret contains the consumer (MCP server name or agent id). The default scope is empty. |
| `secret.literal-field` | 7.9 | No field named `token`, `password`, `apiKey`, `secret` or `privateKey` with a literal value outside `x-` extensions, including inside free-form values. |
| `input.pattern-invalid` | 5.3 | An input `pattern` is a valid ECMA-262 regular expression. |
| `date.invalid` | 3.7 | Dates exist in the calendar. |
| `digest.mismatch`, `digest.unsupported-algorithm` | 9.1 | With digest verification enabled, `metadata.integrity.digest` equals the digest over the RFC 8785 serialization of the manifest without `metadata.integrity`, `metadata.signature` and `metadata.provenance`. |
| `profile.unsupported` | 3.3 | A field of a profile the validator does not support is rejected, naming field and profile (table in spec 3.3, plus `kind: Policy` for the governance profile). |
| `governance.classification-required` | 7.1 | Under the governance profile `Workflow` and `Agent` have `metadata.classification` (`owner.team` is structurally required). |
| `security.image-not-pinned` | 9.4 | Under the security profile `mcpServers[].image` and command step `image` are pinned by digest. |

### Warnings

| Code | Spec | Finding |
| ---- | ---- | ------- |
| `mcp.server-unresolved` | 5.5.1 | A tool source names an MCP server that is not declared; it must be resolvable by runtime binding. |
| `expr.undeclared-input` | 3.9 | An expression references an input that is not declared. |
| `permissions.secret-undeclared` | 7.5.1 | `permissions.secrets` names a secret that is not declared. |
| `digest.algorithm-unknown` | 3.8 | A digest uses an algorithm other than sha256, sha384, sha512. |
| `lint.command-expression` | 5.6.2 | `command` contains `${{ }}`; commands are not expression-enabled and the text is passed literally. |
| `lint.environment-not-listed` | 7.10 | `spec.environment.name` is not a key of `spec.environments`. |
| `lint.permissions-absent` | 7.5.3 | Security profile only: no `permissions` object, so every action of exposed tools is allowed by permissions. |

### Rules that need a runtime or other documents

The following requirements cannot be decided from one manifest and are therefore not checked
statically. Conformance for them is demonstrated by runtime tests, not by this suite.

- Input values are validated before execution; data classes of inputs against `dataPolicy`
  (spec 5.3, 7.2).
- Resolution of `ref` (agents), `include` (policies) and `promptRef` and verification of their
  digests; secrets declared by a referenced `Agent` must also be declared by the workflow (spec
  5.4.2, 6, 8.1, 9.1).
- Existence of non-declared MCP servers via runtime binding (spec 5.5.1).
- Model policy against models, residency and provider checks, environment of an execution, budget
  enforcement, permissions, approvals, separation of duties and the decision algorithm (spec 5.7,
  7.x, 8.4).
- `audit.enabled: false` handling under the audit profile, `integrity.mode` and
  `retention.duration` capabilities (spec 10.2).
- Immutability of published versions (spec 3.5).
