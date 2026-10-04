# ADR 0012: Connections: MCP servers and model providers as separate areas, multiple instances per tenant, central vs tenant scope, data protection

- Status: Proposed
- Date: 2026-10-04
- Plan items: W12-1, W12-2 ([implementation plan](../IMPLEMENTATION-PLAN.md), wave 12)
- Builds on: [ADR 0004](0004-provider-abstraction.md),
  [ADR 0007](0007-tenants-as-isolation-boundary.md),
  [ADR 0008](0008-agents-md-data-flow-and-isolation-contract.md) (tool profiles, credential broker),
  [ADR 0009](0009-model-proxy.md) (model proxy, reservations, capture levels)
- Related: [ADR 0010](0010-agent-authoring-builder-and-git-sync.md) (builder pickers),
  [ADR 0011](0011-outbound-network-proxies-and-private-endpoints.md) (routes, classification caps),
  W5-3 secret managers, W7-1 per-tenant audit chains, W7-4 data residency

## Context

What exists on `main` (commit `14b8a6f`):

- **One table, one page.** `connections` (`apps/api/src/db/schema.ts`) holds both kinds
  (`kind: mcp | model`) with `tenant_id`, `scope` (`platform | tenant | team | agent`),
  `scope_id`, `name`, `config` (jsonb). The console has one "Connections" page
  (`apps/ui/src/features/connections/ConnectionsPage.tsx`) for both kinds.
- **Names.** Migration `0003_tenant_isolation.sql` replaced the global unique name with
  `connections_tenant_name_uq (tenant_id, name)`. Platform connections are stored under the
  tenant of the operator who created them, so they share that tenant's namespace, and a tenant
  connection with the same name as a platform connection **silently shadows** it
  (`resolveForRun`: most specific scope wins per name). Team and agent scopes cannot reuse a name
  inside a tenant (the unique index covers the whole tenant), so "most specific wins" only ever
  decides between platform and tenant.
- **Visibility of platform connections.** `CatalogService.visible()` is
  `tenant_id = caller OR scope = 'platform'`: every platform connection is visible to and usable by
  **every** tenant. There is no grant, no quota per tenant and no per-tenant cost limit on a
  central provider beyond the tenant's own monthly budgets.
- **Multiple instances.** Already possible in principle (two `mcp` connections `jira-support` and
  `jira-engineering` with different `headerSecrets`), but nothing records that both are "Jira":
  no type, no shared tool classification, no catalog, and the UI shows a flat list.
- **BYOK scopes** (`docs/providers.md`): platform, tenant, team, agent; outside the default tenant
  secret references must start with `<tenant-slug>.`; since PR #76 tenants carry
  `tenants.secret_refs` patterns (`secretRefAllowed`), and the credential broker refuses platform
  secrets to run nodes (`platform_secret`).
- **Tool profiles** (W1-2) are declared per MCP connection (`tools`, `profiles`) and expanded into
  published versions.
- **Classification.** Agents declare one `classification`; model providers declare a `clearance`
  and the control agent blocks a run whose classification exceeds it. MCP connections have no
  clearance, no region, and nothing describes where data goes.
- **Retention and erasure.** Step records keep model responses and tool results (redacted for
  secrets); the model proxy captures `metadata` by default (ADR 0009 section 8). There is no
  retention per tenant, no export, no erasure. The audit chain hashes `payloadDigest`
  (SHA-256 of the redacted payload), not the payload itself.
- **Operator access.** Platform operators can act in any tenant with `X-OAX-Tenant` and read
  everything that tenant's admins can read, including step content.

The owner asked for separate console areas for MCP servers and model providers, several
instances of the same server type per tenant with their own credentials, rules for central
(operator-provided) versus tenant connections, and data protection (GDPR) as a first-class input.

## Decision

### 1. Types and instances

- A **connection type** is a catalog entry: what a kind of server or provider is, without
  credentials. MCP examples: `jira`, `github`, `confluence`, `custom-mcp` (any server). Model
  examples: the provider kinds (`anthropic`, `bedrock`, `azure-openai`, `openai`,
  `openai-compatible`, ...). A type carries: `kind` (`mcp | model`), title, vendor, transport and
  endpoint template, the auth fields it needs (as secret-reference slots), for MCP the **tool
  classification** (`tools: { name: { access } }`) and default profiles, for models the model
  catalog link (`catalogProvider`), and **data processing facts** (vendor, processing locations,
  whether the vendor retains data, documentation link). Built-in types ship as reviewed files in
  `packages/core/src/connections/types/*.json`; operators can add types (platform scope); tenants
  can create `custom-mcp` / `openai-compatible` instances without a type of their own.
- A **connection instance** is what exists today as a connection row: a type plus an instance
  `name`, `title`, scope, endpoint, secret references, instance profiles, clearance, region and
  status. Agents **bind to instances by name** (`server: jira-support`, `provider: azure-prod`),
  never to a type. Validation suggests the instances of the same type when a name is unknown.
- Instance rules:
  - Several instances of one type per tenant are normal (`jira-support`, `jira-engineering`; two
    Azure OpenAI deployments; two Anthropic keys for two cost centres).
  - **Tool classes are a floor**: an instance can narrow a type's classification (mark a read tool
    as write) and define its own profiles, but cannot declare a tool `read` that the type declares
    `write`.
  - Credentials, endpoint, profiles, policies (policy bindings by instance, extending W3-3), budgets
    (monthly budget per instance, section 5) and rate limits are **per instance**.
  - "Duplicate instance" copies everything except secret references.

### 2. Central (platform) and tenant connections

Two kinds of central objects, with different risk:

| Central object | Who creates it | Credentials | Use by tenants |
| --- | --- | --- | --- |
| **Central type** (template) | operator | none | tenants create their own instances from it with their own secrets; recommended default for MCP servers |
| **Central instance** | operator | platform secrets, **shared** by every tenant it is granted to | only through an explicit **grant** per tenant (default deny) |

Rules for central instances:

- **Default deny.** A tenant sees and uses a central instance only if a `connection_grants` row
  exists for it: `(connection_id, tenant_id, alias, allowed_teams[], enabled, max_classification,
  monthly_budget_usd, rate_limits, data_processing_ack)`. Granting is a platform operator action;
  revoking takes effect on the next call (cached grants are invalidated).
- **Names, no shadowing.** Each tenant has **one flat namespace** for its own instances and the
  aliases of its grants. Creating a tenant instance whose name equals a granted alias, or granting
  an alias that equals an existing tenant name, is refused (`409 name_taken`). The silent
  shadowing of today ends; the upgrade migration (section 9) keeps existing behaviour and lists
  every collision.
- **Narrowing only.** A grant can narrow a central instance (lower `max_classification`, fewer
  teams, smaller budget and rate limits, a subset of profiles), never widen it.
- **Shared credentials are a risk and are labelled.** A central instance with shared credentials
  means: the vendor sees all granted tenants as one customer (one account, one rate limit, one
  abuse history, one retention policy), and for MCP the shared service account may see data of
  more than one tenant in the remote system. Therefore:
  - central **MCP** instances must declare `dataScope: public | tenant-neutral | multi-tenant`;
    `multi-tenant` (the remote account can see several tenants' data) cannot be granted to more
    than one tenant (`shared_credential_multi_tenant`); the recommended pattern is a central type
    plus per-tenant instances;
  - central **model** instances are fine to share (the platform measures and limits per tenant),
    with the caching and isolation rules of section 4;
  - the grant requires the operator to confirm the data processing facts
    (`data_processing_ack`), and the tenant's processing record (section 7.5) shows the instance
    as "central, shared credentials".
- **Tenant overrides.** A tenant cannot change a central instance. It can create its own instance
  (of the same type) under another name and bind its agents to that one.
- **Legacy env providers** (`OAX_PROVIDERS`) are central model instances with an implicit grant to
  the default tenant only; other tenants need explicit grants (by provider name).

### 3. Run node, credential broker and model proxy

| Path | Tenant instance | Central instance |
| --- | --- | --- |
| Model call, in-process | key resolved on the orchestrator for the run's tenant | same, after the grant check |
| Model call, run node (ADR 0009) | through the model proxy; key never in the node | through the model proxy; key never in the node; grant, quota and per-tenant budget checked in admission |
| MCP call, in-process (gate) | gateway connects with the instance's secrets | same, after the grant check |
| MCP call, run node | credential broker hands the step the instance's secrets (tenant namespace, `secret_refs` patterns) | the broker **refuses** platform secrets (`platform_secret`, unchanged); such steps use a control-node MCP relay through the policy gate (follow-up of W1-3b, open question 2) or stay in-process; publish refuses `runner: container|kubernetes-job` steps that hold tools of a central shared-credential MCP instance without the relay (`central_mcp_node_unsupported`) |

### 4. Isolation on central connections

- **No shared state across tenants**: provider client objects, MCP sessions, OAuth/installation
  tokens and any response cache are keyed by `(tenant_id, connection_id, credential_version)`;
  MCP sessions are per run. HTTP keep-alive pools may be shared per destination only when no
  client certificate or tenant credential is part of the TLS session.
- **Prompt caches**: provider-side prompt caches are scoped to the vendor account, so on a shared
  key one tenant's cache hit could reveal (by latency or cache-read token counts) that another
  tenant sent the same prefix. For central model instances the model proxy enables
  `cacheIsolation: tenant` by default: it prepends a constant, per-tenant, non-secret marker to the
  first cacheable block so that cached prefixes of different tenants never match; cache token
  counts are reported only to the tenant that caused them.
- **Abuse attribution**: where a provider supports an end-user field (OpenAI `user` /
  `safety_identifier`), the proxy sends a stable pseudonym of the tenant (HMAC of the tenant id),
  never a user id or name.
- **Audit separation**: calls are audited in the using tenant's partition; grant changes and
  operator actions in the platform partition; no audit payload of one tenant names another tenant.

### 5. Quotas, budgets and cost attribution

- `cost_ledger` gets `connection_id` and `connection_scope` (`tenant | team | agent | central`).
- Reservations (ADR 0009 section 4.3) get two more scopes: the **grant** (monthly budget of a
  tenant on a central instance) and the **instance** (monthly budget per instance, for cost
  centres). Rate limits per grant (calls/min, tokens/min, concurrency) are checked in admission.
- Cost views and exports group by instance; central instances show cost per tenant to operators
  and only the own tenant's cost to tenant users.

### 6. Console: separate areas

The navigation group "Connections" becomes two entries (and later "Repositories", ADR 0010):

- **MCP servers** (`/mcp-servers`) and **Model providers** (`/model-providers`), each with:
  - **list**: instances of the tenant plus granted central instances (badge "central", alias),
    type, scope, status, clearance/region, last test result, agents bound;
  - **create from type**: a type gallery (built-in, operator, `custom`), then a form per type
    (auth slots as secret-reference pickers, endpoint, profiles/models, clearance, region,
    data-processing facts prefilled from the type);
  - detail tabs: **Configuration**, **Profiles** (MCP) / **Models and prices** (providers),
    **Test** (ADR 0011 section 8 rules: reference-based, categorized result), **Usage** (agents and
    published versions that bind the instance, runs and cost per month), **Access** (scope; for
    central instances: grants, visible to operators), **Audit** (entries whose target is the
    instance).
- Operators get a **Central connections** view with types, central instances and grants per
  tenant.
- The old `/connections` route redirects to `/mcp-servers`. The API keeps `/v1/connections`
  (with a `kind` filter) and adds `/v1/connection-types` and `/v1/connection-grants`.

### 7. Data protection (GDPR) as a design input

#### 7.1 Data flow rules (publish time and run time)

- Every instance gets a `clearance` (MCP too, default `internal`) and, for MCP, an optional
  `dataClassification`: the highest classification of data the instance **returns**.
- Publish refuses: a step that sends data to an instance below the agent's classification
  (`classification_exceeds_connection`, model providers already do this at run time; now also MCP
  write tools and output targets), and a step that **reads** from an instance whose
  `dataClassification` is above the agent's declared classification
  (`classification_below_source`), so data cannot be read under a low label and then sent to a
  low-clearance provider. The gate repeats both checks at run time.
- **Region**: instances get `region` (free-form, from the type's list, e.g. `eu`, `eu-central-1`,
  `us`, `on-prem`); tenants get `allowedRegions` (default: any). Binding an instance outside the
  tenant's regions is refused at publish and in admission (`region_not_allowed`). Storage pinning
  of tenant data remains W7-4.
- **Personal data**: instances declare `personalData: allowed | forbidden`; with PII detection on
  (section 7.3) a call carrying detected personal data to a `forbidden` instance is blocked.
- Route caps of ADR 0011 section 5 (TLS-inspecting proxies) apply on top.

#### 7.2 Retention per tenant

Tenant setting `retention` (operator defaults, tenant admins may only shorten):

| Data | Levels | Default for new tenants |
| --- | --- | --- |
| Model capture (prompts) | `off`, `metadata` | `metadata` (ADR 0009) |
| Step content (model responses, tool results, handovers) | `metadata`, `days: N` | `metadata` |
| Event data (webhook/mail/Kafka payloads) | `days: N` | 30 days |
| Logs (operator) | operator setting, bodies never logged | - |
| Audit entries | kept; payloads can be erased (section 7.6) | kept |

Existing tenants keep today's behaviour on upgrade (`days: unlimited` for step content) and get a
console notice. A daily purge job removes expired content and writes `retention.purged` (counts
only).

#### 7.3 PII redaction hooks

A `Redactor` chain in `packages/core` (next to the secret redactor): built-in detectors (e-mail,
phone, IBAN, payment card with Luhn, IP addresses), tenant patterns (RE2, with W3-3), and an
extension point for an external detector service reached through the network resolver. Hook
points: before storage (step records, audit payloads, event data), before logging, and optionally
before a model or tool call per instance (`pii: off | mask | block`). Masking before a model call
changes what the model sees, so it is opt-in per instance.

#### 7.4 No cross-tenant use of credentials

Unchanged and tested: tenant secret references carry the tenant namespace and the tenant's
`secret_refs` patterns; a tenant cannot name another tenant's or the platform's secrets; central
credentials are never brokered to run nodes; no API returns a secret value.

#### 7.5 Record of processing and sub-processor view

`GET /v1/data-protection/processing` (tenant admins and auditors) lists every external
destination the tenant's agents can reach: instance, type, vendor, endpoint host, region,
clearance, personal-data flag, central/shared, retention declared by the type, agents and
published versions that bind it, and the platform's own sub-processors declared by the operator
(`OAX_DPA_SUBPROCESSORS` file: hosting, mail, monitoring). Export as JSON, CSV and Markdown, ready
to attach to a record of processing activities or a DPIA. `docs/data-protection.md` (new)
describes the data categories, flows, retention, roles (operator as processor, tenant as
controller) and the technical and organisational measures the platform provides.

#### 7.6 Export and erasure

- **Export** (`POST /v1/tenant/export`, tenant admin): an asynchronous bundle with agents and
  versions, runs (metadata and retained content), costs, the tenant's audit entries with
  verification data, and the processing record; audited `tenant.exported`.
- **Erasure of a person** (`POST /v1/data-subjects/erase { userId | email | pattern }`): user
  records are pseudonymised (name and mail replaced, the opaque user id stays as the pseudonym in
  the audit chain); retained step content and event data that match are deleted; audit payloads
  that contain the person are **tombstoned**: the payload is removed and replaced by
  `{ erased: true, reason }` while `payloadDigest` stays, so the hash chain still verifies and
  `audit verify` reports the entry as `payload_erased` instead of failing. New entries use a
  **salted** payload digest (HMAC with a per-entry random salt stored next to the payload and
  erased with it), so an erased low-entropy payload cannot be recovered by brute-forcing the
  digest.
- **Erasure of a tenant**: retained content is encrypted with a per-tenant data key (envelope
  encryption; the key-encryption key from the operator's secret or KMS); deleting the tenant
  destroys the data key (**crypto-shredding**), which also covers backups. The audit chain keeps
  the tenant's entries as metadata (tombstoned payloads) because the chain is global until W7-1;
  with per-tenant chains (W7-1) the whole tenant chain can be archived or deleted after its legal
  retention period.

#### 7.7 Admin separation

- Tenant setting `operatorAccess: metadata | full` (default `metadata`): platform operators acting
  in a tenant (`X-OAX-Tenant`) see agents, runs, status, costs and audit metadata, but step content,
  event data and prompts are withheld (`403 operator_content_denied`).
- **Break-glass**: `POST /v1/tenants/{id}/support-access { reason, minutes <= 60 }` grants content
  access for a limited time, notifies the tenant admins and is audited in both partitions
  (`support_access.granted`, `support_access.used`).
- Secret values are never readable through any API. Operators who run the infrastructure can
  still read environment secrets and mounted files; real separation from infrastructure operators
  needs tenant-owned secret stores (W5-3, per-tenant Vault paths or cloud accounts) and
  tenant-owned key-encryption keys (open question 4). The documentation says so.

#### 7.8 Audit events

`connection.created|changed|deleted` (field names, never secret values), `connection.tested`,
`connection_grant.created|changed|revoked`, `connection.denied` (reason codes above),
`retention.purged`, `pii.blocked` (instance, detector names, never the value),
`tenant.exported`, `data_subject.erased` (pseudonym, counts), `audit.payload_erased` (seq range,
counts), `support_access.granted|used|expired`, `tenant.key_destroyed`.

### 8. Data model (migration `0012_connection_instances.sql`)

- `connections`: add `type` (text, backfilled: MCP rows `custom-mcp`, model rows their provider
  kind), `title`, `clearance` (MCP; model rows keep it in `config` and get the column filled),
  `data_classification`, `region`, `personal_data`, `data_scope`, `status`, `credential_version`.
  Replace `connections_tenant_name_uq` with two partial unique indexes: `(tenant_id, name)` where
  `scope <> 'platform'` and `(name)` where `scope = 'platform'`.
- `connection_types` (operator-defined types; built-in types live in code).
- `connection_grants` (section 2).
- `cost_ledger`: `connection_id`, `connection_scope`; `model_reservations`: grant and instance
  scopes.
- `tenants`: `retention`, `allowed_regions`, `operator_access`, `data_key_id`.
- `audit_entries`: `payload_salt` (nullable, new entries), `payload_erased_at`.

### 9. Upgrade path

- Every existing platform connection gets a grant for every existing tenant whose agents can see
  it today (behaviour preserved), alias = name. New tenants get no grants unless
  `OAX_PLATFORM_CONNECTIONS_DEFAULT_GRANT=all` (single-tenant convenience).
- Existing name collisions between platform and tenant connections keep resolving as today for the
  affected tenant (tenant wins), the grant for that tenant is created **disabled**, and the console
  lists the collision with a "rename" action.
- Existing tenants keep their retention behaviour (section 7.2); new tenants start with the
  data-minimising defaults.

## Consequences

- Positive: the console mirrors how people think (servers and providers are different things);
  several instances per type with their own credentials, profiles, budgets and policies become
  natural; central connections become a governed offer instead of a silent default.
- Positive: data flows become explicit and checkable (classification, region, personal data), and
  a tenant can produce its processing record and DPIA inputs from the platform.
- Negative: default deny for central connections changes behaviour for new tenants (pre-1.0,
  changelog); grant management is new operator work.
- Negative: tombstoned audit payloads weaken what an auditor can see for erased persons; the
  chain still proves order and integrity of everything else.
- Negative: encryption of retained content adds a key-management dependency and a small cost per
  read and write.

## Alternatives considered

- **Keep one page with a kind filter**: simplest, but does not scale to instances, types, grants
  and usage views. Rejected.
- **Bind agents to types and pick the instance at run time** (per team or use case): hides which
  credentials an agent uses and makes reviews meaningless. Rejected; explicit instance names.
- **Central instances visible to all tenants (today)**: convenient for single-tenant installs,
  wrong for multi-tenant ones. Kept only as an opt-in default grant.
- **Hash the audit payload itself**: erasure would break the chain. The existing digest design plus
  salted digests and tombstones keeps integrity and allows erasure.
- **Per-person encryption keys for crypto-shredding**: precise but heavy (key per data subject,
  lookups on every write). Per-tenant keys plus deletion of matching content and tombstones cover
  the realistic cases.

## Open questions

1. Default retention for new tenants: `metadata` only for step content (data-minimising, but the
   run view then shows no outputs), or a short window such as 7 days?
2. Control-node MCP relay for central shared-credential MCP servers used by run nodes: part of
   this wave or a follow-up of W1-3b?
3. Should tenants be allowed to publish their own types for other teams (tenant-level catalog)?
4. Tenant-owned key-encryption keys (customer-managed keys in a KMS) for crypto-shredding and
   secret separation from operators: required for v1.0?
5. Which built-in types ship first (Jira, Confluence, GitHub, GitLab, ServiceNow, Slack)?
