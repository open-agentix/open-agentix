import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError, call } from '../../api/client';
import { agentReviewsQuery, reviewChangesQuery, reviewThreadsQuery } from '../../api/queries';
import type { Agent, Review } from '../../api/types';
import { meQuery, useCan } from '../../auth/auth';
import { Button, EmptyState, ErrorState, Loading, Section } from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import { DecisionBar } from './DecisionBar';
import { openReviewOf } from './lifecycleStatus';
import { ReviewDiff } from './ReviewDiff';
import { ReviewHeader } from './ReviewHeader';
import { failureText, useReviewActions } from './reviewActions';
import { SemanticSummary } from './SemanticSummary';
import { GeneralThreads, OutdatedThreads } from './ThreadsPanel';
import { usePeople } from './usePeople';

function RequestReview({ agent }: { agent: Agent }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const can = useCan();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const request = async () => {
    setBusy(true);
    setError(null);
    try {
      await call(api.POST('/v1/agents/{id}/reviews', { params: { path: { id: agent.id } } }));
      await queryClient.invalidateQueries({ queryKey: ['agents', agent.id] });
      await queryClient.invalidateQueries({ queryKey: ['reviews', 'inbox'] });
    } catch (e) {
      setError(failureText(e, t));
    } finally {
      setBusy(false);
    }
  };
  const allowed = can('agents:write') && agent.status !== 'published';
  return (
    <EmptyState
      icon="shield"
      title={t('reviews.none.title')}
      action={
        allowed ? (
          <Button variant="primary" loading={busy} onClick={() => void request()}>
            {t('reviews.none.request')}
          </Button>
        ) : undefined
      }
    >
      {agent.status === 'published' ? t('reviews.none.nothingToReview') : t('reviews.none.text')}
      {error ? (
        <span className="error-text" role="alert">
          {' '}
          {error}
        </span>
      ) : null}
    </EmptyState>
  );
}

function ReviewBody({ agent, review }: { agent: Agent; review: Review }) {
  const { t } = useI18n();
  const can = useCan();
  const me = useQuery(meQuery).data?.user.id;
  const changes = useQuery(reviewChangesQuery(agent.id, review.id));
  const canComment = can('agents:review');
  const threads = useQuery({ ...reviewThreadsQuery(agent.id, review.id), enabled: canComment });
  const name = usePeople(agent.id, review.id);
  const actions = useReviewActions(agent.id, review.id);
  const open = review.status === 'open';
  const items = threads.data?.items ?? [];
  const shared = { open, meId: me, name, actions };
  return (
    <div className="review">
      <ReviewHeader
        agent={agent}
        review={review}
        name={name}
        canWithdraw={review.openedBy === me || can('settings:write')}
        actions={actions}
      />
      {open ? (
        <DecisionBar
          review={review}
          approverScope={changes.data?.policy.approverScope}
          teamName={agent.ownerTeam?.name}
          actions={actions}
        />
      ) : null}
      {changes.isPending ? <Loading /> : null}
      {changes.isError ? (
        <ErrorState error={changes.error} onRetry={() => void changes.refetch()} />
      ) : null}
      {changes.data ? (
        <>
          <SemanticSummary changes={changes.data} />
          <Section title={t('reviews.diff.title', { revision: changes.data.revision.seq })}>
            <ReviewDiff
              base={changes.data.base?.source ?? ''}
              head={changes.data.headSource}
              revisionId={changes.data.revision.id}
              threads={items}
              {...shared}
            />
          </Section>
        </>
      ) : null}
      {!canComment || (threads.error instanceof ApiError && threads.error.status === 403) ? (
        <p className="muted">{t('reviews.threads.noAccess')}</p>
      ) : threads.isError ? (
        <ErrorState error={threads.error} onRetry={() => void threads.refetch()} />
      ) : (
        <>
          <GeneralThreads
            threads={items.filter((x) => !x.anchor)}
            canComment={canComment}
            {...shared}
          />
          <OutdatedThreads threads={items.filter((x) => x.anchor && x.outdated)} {...shared} />
        </>
      )}
    </div>
  );
}

/** The Review tab of an agent: its open review, or the latest closed one, or a way to ask for one. */
export function ReviewTab({ agent }: { agent: Agent }) {
  const reviews = useQuery(agentReviewsQuery(agent.id));
  if (reviews.isPending) return <Loading />;
  if (reviews.isError)
    return <ErrorState error={reviews.error} onRetry={() => void reviews.refetch()} />;
  const review = openReviewOf(reviews.data.items) ?? reviews.data.items[0] ?? null;
  return review ? <ReviewBody agent={agent} review={review} /> : <RequestReview agent={agent} />;
}
