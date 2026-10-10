# Architecture Decision Records

Significant decisions are recorded here (see [GOVERNANCE.md](../../GOVERNANCE.md)). Accepted ADRs
are immutable; a later ADR may supersede one.

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-tech-stack.md) | Tech stack | Accepted |
| [0002](0002-audit-hash-chain.md) | Revision-safe audit trail (hash chain + signed checkpoints) | Accepted |
| [0003](0003-policy-engine-audit-and-control-agents.md) | Policy engine, audit agent and control agent | Accepted |
| [0004](0004-provider-abstraction.md) | Provider abstraction incl. Bedrock VPC endpoints and proxies | Accepted |
| [0005](0005-runners-and-external-harnesses.md) | Runners and external harnesses | Accepted |
| [0006](0006-control-node-and-worker-nodes.md) | Control node and worker nodes | Accepted |
| [0007](0007-tenants-as-isolation-boundary.md) | Tenants as the isolation boundary | Accepted |
| [0008](0008-agents-md-data-flow-and-isolation-contract.md) | agents.md data flow and isolation contract (handovers, `when`, tool profiles, per-step credentials, run node) | Accepted |
| [0009](0009-model-proxy.md) | Model proxy on the control node (run node model access, measured cost, budget reservations, harnesses through the proxy) | Proposed |
| [0010](0010-agent-authoring-builder-and-git-sync.md) | Authoring agents: no-code form builder, code view and Git-synced agent repositories | Proposed |
| [0011](0011-outbound-network-proxies-and-private-endpoints.md) | Outbound network: central proxy configuration and private model endpoints | Proposed |
| [0012](0012-connections-instances-scopes-and-data-protection.md) | Connections: MCP servers and model providers as separate areas, multiple instances per tenant, central vs tenant scope, data protection | Proposed |
| [0013](0013-hierarchical-tenants-and-setup-modes.md) | Hierarchical tenants (inherited, narrowing-only settings, shared budget caps across the tree) and setup modes (single-tenant, multi-tenant) | Accepted |
| [0014](0014-tenant-tree-role-inheritance.md) | Role inheritance over the tenant tree (opt-in per binding, resolution, caching, grant rules, `pentest`, threat model, slices) | Proposed |
| [0015](0015-opentelemetry-genai-tracing.md) | Observability with OpenTelemetry GenAI semantic conventions (span model, metadata-only default, node threat model, exporters and air gap, sampling, metrics, audit links, slices) | Proposed |
| [0016](0016-mcp-egress-and-authorization.md) | MCP egress and authorization (per-connection egress, contained stdio servers, setup/run phases, pinned tool definitions, control-node MCP relay, OAuth 2.1 per the MCP authorization specification, threat model, slices) | Proposed |
| [0017](0017-agent-lifecycle-governance.md) | Agent lifecycle governance (development vs published, four-eyes publish approval with review comments bound to the content digest, agent rules, Agent Developer and Agent Maintainer roles with directory group mapping, review via Git, no break-glass, tenant lifecycle policy, scoped, inherited and encrypted secrets, Vault and AWS Secrets Manager backends, threat model, slices; not implemented) | Accepted |
| [0018](0018-tenant-structure-as-code.md) | Tenant structure as code (a repository owns a subtree of the tenant tree: tenant tree, role bindings, agents, Git integrations and secret references declared in Git and reconciled; design direction, options and security consequences; not accepted in detail, not implemented) | Proposed |

Template: Context, Decision, Consequences (positive/negative), Alternatives considered.
