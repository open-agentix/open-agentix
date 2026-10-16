import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { myReviewsQuery } from '../../api/queries';
import { Badge, EmptyState, ErrorState, Loading, PageHeader, Section } from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import { useDocumentTitle } from '../../lib/hooks';
import { STATUS_TONE } from './lifecycleStatus';

/** The reviews waiting for you: open reviews you could decide right now. */
export function ReviewsInboxPage() {
  const { t, fmt } = useI18n();
  useDocumentTitle(t('reviews.inbox.title'));
  const inbox = useQuery(myReviewsQuery);
  return (
    <div className="page">
      <PageHeader title={t('reviews.inbox.title')} description={t('reviews.inbox.subtitle')} />
      {inbox.isPending ? <Loading /> : null}
      {inbox.isError ? (
        <ErrorState error={inbox.error} onRetry={() => void inbox.refetch()} />
      ) : null}
      {inbox.data && inbox.data.items.length === 0 ? (
        <EmptyState icon="check" title={t('reviews.inbox.empty')}>
          {t('reviews.inbox.emptyText')}
        </EmptyState>
      ) : null}
      {inbox.data && inbox.data.items.length > 0 ? (
        <Section>
          <ul className="plain-list inbox-list">
            {inbox.data.items.map((i) => (
              <li key={i.reviewId}>
                <Link
                  to="/agents/$agentId"
                  params={{ agentId: i.agentId }}
                  search={{ tab: 'review' }}
                >
                  {i.agentName}
                </Link>{' '}
                <Badge
                  tone={
                    STATUS_TONE[
                      i.state === 'approved'
                        ? 'approved'
                        : i.state === 'changes_requested'
                          ? 'changes_requested'
                          : 'review_requested'
                    ]
                  }
                >
                  {t(
                    `reviews.status.${i.state === 'approved' ? 'approved' : i.state === 'changes_requested' ? 'changes_requested' : 'review_requested'}`,
                  )}
                </Badge>{' '}
                <span className="muted">
                  {t('reviews.inbox.meta', {
                    revision: i.revisionSeq,
                    count: i.countedApprovals,
                    required: i.requiredApprovals,
                    when: fmt.relative(i.openedAt),
                  })}
                </span>
                {i.yourDecision ? (
                  <Badge>{t(`reviews.approvals.decision.${i.yourDecision}`)}</Badge>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}
