import type { Review } from '../../api/types';
import type { TKey } from '../../i18n/i18n';

/** Why somebody may not decide a review: the refusal code of the API rules to a message key. */
const REASON: Record<string, TKey> = {
  self_approval: 'reviews.decision.reasons.self_approval',
  not_eligible: 'reviews.decision.reasons.not_eligible',
  binding_granted_by_contributor: 'reviews.decision.reasons.binding_granted_by_contributor',
  token_approval_disabled: 'reviews.decision.reasons.token_approval_disabled',
  actor_not_human: 'reviews.decision.reasons.actor_not_human',
  identity_source_not_allowed: 'reviews.decision.reasons.identity_source_not_allowed',
  approver_scope: 'reviews.decision.reasons.approver_scope',
  cannot_read: 'reviews.decision.reasons.cannot_read',
};

export interface Ineligibility {
  key: TKey;
  /** `approver_scope`: the scope of the tenant and the team it refers to. */
  scope?: 'team' | 'other-team';
}

/** The reason to show in the decision bar, or `null` when the caller may decide. */
export function ineligibility(
  review: Pick<Review, 'status' | 'you'>,
  approverScope: 'tenant' | 'team' | 'other-team' | undefined,
): Ineligibility | null {
  if (review.status !== 'open') return { key: 'reviews.decision.reasons.closed' };
  if (review.you.eligible) return null;
  const code = review.you.code ?? '';
  if (code === 'approver_scope' && (approverScope === 'team' || approverScope === 'other-team'))
    return { key: REASON['approver_scope']!, scope: approverScope };
  return { key: REASON[code] ?? 'reviews.decision.reasons.unknown' };
}

/** Message key for an API error code of a decision or a comment. */
export function errorKey(code: string): TKey | null {
  const map: Record<string, TKey> = {
    stale_view: 'reviews.errors.stale_view',
    review_closed: 'reviews.errors.review_closed',
    thread_limit_reached: 'reviews.errors.thread_limit_reached',
    author_comment_budget_reached: 'reviews.errors.author_comment_budget_reached',
    review_comment_budget_reached: 'reviews.errors.review_comment_budget_reached',
    comment_limit_reached: 'reviews.errors.comment_limit_reached',
    comment_too_long: 'reviews.errors.comment_too_long',
    rate_limited: 'reviews.errors.rate_limited',
    anchor_invalid: 'reviews.errors.anchor_invalid',
    comment_deleted: 'reviews.errors.comment_deleted',
    review_open: 'reviews.errors.review_open',
    nothing_to_review: 'reviews.errors.nothing_to_review',
  };
  return map[code] ?? null;
}
