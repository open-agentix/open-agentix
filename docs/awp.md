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
