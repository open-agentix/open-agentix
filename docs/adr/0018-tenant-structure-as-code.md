# ADR 0018: Tenant structure as code: a repository that owns a subtree of the tenant tree

- Status: **Proposed**. This ADR records a **design direction**, not an accepted design. It came
  out of the owner's answer to ADR 0017 follow-up question 5 (2026-10-10). No option below is
  chosen, no detail is accepted, and **nothing of it is built or scheduled**; every slice is
  planned at most.
- Date: 2026-10-10
- Plan item: design issue #296 (milestone v0.4, `security-review`); no implementation issues yet
- Related: [ADR 0010](0010-agent-authoring-builder-and-git-sync.md) (Git-synced agent repositories,
  Amendment 1: any Git host over plain Git; A1.9: one repository serves exactly one tenant),
  [ADR 0012](0012-connections-instances-scopes-and-data-protection.md) (connections, secret
  references), [ADR 0013](0013-hierarchical-tenants-and-setup-modes.md) (tenant tree,
  narrowing-only settings, moves, deletion), [ADR 0014](0014-tenant-tree-role-inheritance.md)
  (role bindings, binding sources, grant rules), [ADR 0017](0017-agent-lifecycle-governance.md)
  (reviews, agent rules, directory mappings, Git integrations, review via Git, scoped secrets)
- External references (read as reference data only): configuration-as-code features of code
  hosting platforms (groups, projects and members declared in a repository), Terraform/OpenTofu
  providers for Git hosts, Kubernetes-style declarative manifests and GitOps reconcilers
  (desired state, drift, prune), the manifest style of the Agentic Workflow Protocol (AWP).

## Context

### Problem

A company that uses the tenant tree of ADR 0013 for departments, use cases and teams builds and
changes that tree by hand today: nodes, settings, role bindings, and in the planned design of
ADR 0017 also directory mappings, agent rules, Git integrations, secrets and the agents
themselves. In a larger organisation this leads to the usual problems of manual administration:
no review of structural changes, no history beyond the audit chain, no easy way to reproduce a
department in a second installation, and drift between what was intended and what is configured.
Many such companies already keep their infrastructure and access configuration as code in Git.

ADR 0017 asked (follow-up question 5) whether descendants may select an ancestor's Git
integration. The owner did not answer that question in its own terms but proposed a broader idea.

### The owner's idea (neutral restatement)

A repository may **carry a tenant structure**. When it does, the tenant at which that structure is
rooted and all of its sub-tenants are **built from the repository**, as infrastructure as code: the
tenant tree, role bindings and group mappings, agents, Git integrations and secret references are
declared in files of the repository and **reconciled** into the platform. The model the owner has
in mind is the configuration-as-code style of code hosting platforms, where groups, projects and
their settings are kept in a repository.

### What exists and what does not (2026-10-10)

- The tenant tree (ADR 0013) and the role-binding API with grant rules (ADR 0014 S4) exist on
  `main`. Binding sources are `mirror` and `grant`.
- Git-synced agent repositories (ADR 0010, W9-2) are designed, **not built**.
- Reviews, agent rules, directory mappings, Git integrations, review via Git and scoped secrets
  (ADR 0017) are accepted designs, **not built**.
- Nothing of this ADR exists: no manifest format, no reconciler, no subtree ownership.

## Decision (direction only)

The platform **may** support tenant structure as code under these fixed boundaries, which follow
from accepted ADRs and are not negotiable in the later detailed design:

1. **Git is a transport, not an authority** (ADR 0017 principle 8). A change in the repository is
   applied only within the permissions of a platform principal that holds them, and only after the
   platform has approved its exact content where approval is required.
2. **Never up, never sideways** (ADR 0013, ADR 0014). A repository can only shape the subtree it
   owns; it can never change an ancestor, a sibling or another organisation, and never widen a
   setting beyond what the ancestors allow.
3. **No grant above the grantor** (ADR 0014 section 7). A repository cannot create a binding that
   the principal on whose authority it acts could not create through the API.
4. **Agents are published only through ADR 0017 reviews.** Declaring an agent in the repository
   creates draft revisions, never a published version on its own.
5. **Secrets only by reference.** A manifest never contains a secret value; it names references
   (scoped secret names, Vault paths, AWS ARNs) whose values are created out of band.
6. **Plain Git only** (ADR 0010 Amendment 1): any Git host, HTTPS with a token or SSH with a deploy
   key, the hardened Git engine; no host-specific API in the core.

Everything else is open and listed as options below.

## Options

### 1. Manifest format

- **A. Own declarative manifests** with a versioned schema per object kind (for example `Tenant`,
  `Settings`, `RoleBinding`, `DirectoryMapping`, `AgentRule`, `GitIntegration`, `SecretReference`,
  `AgentSource`), YAML or JSON, validated by a JSON Schema published with the API.
- **B. Same envelope as AWP-style manifests** (version, kind, metadata, spec), so one validator and
  one editor experience cover workflow and structure manifests. This depends on how stable the AWP
  manifest envelope is and must not couple the platform's release cycle to the protocol's.
- **C. No native format**: a Terraform/OpenTofu provider against the public API. The platform stays
  imperative; the desired state lives in the provider's state. Simple for the platform, but drift
  protection and the "owned by a repository" guarantee cannot be enforced by the platform.

In A and B, agents stay `agents.md` files (ADR 0008, ADR 0010); a structure manifest references
them by path and never embeds them.

### 2. Apply model

- **A. Reconcile loop**: the platform watches the branch and continuously converges the subtree to
  the declared state (create, update, and with an explicit prune setting delete); drift is
  corrected.
- **B. One-shot apply**: a plan is computed from a commit, shown as a diff, approved and applied
  once; later drift is only reported.
- **C. Plan, approve, apply, then watch**: every change is a plan with a digest that must be
  approved like an agent review (ADR 0017 section 4, approvals bound to the plan digest); after
  apply, drift is detected and reported or reverted per setting.

### 3. Who may change the tree from a repository

- **Claim**: an admin of the parent node (or the organisation admin for a root) creates a
  **subtree claim** that binds a repository path and a publish branch to one node, the subtree
  root. The claim's creator is the principal whose permissions bound everything the repository can
  do. Open: whether the bound is the creator's permissions at claim time, at apply time, or a fixed
  permission set stored in the claim.
- **Approval of structural changes**: options are (a) the plan of every change needs ADR 0017-style
  approval by eligible non-contributors, (b) only changes that grant or widen need approval while
  narrowing changes apply directly (ADR 0017 principle 4), (c) branch protection on the host is
  trusted (rejected for privilege changes by ADR 0017 section 12.3 unless verified).
- **Contributors** are proven as in ADR 0017 section 12.2: signatures by keys linked to platform
  users; nobody approves a plan that grants them something.

### 4. Interaction with ADR 0013 (tenant tree)

- Declared nodes are created below the subtree root only; moves out of the subtree, moves into
  another organisation and renames of the root are not possible from the repository.
- Declared settings are narrowing-only against the ancestors (`422 not_narrowing` becomes a plan
  error).
- Deleting a declared node follows ADR 0013 section 10 (leaves only, agents archived, data key
  destroyed). Open: whether pruning is allowed at all from a repository, or only marks nodes for an
  admin to delete.
- Budget caps of declared nodes count against the ancestors' shared counters as today.

### 5. Interaction with ADR 0014 (role bindings)

- **A. Reuse `source = grant`** with `granted_by` set to the claim's creator: no schema change, but
  the reconciler cannot tell its own rows from manual grants, and manual grants could be overwritten
  or left behind.
- **B. New binding source `iac`** (next to `mirror`, `grant` and the planned `directory`), part of
  the key, with a reference to the claim: rows owned by the repository never collide with manual
  grants, the reconciler only touches its own rows, and the console can show "managed by
  repository". Directory mappings declared in the repository would be mapping rows owned by the
  claim, still producing `directory` bindings.
- ADR 0014 grant rules 1 to 9 apply per declared binding in either option; self-grant (rule 6)
  would be checked against the contributors of the change.

### 6. Reinterpretation of ADR 0010 A1.9 ("one repository serves exactly one tenant")

A1.9 prevents two tenants from consuming the same repository. Tenant structure as code needs an
explicit reinterpretation, to be decided with this ADR:

- **One repository owns exactly one subtree root.** The installation-wide claim on the canonical
  `url_key` (ADR 0010) points to that root; all agent bindings and Git integrations declared by the
  repository belong to nodes inside the subtree; no node outside the subtree can bind the same
  repository.
- **Objects owned by the claim are protected against manual edits**: console and API refuse changes
  to them (for example `409 managed_by_repository`), as ADR 0010 section 8 does for Git-managed
  agents ("Git wins").
- **Drift** (a manual change through a path that bypasses the protection, or a failed apply) is
  shown on the subtree root, audited and either reverted by the reconciler or reported, depending on
  the apply model.
- Open: whether a descendant inside an owned subtree may still have its own, separately claimed
  repository for a deeper subtree (nested claims), and how releasing a claim works (an audited admin
  action on the parent that turns owned objects into normal ones).

### 7. Interaction with ADR 0017

- Agents declared in the repository become draft revisions and go through reviews, agent rules and
  the lifecycle policy unchanged; a reconcile never publishes.
- Agent rules and the lifecycle policy declared in the repository follow ADR 0017: adding and
  tightening is allowed within the claim's authority; loosening or deleting a rule needs admin
  authority (F8), which in a repository means the plan must be approved by an admin of the node.
- Git integrations declared in the repository are node-local objects of nodes inside the subtree;
  their credentials are secret references.

## Security consequences

- **Push is privilege.** Whoever can get content onto the publish branch can, within the claim,
  create nodes and role bindings. Without further controls this is a privilege-escalation path.
  Prerequisites under every option: branch protection (no force push, required review) on the host,
  **signed commits by keys linked to platform users** (no unsigned relaxation for structure, unlike
  ADR 0017 F7, because structure is not a non-production use case), the claim's authority as the
  upper bound, and no self-grant through one's own commits.
- **Blast radius**: a compromised repository or credential controls the owned subtree, never more.
  Organisations should claim narrow subtrees, not their root, until the design has matured.
- **Secrets only by reference**: inline values are refused at validation (the existing inline-secret
  checks extended to manifests); the repository can at most point a node at a secret name or an
  external path inside the owning node's prefix (ADR 0017 section 13.7).
- **Destructive changes**: prune and node deletion need explicit opt-in and approval; a parse error
  or a schema error fails closed (no partial apply of a plan).
- **Hostile repository content**: the hardened Git engine and limits of ADR 0010 A1.3/A1.5 apply,
  plus size and object-count limits per manifest.
- **Audit**: every applied change names the claim, the commit, the plan digest and the approvers;
  manual edits refused because of ownership are audited too.
- **Lockout**: a broken repository must not lock an organisation out of its subtree. Releasing the
  claim by an admin of the parent node is a reachability-reducing, audited action, not a bypass of
  agent publishing (ADR 0017 has no break-glass for publishing, and this ADR adds none).

## Open questions

1. Manifest format: own (A), AWP-style envelope (B), or only a Terraform/OpenTofu provider (C)?
2. Apply model: reconcile loop, one-shot apply, or plan/approve/apply with drift reporting?
3. Which changes need approval: all, or only granting and widening ones?
4. Binding source for repository-owned bindings: reuse `grant` or a new source `iac`?
5. Authority bound of a claim: creator's permissions at claim time, at apply time, or a fixed set?
6. Is pruning (deleting nodes and bindings that disappeared from the repository) allowed?
7. Nested claims inside an owned subtree: allowed or not?
8. How is a claim released, and what happens to owned objects (kept as manual objects, or frozen)?
9. Should the repository also be able to own installation-level objects for single-tenant setups,
   or only subtrees?
10. Relation to tenant-scoped identity providers and SCIM (#43): may a repository declare directory
    mappings for an identity provider that is configured outside the repository?

## Slices (proposal, not accepted, nothing scheduled)

| # | Slice | State | Depends on |
| --- | --- | --- | --- |
| D0 | Decide the options above; this ADR to Accepted or Rejected | open | owner |
| T1 | Manifest schema and validator, read-only `plan` (diff against the platform, no apply) | not planned yet | D0 |
| T2 | Subtree claims, ownership protection of owned objects, drift report | not planned yet | T1, ADR 0010 W9-2-1 (#90) |
| T3 | Apply of nodes and settings (narrowing-only) | not planned yet | T2 |
| T4 | Apply of role bindings and directory mappings | not planned yet | T3, ADR 0017 S10 (#290), S11 (#291) |
| T5 | Apply of Git integrations and secret references | not planned yet | T3, ADR 0017 S4 (#247), S12 (#292) |
| T6 | Agents from the repository as draft revisions (publish only through ADR 0017 reviews) | not planned yet | T3, ADR 0017 S3 (#246) |
| T7 | Console: "managed by repository" markers, plan view, drift view | not planned yet | T2 |

## Consequences

- Positive (if adopted): reviewable, reproducible structure for large organisations; a natural
  home for the question "may sub-tenants share a Git integration" (they are declared by one owning
  repository instead of shared across nodes).
- Negative: a second write path for tenant structure and bindings, with a new privilege-escalation
  surface that needs signed commits, approvals and a careful authority model; more concepts for
  operators (claims, ownership, drift).
- Neutral: until this ADR is decided, ADR 0017 integrations stay node-local and ADR 0010 A1.9 keeps
  its current meaning.

## Alternatives considered

- **Descendants select an ancestor's Git integration** (ADR 0017 follow-up question 5 as asked):
  not chosen by the owner; replaced by this direction.
- **No structure as code**: keep console and API only, and let customers script the API. Remains
  the fallback if the security cost of a second write path is judged too high.
