# Agent lifecycle: revisions, reviews and approval records

Design: [ADR 0017](adr/0017-agent-lifecycle-governance.md), slices S1 (#244) and S2 (#245).
**Status: shadow mode, with the console.** Drafts get revisions, reviews can be opened and decided,
approval records bind a decision to exact content, the tenant policy exists, and the console has a
Review tab with comment threads, a decision bar and status badges. **Publishing is not yet refused
without an approval** (slice S3 enforces it); until then the publish response and the audit entry
report what publish *would* have been refused for. Agent rules, secret scopes and review via Git are
later slices.

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
| Shadow report of publish | `shadow` in the response of `POST /v1/agents/{id}/publish` and in the audit entry `agent.published` |
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
| A4 | The qualifying binding was **not granted by a contributor** (`granted_by`; for a directory mapping the creator of the mapping). There is no minimum age. A change that widens a binding (another role, `inherit`, a later expiry) counts as a new grant by the person who made it. | `403 binding_granted_by_contributor` |
| A5 | A person with an interactive session. API tokens only when the tenant sets `allowTokenApprovals`. Non-human actors (`repo:*`, `node:*`, guests, the system) never. | `403 token_approval_disabled`, `403 actor_not_human` |
| A6 | `approverIdentitySources` limits which accounts count (`local`, `oidc`, `ldap`). | `403 identity_source_not_allowed` |
| A7 | `approverScope`: `tenant`, `team` (members of the agent's team only) or `other-team` (not members). | `403 approver_scope` |
| A8 | `minApprovals` distinct approvals (default 1, at most 5). | state stays `review_requested` |
| A10 | The reviewer can read the agent and decided on the digest of the current revision. A reviewer who cannot read the agent gets 404; the stale check comes last, so an ineligible caller never learns that the digest is stale. | `404`, `409 stale_view` |

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

## Shadow mode of publish

`POST /v1/agents/{id}/publish` behaves as before and adds `shadow`:

```json
{ "enforced": false, "approvalRequired": true, "wouldRefuse": true, "reviewId": null,
  "state": null, "reasons": [{ "code": "no_review", "message": "..." }] }
```

`wouldRefuse` is true when the policy requires an approval for this agent (`production-only` uses the
union of the published version's and the draft's use case) and there is no open review, or it is not
`approved` (`approval_insufficient`, `changes_requested`). The same object is in the audit entry
`agent.published`, together with the id of the revision the version was published from
(`agent_versions.revision_id`). A failure of the check is logged and never breaks a publish. Publish
also reads the draft again under the agent lock now and answers `409 draft_changed` if a save slipped in
while it was checking.

## Audit events

`agent.revision.created`, `agent.review.opened`, `agent.review.decided`, `agent.review.refused`
(rate-limited to one entry per review, user and code and minute), `agent.review.stale`,
`agent.review.comment` (ids, operation and length), `agent.review.thread_resolved`,
`agent.review.closed` (`withdrawn`, `rejected`), `tenant.lifecycle_policy_changed`, and the `shadow`
and `revision` fields of `agent.published`. Names, ids and digests only: never comment text, never
sources.

## Limits of this slice

- Publish is not refused (slice S3); agent rules are S8; notifications are S13.
- Revert migration `0033_review_threads` before `0032_agent_lifecycle_reviews`: the thread tables
  reference the review tables.
- Directory-mapped bindings (S11) do not exist yet; the rule module already treats the mapping creator
  as the grantor, and rows of the other sources record who granted them. Bindings written before
  migration `0032` have no recorded grantor for teams and agents (`NULL`: not a contributor).
- Eligibility is derived from the stored bindings (`tenant_role_bindings`, team and agent bindings),
  with the resolver the request path uses; role restrictions per node are not applied (as in the
  request path, until ADR 0014 S9).
- Shared demo accounts (`OAX_DEMO`) are ordinary accounts to these rules; do not enable approval
  requirements on a public demo.
