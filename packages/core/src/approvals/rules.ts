import type { Role } from '../rbac.js';
import type { LifecyclePolicy } from '../tenancy/lifecycle-policy.js';

/**
 * The shared approval rule module (ADR 0017 section 5.1): who may approve a version of an agent.
 * Run-time approvals (W7-2) and version approvals (W6-3) adopt the same rules later, so this
 * module has no knowledge of agents, tables or HTTP: facts go in, a verdict comes out. Pure.
 *
 * Implemented here: A1 (a contributor never approves, in no role, with no credential, platform
 * admins included), A2 (distinct users), A3 (an approver role through a binding that covers the
 * agent), A4 (the qualifying binding was not granted by a contributor, directly or anywhere up its
 * grant chain, and no contributor made the account; a grantor that is unknown is refused unless the
 * installation allows it; there is no minimum age), A5 (an interactive session; tokens only when the tenant allows it; non-human actors
 * never), A6 (identity source), A7 (scope), A8 (the number of approvals) and A10 (the reviewer
 * saw the current revision). A9 (agent rules) arrives with slice S8.
 *
 * Order of the checks, which is the order of the refusal codes: A1 first, so that a contributor
 * gets `self_approval` whatever else is wrong with the request and learns nothing else; the content
 * check A10 comes last, so a caller who may not decide at all never learns the digest is stale.
 */

/** Where a qualifying binding comes from; `directory` is the third source of ADR 0017 S11. */
export type ApproverBindingSource =
  'mirror' | 'grant' | 'directory' | 'team' | 'agent' | 'platform';

/** One binding of the reviewer that covers the agent and gives `agents:approve` after restrictions. */
export interface ApproverBinding {
  /** Id of the row (`tenant_role_bindings.id`, `<team>:<user>:<role>` ...); recorded for audit. */
  id: string;
  role: Role;
  source: ApproverBindingSource;
  /**
   * The user who created the binding; for a directory binding the creator of the mapping. `null`
   * when no user did (the platform operator flag, an identity provider, the bootstrap), which can
   * never be a contributor.
   */
  grantedBy: string | null;
  /**
   * The grantor of the row is **unknown**, which is not the same as `grantedBy: null` ("nobody
   * granted it": an identity provider, the bootstrap, the platform operator flag). Rows from before
   * the grantor was recorded, mirror rows repaired by the reconcile and rows created by the
   * home-move trigger are unknown (ADR 0017 A4, finding 5 of the S1 review).
   */
  grantorUnknown?: boolean | undefined;
  /**
   * Everybody further up the grant chain of this binding: the accounts that created the grantor, the
   * grantors of the grantor's own administrator bindings, and so on (depth limited, see
   * `GrantChain`). The direct grantor is `grantedBy`; it is also listed here.
   */
  chain?: GrantChain | undefined;
}

/**
 * The users a binding or an account depends on, transitively. `unknown` is true when a link could
 * not be followed to a known end (an unknown grantor, or the depth limit was reached), so the
 * chain may hide a contributor.
 */
export interface GrantChain {
  users: readonly string[];
  unknown: boolean;
}

/** Who is deciding. Everything except `user` is a non-human actor and never approves (A5). */
export type ApproverActor = 'user' | 'repo' | 'node' | 'guest' | 'system';

export type ApproverAuth = { kind: 'session' } | { kind: 'token'; tokenId: string };

export interface ApproverFacts {
  userId: string;
  actor: ApproverActor;
  auth: ApproverAuth;
  /** `users.source`: `local`, `oidc` or `ldap`. */
  identitySource: string;
  /** The reviewer holds `agents:read` on the agent (A10). */
  canRead: boolean;
  /** Bindings of the reviewer that cover the agent and carry `agents:approve`; see {@link ApproverBinding}. */
  bindings: readonly ApproverBinding[];
  /** The reviewer is a member of the agent's team, or holds a binding on the agent itself. */
  inAgentTeam: boolean;
  /**
   * The accounts that created the reviewer, transitively (`users.created_by`). An account made by a
   * contributor is contributor-made: whoever it is bound by, it must not decide the review.
   */
  creatorChain?: GrantChain | undefined;
}

export interface ApprovalContext {
  /** User ids of every contributor of the review (see {@link collectContributors}). */
  contributors: ReadonlySet<string>;
  policy: Pick<
    LifecyclePolicy,
    | 'allowedApproverRoles'
    | 'allowTokenApprovals'
    | 'approverIdentitySources'
    | 'approverScope'
    | 'minApprovals'
  >;
  /**
   * What to do with a binding whose grantor is unknown, or whose grant chain cannot be followed to a
   * known end: `refuse` (default; fail closed) or `allow` (the installation accepts the risk until
   * the bindings have been granted again). Not a tenant policy key.
   */
  unknownGrantor?: 'refuse' | 'allow' | undefined;
  /** A10: what the reviewer says they saw and what the revision is now. */
  view: { expected: string; current: string };
}

export type RefusalCode =
  | 'self_approval'
  | 'actor_not_human'
  | 'token_approval_disabled'
  | 'identity_source_not_allowed'
  | 'cannot_read'
  | 'not_eligible'
  | 'binding_granted_by_contributor'
  | 'binding_grantor_unknown'
  | 'approver_scope'
  | 'stale_view';

/** HTTP status of each refusal (all refusals of who may decide are 403, a stale view is 409). */
export const REFUSAL_STATUS: Readonly<Record<RefusalCode, number>> = {
  self_approval: 403,
  actor_not_human: 403,
  token_approval_disabled: 403,
  identity_source_not_allowed: 403,
  cannot_read: 404,
  not_eligible: 403,
  binding_granted_by_contributor: 403,
  binding_grantor_unknown: 403,
  approver_scope: 403,
  stale_view: 409,
};

const MESSAGES: Readonly<Record<RefusalCode, string>> = {
  self_approval: 'you contributed to this review and cannot decide it',
  actor_not_human: 'only a person can decide a review',
  token_approval_disabled: 'decisions with an API token are not allowed for this tenant',
  identity_source_not_allowed: 'accounts of this identity source cannot decide reviews here',
  cannot_read: 'agent not found',
  not_eligible: 'your role is not an approver role for this agent',
  binding_granted_by_contributor:
    'the only bindings that make you an approver were granted by a contributor of this review',
  binding_grantor_unknown:
    'who granted the bindings that make you an approver cannot be established; an administrator has to grant them again',
  approver_scope: 'the tenant policy does not let you decide for this agent (approver scope)',
  stale_view: 'the draft changed since you loaded it',
};

export type Eligibility =
  { ok: true; via: ApproverBinding[] } | { ok: false; code: RefusalCode; message: string };

const refuse = (code: RefusalCode): Eligibility => ({ ok: false, code, message: MESSAGES[code] });

/**
 * Decides whether one reviewer may decide the review under the facts and the policy. Never throws,
 * and an unknown value (an unrecognised actor kind, an empty binding list) refuses.
 */
export function checkApprover(f: ApproverFacts, ctx: ApprovalContext): Eligibility {
  // A1: no contributor, in any role, with any credential, platform admin included. Not configurable.
  if (ctx.contributors.has(f.userId)) return refuse('self_approval');
  // A5: a person with a session; tokens only when the tenant allows them.
  if (f.actor !== 'user') return refuse('actor_not_human');
  if (f.auth.kind === 'token' && !ctx.policy.allowTokenApprovals)
    return refuse('token_approval_disabled');
  // A6
  if (!(ctx.policy.approverIdentitySources as readonly string[]).includes(f.identitySource))
    return refuse('identity_source_not_allowed');
  // A10 (read side): a reviewer who cannot read the agent does not know it exists.
  if (!f.canRead) return refuse('cannot_read');
  // A3: an approver role through a binding that covers the agent.
  const allowed = f.bindings.filter((b) =>
    (ctx.policy.allowedApproverRoles as readonly string[]).includes(b.role),
  );
  if (allowed.length === 0) return refuse('not_eligible');
  // A4: not through bindings that a contributor granted, directly or further up the chain, and not
  // as an account a contributor made (a contributor with grant rights must not be able to create an
  // approver, not even through a second account). Bindings nobody granted (`grantedBy: null` and not
  // unknown) are not contributor-made. A link that cannot be followed fails closed.
  const mayRelyOnUnknown = ctx.unknownGrantor === 'allow';
  const touched = (c: GrantChain | undefined) =>
    (c?.users ?? []).some((u) => ctx.contributors.has(u));
  const unknownIn = (c: GrantChain | undefined) => c?.unknown === true;
  if (touched(f.creatorChain)) return refuse('binding_granted_by_contributor');
  const clean = allowed.filter(
    (b) => !(b.grantedBy !== null && ctx.contributors.has(b.grantedBy)) && !touched(b.chain),
  );
  if (clean.length === 0) return refuse('binding_granted_by_contributor');
  const known = mayRelyOnUnknown
    ? clean
    : clean.filter(
        (b) => b.grantorUnknown !== true && !unknownIn(b.chain) && !unknownIn(f.creatorChain),
      );
  if (known.length === 0) return refuse('binding_grantor_unknown');
  // A7
  if (ctx.policy.approverScope === 'team' && !f.inAgentTeam) return refuse('approver_scope');
  if (ctx.policy.approverScope === 'other-team' && f.inAgentTeam) return refuse('approver_scope');
  // A10: the digest the reviewer saw is the digest of the revision now.
  if (ctx.view.expected !== ctx.view.current) return refuse('stale_view');
  return { ok: true, via: [...known] };
}

/** Every user who counts as a contributor of a review (ADR 0017 section 2). */
export interface ContributorSources {
  /** Authors of the revisions since the base version up to the reviewed revision. */
  revisionAuthors: readonly { authorId: string | null; authorKind: string }[];
  /** The user who opened the review. */
  opener: string;
  /**
   * Users who edited the draft according to the audit chain, used when a revision has no known
   * author (the upgrade revision, `authorKind` `system`): an unknown author counts as every one of
   * them (best effort, ADR 0017 section 4.1).
   */
  unknownAuthorFallback: readonly string[];
  /** The creator of the agent: counted whenever an author is unknown. */
  agentCreator?: string | null | undefined;
  /** Platform users linked to the signing keys of contributing commits (slice S12). */
  linkedSigners?: readonly string[] | undefined;
}

export function collectContributors(src: ContributorSources): Set<string> {
  const out = new Set<string>([src.opener]);
  let unknown = false;
  for (const r of src.revisionAuthors) {
    if (r.authorKind === 'user' && r.authorId) out.add(r.authorId);
    // Every other author kind is unknown until the Git slice (S12) maps signers to users: a `repo`
    // revision with an author id still names no platform user, so it must not be skipped.
    else unknown = true;
  }
  if (unknown) {
    for (const u of src.unknownAuthorFallback) out.add(u);
    if (src.agentCreator) out.add(src.agentCreator);
  }
  for (const s of src.linkedSigners ?? []) out.add(s);
  return out;
}

/** One stored decision, as far as counting needs it. */
export interface DecisionFact {
  id: string;
  reviewerId: string;
  decision: 'approve' | 'request_changes' | 'reject';
  revisionId: string;
  decidedAt: Date;
  /** Only approvals expire. */
  expiresAt: Date | null;
}

export interface DecisionSummary {
  /** Distinct reviewers whose latest decision on the head revision is a valid approval (A2). */
  approvers: string[];
  /** Distinct reviewers whose latest decision on the head revision is `request_changes`. */
  changesRequested: string[];
  /** Latest approvals that do not count, with the reason. */
  stale: { decisionId: string; reviewerId: string; reason: 'revision_changed' | 'expired' }[];
}

/**
 * Summarises the decisions of a review for its head revision. A reviewer's **latest** decision
 * wins (they may change their mind); an approval counts only for the head revision and only while
 * it has not expired; approvals and change requests on an older revision are listed as stale, never
 * counted (A2: one reviewer counts once whatever roles they hold).
 */
export function summariseDecisions(
  decisions: readonly DecisionFact[],
  headRevisionId: string,
  now: Date,
): DecisionSummary {
  const latest = new Map<string, DecisionFact>();
  for (const d of [...decisions].sort(
    (a, b) => a.decidedAt.getTime() - b.decidedAt.getTime() || a.id.localeCompare(b.id),
  ))
    latest.set(d.reviewerId, d);
  const out: DecisionSummary = { approvers: [], changesRequested: [], stale: [] };
  for (const d of latest.values()) {
    if (d.revisionId !== headRevisionId) {
      if (d.decision !== 'reject')
        out.stale.push({ decisionId: d.id, reviewerId: d.reviewerId, reason: 'revision_changed' });
      continue;
    }
    if (d.decision === 'request_changes') out.changesRequested.push(d.reviewerId);
    else if (d.decision === 'approve') {
      if (d.expiresAt && d.expiresAt.getTime() <= now.getTime())
        out.stale.push({ decisionId: d.id, reviewerId: d.reviewerId, reason: 'expired' });
      else out.approvers.push(d.reviewerId);
    }
  }
  out.approvers.sort();
  out.changesRequested.sort();
  return out;
}

/** A8: the number of approvals a review needs; the maximum of the policy and every rule. */
export function requiredApprovals(
  policyMin: number,
  ruleMins: readonly number[] = [],
  max = 5,
): number {
  const n = Math.max(policyMin, ...ruleMins);
  return Math.min(Math.max(Number.isFinite(n) ? Math.trunc(n) : 1, 1), max);
}

export type ReviewState = 'review_requested' | 'changes_requested' | 'approved';

/** The state of an open review, computed and never stored as a free flag. */
export function reviewState(summary: DecisionSummary, required: number): ReviewState {
  if (summary.changesRequested.length > 0) return 'changes_requested';
  return summary.approvers.length >= required ? 'approved' : 'review_requested';
}
