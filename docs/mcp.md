# MCP connections and tool profiles

An MCP server is added as a **connection** of kind `mcp` (Connections page or `POST /v1/connections`).
Secrets are referenced by name (`envSecrets`, `headerSecrets`), never stored. This page covers the
tool classification and the named **profiles** of
[ADR 0008](adr/0008-agents-md-data-flow-and-isolation-contract.md), section 1.3.

## Declare tool classes and profiles

```json
{
  "transport": "streamable-http",
  "url": "https://mcp.example.internal/jira",
  "headerSecrets": { "authorization": "jira-token" },
  "tools": {
    "get_issue": { "access": "read" },
    "search_issues": { "access": "read" },
    "create_issue": { "access": "write" }
  },
  "profiles": {
    "read": ["get_issue", "search_issues"],
    "write": ["create_issue"],
    "triage": ["get_issue", "create_issue"]
  }
}
```

Rules, checked when the connection is created or updated (HTTP 400 otherwise):

- `tools` declares the access class of each tool (`read` or `write`). **A tool that is not declared
  counts as `write`.** Tool names are literal: no wildcards, at most 500 tools.
- Every member of a profile must be a declared tool, without duplicates. Unknown tools are refused.
- Profile names are lowercase slugs. `read` and `write` are conventions; any name (`triage`) is
  allowed. A profile named `read` may only contain `read` tools, so a misleading name cannot smuggle
  in a write tool.
- MCP tool annotations are hints from the server and are never trusted to widen access: the declared
  class wins; without a declaration only a clear `readOnlyHint: true` (and no `destructiveHint`)
  counts as `read`. The gateway reports the derived class as `access` on each exposed tool.

## Grant a profile in agents.md

```yaml
agents:
  - id: research
    access: read-only
    tools:
      - { server: jira, profile: read }
  - id: action
    access: write
    tools:
      - { server: jira, profile: write, approval: required, maxCallsPerRun: 3 }
```

A profile grant takes `approval`, `maxCallsPerRun` and `classification`; argument constraints belong
on concrete grants (`tool:`). A concrete grant for the same `server/tool` wins over the expansion, so
a tool can be narrowed with constraints. Overlapping profile grants merge to the stricter values
(`approval: required` wins, the lower `maxCallsPerRun`).

## What happens at publish

1. The control node resolves the connections that apply to the agent (most specific scope wins per
   name) and expands every profile grant into one concrete grant per tool
   (`allowAdditionalArgs: true`, no argument constraints).
2. The expanded grants, an `expansion` record per profile grant (`{ agentId, server, profile, tools,
   connectionVersion }`), the classification of the used servers' tools (`toolAccess`) and an
   `expansionDigest` (SHA-256 over all of it) are stored in the immutable version's `definition`.
   The source digest stays the digest of the `agents.md` text. Editing a profile later never changes a
   published version; publish a new version to pick the change up.
3. Publish is refused with `validation_failed` (and an `agent.publish.denied` audit entry) when a
   connection or profile name is unknown, or when a step with `access: read-only` would receive a tool
   that is not classified `read`: through a profile, a direct grant, a wildcard (`jira/*`) or an
   undeclared tool. A successful expansion is audited as `agent.profiles.expanded`.
4. `POST /v1/agents/validate`, the dry run and `POST /v1/policies/evaluate` apply the same expansion,
   so authors see the errors before publishing.

`GET /v1/agents/{id}/versions/{version}` returns `expansion` and `expansionDigest`. The agent overview
shows which profile each grant came from.

## Run-time enforcement

For an agent with `access: read-only` the policy gate additionally requires the called tool to be
classified `read` in the version's `toolAccess` and denies everything else with the reason code
`profile_write_denied` (recorded in the `policy.decision` audit entry). This is a second wall: it
holds even if a write grant reached the stored version some other way. Without a classification
(for example a local run of an unpublished file) a read-only step cannot call tools: it fails closed.

## Limits

- Classification is declared by the integrator; the platform cannot verify that a tool declared
  `read` really has no side effects. Review profiles like any other grant.
- Argument constraints are not part of a profile; use concrete grants for narrowing.
