# Agent lifecycle: revisions, reviews and approval records

Design: [ADR 0017](adr/0017-agent-lifecycle-governance.md), slices S1 (#244) and S2 (#245).
**Status: enforced (slices S1, S2 and S3).** Drafts get revisions, reviews can be opened and decided,
approval records bind a decision to exact content, the tenant policy exists, the console has a Review
tab, and **publishing is refused wherever the policy requires approval and the review is not approved
by eligible, independent approvers** (S3, #246). Versions can be deprecated, and deprecating the latest
one is a rollback. There is **no break-glass**: no parameter, role, setting or endpoint publishes
without the approvals that are required (ADR 0017 decision 11). Agent rules, secret scopes and review
via Git are later slices.

## What exists

| Part | Where |
| --- | --- |
| Immutable draft revisions with their author | `GET /v1/agents/{id}/revisions`, `GET .../revisions/{seq}` |
| Reviews: open, read, decide, withdraw | `POST/GET /v1/agents/{id}/reviews`, `GET /v1/reviews/{id}`, `POST /v1/reviews/{id}/decisions`, `POST /v1/reviews/{id}/withdraw` |
| Tenant lifecycle policy (narrowing only) | `GET/PATCH /v1/tenants/{id}/settings/agent-lifecycle` |
| Comment threads, comments, resolve | `GET/POST /v1/reviews/{id}/threads`, `POST .../threads/{tid}/comments`, `PATCH .../threads/{tid}`, `PATCH/DELETE .../comments/{cid}` |
| What a review changes (sources, semantic summary, policy summary) | `GET /v1/reviews/{id}/changes` |
| Display names of the people of a review | `GET /v1/reviews/{id}/people` |
| Your review inbox | `GET /v1/me/reviews` |
| Review tab, status badges, decision bar, inbox page | console: agent page, tab "Review"; `/reviews` |
| Publish under approval (the gate) | `POST /v1/agents/{id}/publish` with `reviewId` and `expectedDigest` |
| Version deprecation and rollback | `POST /v1/agents/{id}/versions/{version}/deprecate` |
| Rule module (A1 to A8, A10) | `packages/core/src/approvals/rules.ts` |
| Policy resolver | `packages/core/src/tenancy/lifecycle-policy.ts` |

## Draft revisions

Every save of an agent's draft that changes the *normalised* content (line endings and trailing
whitespace do not count) appends an immutable revision with its author; saving identical content
creates none. `agents.draft_source` stays a copy of the newest revision, byte for byte. A revision
cannot be changed in the database (trigger). Revisions are kept while a review or version references
them.

Agents that existed before migration `0032` get **one system revision** (author unknown) when the
control node starts, or on their next save if that comes first. An unknown author counts as every user
whom the audit chain shows editing the draft since the base version, plus the creator of the agent
(best effort; the review says `unknownAuthor`).

## Reviews

A review is opened on the current revision by someone with `agents:write` on the agent. One review per
agent is open at a time (`409 review_open`); a draft equal to the latest published version has nothing
to review (`409 nothing_to_review`). The review **follows the draft**: a new revision makes every
earlier decision stale (shown with `reasons`, never counted).

The state is computed, never stored as a flag: `review_requested`, `changes_requested` (a reviewer's
latest decision on the head revision is `request_changes`), `approved` (enough valid approvals), or the
final `withdrawn` / `rejected` / `published`.

When a review is opened and on every decision the server computes the digests an approval binds to:

| Field | Meaning |
| --- | --- |
| `digest` | SHA-256 of the normalised source (as `agent_versions.digest`) |
| `expansionDigest` | digest of the concrete grants after profile expansion against the catalog of now: the reviewer approves concrete tools, not profile names that may widen later |
| `resolutionDigest` | digest of the secret resolution; until slice S4 it covers the sorted secret *names* the steps declare |
| `policyDigest` | digest of the effective lifecycle policy (and, later, the matching agent rules) |
| base version | what the diff is computed against |

Every digest has a domain tag and a version, is computed over canonical JSON (sorted keys) and over
sorted, de-duplicated lists, so equal inputs give equal digests and a different input never shares a
serialisation.

### Deciding

`POST /v1/reviews/{id}/decisions` takes `{ decision: approve | request_changes | reject,
expectedDigest, comment? }`. `expectedDigest` is required: it is the digest of the revision the
reviewer looked at; the optional `expectedExpansionDigest`, `expectedResolutionDigest` and
`expectedPolicyDigest` bind the decision to the other digests too. A mismatch is `409 stale_view`.
The record stores the digests the server computed under lock, never values from the request.

A comment is required to request changes or reject (at most 10 000 characters, invisible Unicode
removed) and is **never copied to the audit chain**. A `reject` closes the review. A reviewer who
changes their mind adds a new decision; the latest one counts, and one reviewer counts once.

### Who may decide

Evaluated at decision time and again every time a review is read (an approval whose reviewer is no
longer eligible stops counting, with the reason):

| Rule | What it means | Refusal |
| --- | --- | --- |
| A1 | A **contributor never decides**: every author of a revision since the base version and the user who opened the review. In no role, with no token, platform administrators included. Not configurable. | `403 self_approval` |
| A2 | Distinct users: one reviewer counts once whatever roles they hold. | n/a |
| A3 | The reviewer holds `agents:approve` on the agent through a binding whose role is in the effective `allowedApproverRoles` (default `admin`, `agent-maintainer`; `agent-developer` and `operator` only when the tenant adds them). The binding covers the agent: node binding (with inheritance), team binding of the agent's team, or a binding on the agent. | `403 not_eligible` |
| A4 | The qualifying binding was **not granted by a contributor**, **anywhere up its grant chain**, and the reviewer's account was **not made by a contributor** (`granted_by`; for a directory mapping the creator of the mapping). The chain is followed transitively, six hops deep: the grantor, the account that created the grantor (`users.created_by`), and whoever granted the grantor the roles that allow granting (`users:write`), and so on. A contributor who makes a second administrator account and lets it create the approver therefore does not get an approver. A grantor that is **unknown** (see below), or a chain longer than six hops, is refused as well unless the installation sets `OAX_LIFECYCLE_UNKNOWN_GRANTOR=allow`. There is no minimum age. The chain is **stored on the row** when the grant is made (`grant_chain uuid[]` on `tenant_role_bindings`, `team_members`, `agent_role_bindings` and on `users`, computed under the binding lock) and evaluated together with the live chain, so a link that is revoked, expires or is deleted afterwards (a contributor removes the administrator binding of the account they used, the account is deleted) does not launder the approver. A change that widens a binding (another role, `inherit`, a later expiry) keeps the first grantor in `granted_by` (replacing it would hide who granted the binding and would clear an unknown mark) and **adds the chain of whoever widened it** to `grant_chain`; every grantor stays recorded. A row with a grantor but no stored chain is unknown. | `403 binding_granted_by_contributor`, `403 binding_grantor_unknown` |
| A5 | A person with an interactive session. API tokens only when the tenant sets `allowTokenApprovals`. Non-human actors (`repo:*`, `node:*`, guests, the system) never. | `403 token_approval_disabled`, `403 actor_not_human` |
| A6 | `approverIdentitySources` limits which accounts count (`local`, `oidc`, `ldap`). | `403 identity_source_not_allowed` |
| A7 | `approverScope`: `tenant`, `team` (members of the agent's team only) or `other-team` (not members). | `403 approver_scope` |
| A8 | `minApprovals` distinct approvals (default 1, at most 5). | state stays `review_requested` |
| A10 | The reviewer can read the agent and decided on the digest of the current revision. A reviewer who cannot read the agent gets 404; the stale check comes last, so an ineligible caller never learns that the digest is stale. A decision must carry `expectedExpansionDigest`, `expectedResolutionDigest` and `expectedPolicyDigest` as well whenever it is an approval or approval is required (`400 validation_failed` otherwise), so an approval never binds to an expansion the reviewer did not see. | `404`, `409 stale_view` |

**Grantor: nobody versus unknown.** `granted_by IS NULL` with `grantor_unknown = false` and no
`grant_chain` means nobody granted the row (an identity provider, the bootstrap administrator, the
platform operator flag) and is never contributor-made. `granted_by` set with `grant_chain IS NULL`
(the chain was never recorded) is unknown as well. The same holds for accounts: `users.created_by`
with no `users.grant_chain`, or `users.creator_unknown = true` (a local account that nobody is shown
to have made, or whose creator was deleted before a chain was stored), is an unknown creator and
fails closed like an unknown grantor. A creator or grantor that is deleted later stays in the stored
chain (plain ids, no foreign key), so the rows it granted and the accounts it made stay attributable. `grantor_unknown = true` means somebody did and we cannot say who: rows from
before the grantor was recorded that the audit chain (`user.created`, `user.updated`,
`team.members.set`, `agent.members.set`) could not attribute, mirror rows that the reconcile or the
home-move trigger re-created, and rows whose grantor account was deleted. Migration `0036` attributes
the rows it can and marks the rest unknown; migration `0037` re-checks every attribution with a
stricter rule (below) and backfills the chain. Rows of identity-provider accounts and of the bootstrap
administrator stay "nobody" unless the audit chain shows an administrator listing the role or
membership before.

**Attribution from the audit chain (migrations 0036 and 0037).** A role in `global_roles`, a team or
an agent membership counts as granted by the actor of the earliest entry that lists it after the last
entry that does not, **only when the chain shows it absent before**: the entry is `user.created`
(for roles), or `team.created` / `agent.created` precedes it (for memberships), or an earlier entry
lists the roles or members without it. A chain that starts mid-way, a role that was never absent,
entries without `globalRoles` and an actor that is `system` or not an account (a script) cannot be
told apart from lost data and make the row **unknown**, not clean. The distinction between a script
and lost data is not kept: re-grant the row to clear it. An identity-provider login keeps the
grantor of a team membership that stays (it rewrites the memberships from the group mapping, but must
not erase who granted one). Unknown rows cannot make a reviewer an approver by default (the
operator can set `OAX_LIFECYCLE_UNKNOWN_GRANTOR=allow` while the bindings are removed and added again; a
membership that stays in a team or agent member list keeps its unknown grantor, so remove and add it to
clear the mark). **Recommendation:** set `approverIdentitySources` to `[oidc, ldap]`. Accounts of an
identity provider cannot be created or given a password by a contributor, which closes the
local-account route of rule A4 completely; the grant-chain check is the defence for installations that
approve with local accounts.

The review lists its `contributors` (user ids) to everybody who can read the agent, so the console can
say why somebody may not decide. A9 (agent rules) arrives with slice S8. A platform operator is an approver under the same rules, as a
distinct person; acting in another organisation they keep the roles of their home tenant (source
`platform`, nobody as grantor).

`agents:approve` is **not** in `USE_CASE_PERMISSIONS` (decision recorded for #336 item 7): a
maintainer bound to a use case only does not hold it, so deciding a review is refused for them
(`403`, fail closed). The same holds for `agents:review` and `agents:rules`. Granting them per use case
needs its own decision, together with the use-case scoping of agent rules (slice S8).

### The approval record

Each decision row stores: review, revision, `digest`, `expansion_digest`, `resolution_digest`, base
version, `policy_digest`, reviewer, `reviewer_auth` (`session` or `token:<id>`), the acting node, the
bindings that made the reviewer eligible (id, role, source `mirror | grant | team | agent | platform`
and, with slice S11, `directory`; and who granted each), the decision, the comment, `satisfies` (agent
rules, empty until S8), `decided_at` and `expires_at` (approvals only, `approvalExpiryHours`). Decisions
are append-only in the database.

## Comment threads (slice S2)

A thread belongs to a review and is about the review as a whole or about one line of the diff. A line
thread stores the **side** (`head`: a revision of the draft, `base`: the base version), the line
number and the SHA-256 of the line text; the server computes the hash from the stored source, so an
anchor cannot name a line the source does not have (`400 anchor_invalid`). Lines are numbered as the
console numbers them (the source split on `\n`); trailing blanks do not count for the hash.

- **Outdated.** Threads survive new revisions. Whenever a thread is read, its anchor is compared with
  the current head of the review (side `head`) or the base version (side `base`): if the line no
  longer holds the same text at the same number, the thread is `outdated`. It is kept with the
  revision it was written on and shown apart in the console; writing the old text back makes it
  current again. Nothing is stored for this, so there is nothing to get out of step.
- **Who may comment.** `agents:review` on the agent (admin, agent-maintainer, agent-developer,
  integrator, operator, auditor). `viewer` and `pentest` cannot read or write comment text; they can
  still read the review and its changes. Use-case bindings never carry `agents:review` (same decision
  as for `agents:approve`: a caller bound to a use case only gets 403 on every thread route). A review of
  another tenant, an unreadable agent, an unknown thread or a thread of another review all answer with
  the same `404`.
- **Who may change what.** A comment can be edited and deleted by its **author only** (an
  administrator cannot edit someone else's words). Editing needs an open review. Deleting is also
  possible on a closed review, so that someone can take back something pasted by mistake: the row stays
  as an empty tombstone so that the thread keeps its shape. A thread is resolved or reopened by the
  person who started it or by a **contributor** of the review (an author of a revision since the base
  version, or the opener), as in Git hosts. Resolving does not decide anything; the later rule
  `requireResolvedThreads` (slice S8) should not count a thread that a contributor resolved against the
  reviewer's will.
- **Limits.** At most 10,000 characters per comment (after invisible and steering characters are removed;
  `400 comment_too_long`), 200 threads per review (`409 thread_limit_reached`), 200 comments per thread
  (`409 comment_limit_reached`), 1,000 comments and 1,000,000 characters of discussion per review, edits
  included (`409 review_comment_budget_reached`; one list call reads and returns at most that), and
  `OAX_RATE_LIMIT_COMMENT_MAX` (default 30) new comments per user and
  minute (`429 rate_limited`), counted in the database over every session and token of the user, deleted
  comments and edits included; every write route also has the same limit per token and address. A comment on a closed review is `409 review_closed`.
- **Concurrency.** Every write locks the agent row `FOR KEY SHARE` and then the review row `FOR UPDATE`, the
  order a decision uses (it holds the agent row `FOR UPDATE` first), so the two cannot deadlock; inserting a
  thread takes that agent lock anyway through its foreign key. A comment that
  races a rejecting decision either lands first or is refused with `409 review_closed`; the thread and
  rate limits are counted after every earlier write committed. Comments never change the state of a
  review.
- **Long lines.** A source line may be hundreds of thousands of characters. The line hash trims trailing
  blanks with a loop (a regular expression is quadratic on a long run of blanks) and hashes the first
  4,096 characters plus the length; tests time a 500,000-blank line. The console's diff trims the common
  ends, falls back to "removed lines, then added lines" above 4 million cells, collapses unchanged
  lines (three lines of context) and renders at most 3,000 lines.
- **Database integrity.** A thread must agree with its review on agent and tenant, and a comment with its
  thread on review and tenant (composite foreign keys); threads and comments cannot be deleted or
  truncated (triggers, and `deploy/sql/roles.sql` revokes `DELETE` and `TRUNCATE` from the application role).
- **Logs.** A failed statement is logged with its code, constraint, table and placeholders only: drizzle's
  error message holds the bound parameters and PostgreSQL's `detail` holds the failing row, either of
  which could be comment text.
- **Mentions** are plain text: nothing is resolved and nothing is notified (notifications are slice S13).
- **Text stays out of everything else.** The comment text is stored in `agent_review_comments` and
  returned by the thread endpoints, and goes nowhere else. The audit entry `agent.review.comment`
  carries the ids of the review, thread and comment, the operation (`created`, `edited`, `deleted`) and
  the length; `agent.review.thread_resolved` carries ids and the new state. No span attribute, log line,
  metric label, error body or model request contains it. Tests search the audit chain, logs, spans,
  the metrics scrape and the other endpoints for a canary comment, and check that only the thread
  service reads the two tables (`apps/api/test/review-threads-canary.test.ts`).

### Safe rendering

The console renders a comment as a **Markdown subset without HTML** (`apps/ui/src/features/reviews/markdown.ts`):
paragraphs, bold, italic, inline code, code fences, bullet and numbered lists, block quotes and links.
There is no `dangerouslySetInnerHTML` and no element is created from the text, so raw HTML shows as text.
Links are rendered only for absolute `http://` and `https://` URLs without credentials; they open with
`rel="noopener noreferrer nofollow"` and the host is shown next to the link text. `javascript:`,
`data:`, `vbscript:`, `file:`, relative and protocol-relative URLs, URLs with whitespace or control
characters and URLs over 2,000 characters stay plain text. Images are never rendered (the construct
is shown as written). The parser moves forward only, looks for closing delimiters with `indexOf` and
remembers a delimiter without a closer, uses no nested quantifiers, cuts the input at 10,000
characters and limits nesting, blocks and list items; the tests render a list of hostile payloads into a
real DOM and time adversarial inputs.

## The Review tab

The tab shows, for the agent's open review (or the latest closed one): the status badge, who asked, the
base version, the reviewed revision, approvals counted of required and the decisions with the reason
each one does not count; the **decision bar**; the **semantic summary**; the **diff** of the base
version against the reviewed revision with the threads under their lines; the discussion about the
review as a whole; and the outdated threads.

- **Status badges**: `In development`, `Review requested`, `Changes requested`, `Approved`,
  `Published` (text and icon, never colour alone, English and German). An open review decides; otherwise
  a draft equal to the published version is `Published` and everything else is `In development`.
  There is no break-glass badge because there is no break-glass. The badge is on the agent page; the
  agent list does not show review states yet (it would need the state of every open review).
- **Decision bar**: Approve, Request changes, Reject, with a comment (required for the last two).
  When the caller may not decide, the buttons are disabled and the reason is written next to them
  and linked with `aria-describedby`: you contributed (`self_approval`), your role is not an approver role,
  the only bindings that make you one were granted by a contributor, API tokens may not decide, only a
  person can decide, your identity source may not decide, or, for the approver scope, "This rule needs a
  member of team X" (or, for `other-team`, a reviewer who is not a member of it). The decision carries
  every digest on screen (`expectedDigest`, `expectedExpansionDigest`, `expectedResolutionDigest`,
  `expectedPolicyDigest`); `409 stale_view` asks the reviewer to reload.
- **Semantic summary** (`GET /v1/reviews/{id}/changes`): the tools of the head with their access class
  (read, write or unclassified, which counts as write), the approval flag and the profile each grant
  came from (the **expanded grants**), added, removed and changed tools marked in words, egress hosts,
  secret references by name, budget, classification, runtime, owner and use case. **Secret references
  carry the scope `legacy` and no owning node until the scoped secret store exists (slice S4)**;
  inherited and shadowed secrets are not shown because no such data exists. **Agent rules** do not exist
  yet (slice S8): the summary says so and lists no requirement. The head is expanded against the
  connection catalog of now, as the expansion digest is; the base is what was stored when it was
  published. The endpoint also returns the part of the effective policy that decides who may approve.
- **Inbox**: `GET /v1/me/reviews` and the page `/reviews` list the newest open reviews of the acting
  tenant that the caller could decide right now (rules A1 to A7), for agents they can read. Looking at
  the newest 100 open reviews bounds the work.
- Names: `GET /v1/reviews/{id}/people` resolves the identifiers of the review to display names of
  accounts of the acting tenant, so the console shows people, not identifiers.

## Policy changes while a review is open

An open review is judged by the **stricter of the policy it was opened under (its snapshot) and the
policy now**, key by key (the same rule as narrowing: the larger `minApprovals`, the shorter expiry, the
intersection of the approver roles and identity sources, approval stays required). Loosening the policy,
or switching approval off, therefore does not relax a review that is already open; tightening applies
at once. The reviewer sees the digest of the policy that applies. A change that makes the effective
policy of a node looser is refused with `403 policy_loosening_by_contributor` when the caller, or
anybody the caller's authority comes from, is a contributor of an **unfinished** review in the subtree
of that node; another administrator makes it. The rules, all fail closed (#356):

- **The caller's chain counts.** The caller is the caller plus the creator chain and the grantors of
  their administrator bindings (the same walk as rule A4, stored chains included). An account that a
  contributor made, or whose administrator role a contributor granted, cannot loosen the policy for
  them. A chain that cannot be followed counts as a contributor as soon as a review is unfinished.
- **Withdrawing does not release.** A review is unfinished while it is open, and after it was
  withdrawn or rejected until an administrator **outside the contributors and their chains** releases
  it with `POST /v1/reviews/{id}/clear-hold` (a reason is required; audited as
  `agent.review.hold_cleared`; `403 hold_clear_by_contributor`, `409 not_held`). Withdraw, loosen,
  reopen is therefore refused. **Publishing a version does not end the hold** of a withdrawn or
  rejected review (the publish of an agent whose approval is switched off proves nothing about that
  review). A review that was **published** (closed by an approved publish) is finished by itself. An agent with 25 withdrawn or rejected reviews nobody released cannot open
  another (`429 review_hold_limit`), so open, withdraw, repeat cannot pile up holds without bound.
  Note that anyone with `agents:write` on an agent can fill that cap for that agent (an insider can
  block new reviews of an agent they can already write to until an administrator releases the holds);
  bulk release and a per-opener cap are follow-ups.
- **The contributor window of a closed review is frozen.** A withdrawn or rejected review records the
  head revision it closed at (`agent_reviews.closed_revision_id`; the audit fallback for unknown authors
  ends at `closed_at` too), so people who edit the agent later are not contributors of the old, held
  review and can loosen the policy or release the hold. A review whose head cannot be read at all (no
  recorded closing revision and no draft revision) refuses every administrator; a **platform operator**
  can release such a hold with `clear-hold` (the way out), and an open one is withdrawn first.
- **A tenant move that widens the policy is a loosening.** Moving a node out from under the ancestors
  that set a policy (`policiesWidened`) runs the same check on the moved subtree, also as a dry run.
- **Every agent with an unfinished review is checked**, once per agent (the earliest unfinished
  review has the widest window of revision authors; the openers of the others are added), page by
  page; more than 20 000 such agents are refused as unverifiable instead of being ignored. A review
  whose head revision cannot be read is treated as a contributor. The expensive check runs
  **before** the tenant and binding locks are taken; under the lock only a fingerprint (the caller's
  chain and the unfinished reviews with each agent's head revision) is compared, and the full check
  is repeated under the lock only when it changed. A tenant move runs the full check under its lock.
- **Who can loosen.** The bootstrap administrator, platform operators and administrators whose chain
  is known and reaches no contributor of an unfinished review in the subtree. Accounts with an
  unknown creator or grantor cannot while a review is unfinished, unless the installation sets
  `OAX_LIFECYCLE_UNKNOWN_GRANTOR=allow` (the guard honours it for an unknown chain; known
  contributors stay refused).

(Notifying
the administrators of a node about loosening changes follows with the notification slice S13; the
audit entry `tenant.lifecycle_policy_changed` lists the loosened keys.)

## Draft source and head revision

`agents.draft_source` and `agents.draft_revision_id` are written together, but nothing in the
database ties them. When the draft of a locked agent has a different digest than its head revision (an old
replica during a rolling upgrade, a manual repair), the draft is appended as a new revision by an unknown
author (`system`) before a review, a decision, a save or a publish goes on, so what is reviewed and
approved is the content the draft really has. **Do not run mixed versions of the API during an
upgrade** (stop the old replicas before the new ones take writes); the S3 publish publishes the source
of the revision it checked.

None of the endpoints of this slice returns `grantedBy`, the binding references or a token identifier
(finding 9 of #343); the S1 review view still does, for any reader of the agent, until that follow-up.

## Concurrency

A decision runs in one transaction that takes, in the order of the lock rules (`tree-lock.ts`), the
organisation's tree lock (shared), its binding lock, the agent row lock and then the review row lock.
Draft saves, withdrawals, publishes and other decisions of the same agent are serialised with it:

- a revision saved between the moment a reviewer loaded the review and the decision makes the decision
  `409 stale_view`; an approval is never bound to a revision the reviewer did not see;
- a withdrawal and a decision race: whichever comes second sees the other (`409 review_closed`);
- two reviewers deciding at once are both recorded;
- the eligibility of the reviewer is read inside the transaction, never from a cached principal;
- the connection catalog behind the expansion digest is read just before the locks are taken (a
  connection change is not serialised with reviews); it can only make an approval stale at publish,
  where the expansion is computed again (slice S3), never let a wrong one through.
- publish is serialised with all of the above by the same locks (tree, bindings, agent): a draft save,
  a decision, a withdrawal, a binding change or a policy change either committed before publish
  read its state, or waits until publish has committed and sees the review closed.

## Policy

`settings.agentLifecycle` of a tenant node. The root of an organisation chooses freely; every node
below it may only **narrow** the effective policy of its parent. A write that would widen any key is
`422 not_narrowing` (the keys are named). A stored value that is looser than the parent's anyway (the
parent tightened later) is clamped when the policy is resolved, so the effective policy of a node is
never looser than its parent's. `null` removes a value. Writes need `settings:write` on the node and
are audited as `tenant.lifecycle_policy_changed` (changed keys with old and new values).

| Key | Values | Default | A child may only |
| --- | --- | --- | --- |
| `requireApprovalForPublish` | `off`, `production-only`, `on` | `on` in multi-tenant installations, `off` in single-tenant (`OAX_LIFECYCLE_REQUIRE_APPROVAL=auto`) | raise |
| `productionUseCases` | use-case globs | `[]` | add entries |
| `selfApproval` | `never` | `never`, fixed | n/a |
| `minApprovals` | 1 to 5 | 1 | raise |
| `allowedApproverRoles` | subset of `admin`, `agent-maintainer`, `agent-developer`, `operator` | `[admin, agent-maintainer]` | narrow (never empty) |
| `approverScope` | `tenant`, `team`, `other-team` | `tenant` | leave `tenant` for `team` or `other-team` |
| `approvalExpiryHours` | 1 to 720 | 168 | lower |
| `allowTokenApprovals` | `true`, `false` | `false` | set to `false` |
| `approverIdentitySources` | `local`, `oidc`, `ldap` | all | narrow |
| `publishBy` | `any-publisher`, `approver-only` | `any-publisher` | `approver-only` |
| `allowDraftRuns` | `off`, `development-credentials`, `on` | `development-credentials` | lower |
| `allowPersonalSecretsInDevRuns` | `true`, `false` | `true` | set to `false` |
| `allowPersonalSecretsInPublishedAgents` | `never`, `with-approval` | `never` | set to `never` |
| `allowProductionSecretsInDraftRuns` | `true`, `false` | `false` | set to `false` |
| `gitUnsignedContributors` | `declared-non-production`, `refuse` | `refuse` | set to `refuse` |

There is no `breakGlass`, no `breakGlassRatifyHours` and no `approverBindingMinAgeHours`: sending one
is `400`. Of these keys, S1 consumes `requireApprovalForPublish`, `productionUseCases`, `minApprovals`,
`allowedApproverRoles`, `approverScope`, `approvalExpiryHours`, `allowTokenApprovals` and
`approverIdentitySources`; the others are stored, narrowed and digested now and used by the later
slices. The installation defaults are the `OAX_LIFECYCLE_*` variables in
[configuration.md](configuration.md#agent-lifecycle-policy).

## Publish: the approval gate

`POST /v1/agents/{id}/publish` takes `{ "reviewId": "...", "expectedDigest": "<sha-256>" }`. Both are
required where approval is required (the tenant policy `requireApprovalForPublish` is `on`, or
`production-only` and the **union** of the published version's and the draft's use case is a production
use case; or an open review keeps approval required, see "Policy changes while a review is open").
Where it is not required the body can be left out and publish behaves as it always did, except that an
open review (advisory) is closed as `published`. Unknown body fields are a `400`: there is nothing to
pass to skip an approval.

Everything happens in **one transaction** under the organisation's tree lock (shared), its binding lock
and the agent row lock, in this order. Under those locks, publish

1. reads the head revision and requires it to be the draft the earlier checks ran on (`409
   draft_changed`; a save that slips in after the checks is refused, nothing is published);
2. applies the version rules again to the versions as they are now (a concurrent publish of the same
   version is refused);
3. decides whether approval is required (the policy at the agent's node, and the stricter snapshot of
   an open review) and, if it is, runs the gate:

| Step | Refusal |
| --- | --- |
| `OAX_ROLE_BINDINGS_READ=bindings` | `409 role_bindings_read_required` (see below) |
| `reviewId` and `expectedDigest` named | `409 approval_required` (`details.missing`) |
| the review is the open review of this agent | `409 review_closed` |
| `expectedDigest` is the digest of the head revision | `409 draft_changed` |
| the profile expansion, recomputed from the revision's source against the connection catalog, equals the one each approval bound to | `409 approval_stale`, `details.reason = expansion_changed` |
| the secret resolution, recomputed likewise, equals the approved one | `409 approval_stale`, `details.reason = secret_resolution_changed` |
| enough approvals still count and no reviewer has an unresolved request for changes | `409 approval_insufficient` with `details.required`, `counted`, `changesRequested` and, per approval, the reasons it does not count (`expired`, `revision_changed`, `not_eligible`, `binding_granted_by_contributor`, `binding_grantor_unknown`, `approver_scope`, ...) |
| `publishBy: approver-only`: the publisher is one of the approvers | `403 publisher_not_approver` |

"Still count" means that **every stored approval is judged again at this moment** by the same code that
judged the decision (`checkApprover`, rules A1 to A8 and A10): the reviewer is still a person with a
session (or a token the tenant allows), holds an approver role through a binding that covers the agent
**now** (revoked, expired and narrowed bindings no longer count), is not a contributor, was not
granted that role by a contributor (the stored grant chain and the creator chain of the account are
evaluated; a grantor that cannot be established refuses unless `OAX_LIFECYCLE_UNKNOWN_GRANTOR=allow`),
has not been replaced by a later decision of their own, and has not expired. A looser policy never
relaxes an open review; a stricter one applies at once.

On success the version is inserted **from the revision's source** (never from a value read earlier)
with the approval record (`agent_versions.review_id`, `approved_by`, `policy_digest`,
`expansion_digest`, `resolution_digest`, and `secret_resolution`, the references pinned for production
runs; names only until slice S4), `agents.latest_version_id` moves, the review is closed as `published`
(`agent_reviews.published_version_id`) and `agent.published` and `agent.review.closed` are appended in
the same transaction. Every refusal is audited as `agent.publish.refused { code, review }` (at most one
entry per agent, user and code and minute). A review approves exactly one version.

**There is no break-glass.** No emergency publish, no ratification endpoint, no bypass parameter, no
administrator exception, no platform-operator exception: a test walks the route table and the body
schema for them. Incidents are handled with the actions that reduce reachability (disable the agent,
cancel runs, roll back, below) and with a normal, fast review. The only publish without approval of a
tenant that requires it is the **deterministic demo seed** (`AgentsService.publishDemoSeed`, used by
`seedDemo` only): it refuses any agent whose id is not the fixed demo id of its name, which no request
can choose, and any agent that already has a version.

### `OAX_ROLE_BINDINGS_READ=bindings` is required

The stored grant chains and the binding lock only hold on the resolver read path
(`assertNodeAuthority` returns before the binding lock on `legacy`). Publish therefore **refuses** where
approval is required and the installation reads bindings with `legacy`
(`409 role_bindings_read_required`), and the API logs a warning at start when approval is not switched
off. Before upgrading a multi-tenant installation (where `OAX_LIFECYCLE_REQUIRE_APPROVAL=auto` is `on`)
either set `OAX_ROLE_BINDINGS_READ=bindings` (read "Before setting bindings with inheriting bindings
in place" in the changelog first) or set `OAX_LIFECYCLE_REQUIRE_APPROVAL=off` if there is no second person
to approve. Single-tenant installations are unaffected (`auto` is `off`).

## Version deprecation and rollback

`POST /v1/agents/{id}/versions/{version}/deprecate` (`agents:publish`, optional `{ "reason" }`) marks a
version deprecated: **new runs pinned to it are refused** (`409 version_deprecated`, decided at
admission under the agent row lock; runs that already exist are not touched; a cached "latest" that
turned out to be deprecated on another replica is read again). Deprecation cannot be undone, is stored
append-only (`agent_version_deprecations`) and is audited as `agent.version.deprecated`.

Deprecating the **latest** version is a **rollback**: `agents.latestVersion` goes back to the newest
other version that is not deprecated and, where approval is required for the agent today (the policy now;
`production-only` with the union of the use cases of the version left and the candidate), was published
under an approved review (`agent_versions.review_id`). A rollback creates no version, needs no approval
and is audited with `rollbackTo`. If no such version exists: `409 rollback_target_unapproved` (older
versions exist but none was published under approval, for example because they are from before S3), or
`409 no_rollback_target` (nothing else to go back to); disable the agent in both cases.
Deprecating an older version only marks it. After a rollback the version numbers stay ahead: the next
publish needs a higher version than every published one, and the content of a deprecated version cannot
be published again under its number (`409 version_deprecated`).

## Audit events

`agent.revision.created`, `agent.review.opened`, `agent.review.decided`, `agent.review.refused`
(rate-limited to one entry per review, user and code and minute), `agent.review.stale`,
`agent.review.comment` (ids, operation and length), `agent.review.thread_resolved`,
`agent.review.closed` (`withdrawn`, `rejected`, `published` with the version), `agent.published`
(version, digest, revision, review, approvers, policy, expansion and resolution digests),
`agent.publish.refused` (code, review; rate-limited), `agent.version.deprecated` (version, `rollbackTo`),
`tenant.lifecycle_policy_changed`. Names, ids and digests only: never comment text, never sources.

## Limits of this slice

- Agent rules are S8; notifications are S13; secret scopes and the concrete secret resolution are S4 (the
  resolution digest binds the names until then).
- The connection catalog behind the expansion digest is read just before the locks are taken (a
  connection change is not serialised with publish): a change after that read and before the commit is not
  seen by this publish. It can only matter for an approval that was bound to an older expansion, which
  the next publish refuses.
- A rollback target that was published under approval is not re-checked against today's approvers: the
  approval was valid when the version was published (the version keeps the record).
- Run admission sees a deprecation at once on the replica that deprecated; other replicas cache the
  latest version for up to 60 seconds, read it again as soon as it turns out to be deprecated, and refuse
  pinned runs at once (the check is in the database).
- Revert migration `0034_review_threads` before `0032_agent_lifecycle_reviews`: the thread tables
  reference the review tables.
- Directory-mapped bindings (S11) do not exist yet; the rule module already treats the mapping creator
  as the grantor, and rows of the other sources record who granted them. Bindings written before
  migration `0032` have an unknown grantor unless the audit chain shows who made them (see "Grantor:
  nobody versus unknown"); they do not make an approver by default.
- **Authors that are not users.** Every revision whose author is not a user (the upgrade and
  divergence revisions of `system`, and `repo`, even with an author id) makes the contributor set
  include everybody the audit chain shows editing the draft and the creator of the agent, until the Git
  slice (S12) maps signers to accounts.
- **Migration 0037 fails toward unknown.** After the upgrade, local accounts nobody is shown to have
  made (not the bootstrap administrator) and role or membership rows that the audit chain cannot
  prove are unknown creators or grantors: they cannot make an approver while
  `OAX_LIFECYCLE_UNKNOWN_GRANTOR=refuse` (the default), and they cannot loosen the lifecycle policy of a
  subtree that has an unfinished review. Repair a binding: an administrator whose own chain is known
  (the bootstrap administrator, a platform operator, a clean administrator) removes and adds it again
  (an unknown administrator re-granting spreads the unknown mark: the chain of the new row includes
  theirs). Repair an account with `creator_unknown`: recreate it, or, when the operator knows who made
  it, set `created_by` and `grant_chain` by SQL (`update users set creator_unknown = false, created_by =
  '<id>', grant_chain = array['<id>']::uuid[] where id = '<account>'`). Or set `allow` during the
  transition. The migration walks the chain of every existing row breadth first (six hops, the same line
  as the live walk: a seventh hop, or a link that is unknown, leaves the row unknown). **Links that were
  revoked, expired or deleted before the upgrade are not recoverable** by the backfill: it can only
  follow what exists then, so rows laundered before the upgrade stay clean; it builds a temporary index on `audit_log` (a SHARE lock:
  audit appends wait) and needs roughly 3 seconds per million audit entries plus a pass over the
  binding tables, measured on a small test VM; plan a short maintenance window on large audit chains.
- **S3 requires `OAX_ROLE_BINDINGS_READ=bindings`.** `assertNodeAuthority` returns before it takes the
  binding lock on the legacy read path, so the stored chain is only race-free (and the loosening
  guard only sees the whole tree) with the resolver path. Publish therefore refuses where approval is
  required on `legacy` (`409 role_bindings_read_required`), see "Publish: the approval gate".
- **Operator trust.** Changes to `OAX_LIFECYCLE_*` (including `UNKNOWN_GRANTOR=allow` and
  `REQUIRE_APPROVAL`) are made by whoever runs the installation, and `REQUIRE_APPROVAL=auto` turns approval
  off again when only one tenant is left (`installationDefaults`). These are operator-trust items: the
  rules above protect against contributors, not against the operator.
- **Still open from the S1 review (#343):** the platform-operator binding across organisations carries
  no grantor (7), information exposure of `grantedBy` and token ids to readers of the agent (9), database
  hardening such as truncate triggers and missing foreign keys (10), the start-up backfill running
  before the server listens (11) and the smaller items of (12).
- Eligibility is derived from the stored bindings (`tenant_role_bindings`, team and agent bindings),
  with the resolver the request path uses; role restrictions per node are not applied (as in the
  request path, until ADR 0014 S9).
- Shared demo accounts (`OAX_DEMO`) are ordinary accounts to these rules; do not enable approval
  requirements on a public demo.
