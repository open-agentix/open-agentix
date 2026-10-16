import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, call } from '../../api/client';
import type { DecisionKind, Review } from '../../api/types';
import { errorMessage } from '../../components/ui';
import type { TFunction } from '../../i18n/i18n';
import { errorKey } from './decisionReasons';

export interface LineAnchor {
  side: 'base' | 'head';
  line: number;
  revisionId?: string;
}

/** A message for an API failure of a review action: our text for the codes we know, else the API's. */
export function failureText(e: unknown, t: TFunction): string {
  const key = e instanceof ApiError ? errorKey(e.code) : null;
  return key ? t(key) : errorMessage(e);
}

/** Every write of the review tab. A successful write refreshes the agent's review data and the inbox. */
export function useReviewActions(agentId: string, reviewId: string) {
  const queryClient = useQueryClient();
  const id = { id: reviewId };
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['agents', agentId, 'reviews'] }),
      queryClient.invalidateQueries({ queryKey: ['reviews', 'inbox'] }),
    ]);
  };
  const run = async (action: Promise<unknown>) => {
    try {
      await action;
    } finally {
      await refresh();
    }
  };
  return {
    startThread: (body: string, anchor?: LineAnchor) =>
      run(
        call(
          api.POST('/v1/reviews/{id}/threads', {
            params: { path: id },
            body: anchor ? { body, anchor } : { body },
          }),
        ),
      ),
    reply: (tid: string, body: string) =>
      run(
        call(
          api.POST('/v1/reviews/{id}/threads/{tid}/comments', {
            params: { path: { ...id, tid } },
            body: { body },
          }),
        ),
      ),
    edit: (tid: string, cid: string, body: string) =>
      run(
        call(
          api.PATCH('/v1/reviews/{id}/threads/{tid}/comments/{cid}', {
            params: { path: { ...id, tid, cid } },
            body: { body },
          }),
        ),
      ),
    remove: (tid: string, cid: string) =>
      run(
        call(
          api.DELETE('/v1/reviews/{id}/threads/{tid}/comments/{cid}', {
            params: { path: { ...id, tid, cid } },
          }),
        ),
      ),
    setResolved: (tid: string, resolved: boolean) =>
      run(
        call(
          api.PATCH('/v1/reviews/{id}/threads/{tid}', {
            params: { path: { ...id, tid } },
            body: { resolved },
          }),
        ),
      ),
    /** Binds the decision to every digest of the review the reviewer is looking at. */
    decide: (review: Review, decision: DecisionKind, comment: string) =>
      run(
        call(
          api.POST('/v1/reviews/{id}/decisions', {
            params: { path: id },
            body: {
              decision,
              expectedDigest: review.revision.digest,
              expectedExpansionDigest: review.digests.expansionDigest,
              expectedResolutionDigest: review.digests.resolutionDigest,
              expectedPolicyDigest: review.digests.policyDigest,
              ...(comment.trim() ? { comment: comment.trim() } : {}),
            },
          }),
        ),
      ),
    withdraw: () => run(call(api.POST('/v1/reviews/{id}/withdraw', { params: { path: id } }))),
  };
}

export type ReviewActions = ReturnType<typeof useReviewActions>;
