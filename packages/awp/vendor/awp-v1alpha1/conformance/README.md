# AWP conformance material (v1alpha1)

This directory contains the first machine-readable conformance material for
[AWP v1alpha1](../spec/v1alpha1/README.md): manifests that a validator must accept or reject, an
index describing the expected result, and a small reference checker. It tests **validators**
(spec 11.1) and manifest rules. It is not a runtime test suite (spec 11.3 still describes
conformance statements as self-declarations).

| Path | Content |
| ---- | ------- |
| `valid/` | Manifests that MUST be accepted. File names start with the specification section. |
| `invalid/` | Manifests that MUST be rejected. Each file violates exactly one rule and is named after the section and the rule. |
| `index.json` | Machine-readable test index: id, file, section, rule, expected result, expected diagnostic `code` and `path`, validator options. |
| `awp-check.mjs` | Reference checker (Node.js >= 20): YAML restrictions, JSON Schema, semantic rules; runs the suite. |
| `semantic.mjs` | The semantic rules ([catalogue](../schema/README.md#semantic-validation-rules)). |

## Run

```sh
npm ci            # installs the two pinned development dependencies, no install scripts
npm test          # node conformance/awp-check.mjs run
```

`npm test` validates every case of `index.json`, checks that every file in `valid/` and `invalid/`
is indexed, and validates the manifest examples of the specification
(`spec/v1alpha1/examples/`). It prints `PASS`/`FAIL` per case and exits with `1` if anything fails.
`node conformance/awp-check.mjs run --json` prints the same result as JSON.

Check single files:

```sh
node conformance/awp-check.mjs check [--profiles core,mcp] [--verify-digest] [--json] manifest.yaml
```

## Index format

`index.json` has `suite`, `version`, `awp`, `defaults`, `nonManifestExamples` (example files that
are event streams or records, not manifests) and `tests`. A test has:

| Field | Meaning |
| ----- | ------- |
| `id`, `file` | Identifier and path relative to `conformance/`. |
| `section`, `rule` | Specification section and the rule under test. |
| `expect` | `valid` or `invalid`. |
| `code` | For `invalid`: the diagnostic code a validator must report (`schema.<keyword>`, `yaml.*` or a [semantic code](../schema/README.md#semantic-validation-rules)). |
| `path` | For `invalid`: JSON Pointer of the offending node; descendants also match. |
| `profiles` | Profiles the validator supports for this case. Default: all six profiles. |
| `verifyDigest` | `true` if the validator must verify `metadata.integrity.digest` (spec 9.1). |

Other implementations can use the index with their own validator: a case passes if the manifest is
accepted (`valid`) or rejected (`invalid`). Matching `code` and `path` is how this checker proves
that the manifest is rejected for the intended reason. `schema.*` codes name the JSON Schema keyword
of the reference schema; a validator with a different structure may report different codes for
structural errors and should be compared on accept/reject plus the `path`.

## Dependencies

Development only, no network access at execution time:

| Package | Version | Use |
| ------- | ------- | --- |
| `ajv` | 8.20.0 | JSON Schema draft 2020-12 validation |
| `yaml` | 2.9.1 | YAML 1.2 parsing with positions |

Versions are pinned exactly in `package.json`, the full tree is locked in `package-lock.json`, and
`.npmrc` sets `ignore-scripts=true`. Neither package has install scripts. Update them in a
dedicated `build(deps)` change.

## Notes

- The digests in the specification examples are placeholders and are not verified. The cases
  `valid/9.1-digest-verified` and `invalid/9.1-digest-mismatch` exercise verification.
- The checker implements RFC 8785 canonicalization for the JSON subset that manifests use
  (strings, finite numbers, booleans, null, arrays, objects).
- A license note: manifests and code here are Apache-2.0, as stated in the root README.
