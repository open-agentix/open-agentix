import type { Agent, Review } from '../../api/types';
import type { TKey } from '../../i18n/i18n';
import type { Tone } from '../../components/ui';

/** The status of an agent's development line, as shown in its badge (ADR 0017 section 3). */
export type LifecycleStatus =
  'in_development' | 'review_requested' | 'changes_requested' | 'approved' | 'published';

/**
 * An open review decides: its state is the status. Otherwise a draft that equals the latest
 * published version is `published`, and everything else (never published, edited since, or a
 * withdrawn or rejected review) is `in_development`. There is no break-glass status.
 */
export function lifecycleStatus(
  agent: Pick<Agent, 'status'>,
  review: Pick<Review, 'status' | 'state'> | null | undefined,
): LifecycleStatus {
  if (review?.status === 'open') {
    if (review.state === 'changes_requested') return 'changes_requested';
    if (review.state === 'approved') return 'approved';
    return 'review_requested';
  }
  return agent.status === 'published' ? 'published' : 'in_development';
}

export const STATUS_TONE: Record<LifecycleStatus, Tone> = {
  in_development: 'neutral',
  review_requested: 'info',
  changes_requested: 'warning',
  approved: 'success',
  published: 'accent',
};

export const STATUS_LABEL: Record<LifecycleStatus, TKey> = {
  in_development: 'reviews.status.in_development',
  review_requested: 'reviews.status.review_requested',
  changes_requested: 'reviews.status.changes_requested',
  approved: 'reviews.status.approved',
  published: 'reviews.status.published',
};

/** The open review of a list of reviews (newest first): at most one is open per agent. */
export function openReviewOf<R extends Pick<Review, 'status'>>(reviews: readonly R[]): R | null {
  return reviews.find((r) => r.status === 'open') ?? null;
}
