import { useState } from 'react';
import type { Agent, Review, ReviewApproval } from '../../api/types';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Badge, Button, KeyValue, Section } from '../../components/ui';
import { useI18n, type TKey } from '../../i18n/i18n';
import { LifecycleBadge } from './LifecycleBadge';
import { Markdown } from './Markdown';
import type { ReviewActions } from './reviewActions';

const STALE_KEYS: Record<string, TKey> = {
  revision_changed: 'reviews.approvals.stale.revision_changed',
  superseded: 'reviews.approvals.stale.superseded',
  expired: 'reviews.approvals.stale.expired',
  expansion_changed: 'reviews.approvals.stale.expansion_changed',
  secret_resolution_changed: 'reviews.approvals.stale.secret_resolution_changed',
};

function ApprovalRow({ a, name }: { a: ReviewApproval; name: string }) {
  const { t, fmt } = useI18n();
  const reasons = a.reasons.map((r) => t(STALE_KEYS[r] ?? 'reviews.approvals.stale.not_eligible'));
  return (
    <li>
      <strong>{name}</strong> · {t(`reviews.approvals.decision.${a.decision}`)} ·{' '}
      <time dateTime={a.decidedAt}>{fmt.relative(a.decidedAt)}</time>{' '}
      {a.decision === 'approve' ? (
        a.counted ? (
          <Badge tone="success">{t('reviews.approvals.counted')}</Badge>
        ) : (
          <Badge tone="warning">{t('reviews.approvals.notCounted')}</Badge>
        )
      ) : null}
      {reasons.length ? <span className="muted"> {reasons.join(', ')}</span> : null}
      {a.comment ? <Markdown source={a.comment} /> : null}
    </li>
  );
}

/** Who asked for the review, against what, how many approvals it needs and how it stands. */
export function ReviewHeader({
  agent,
  review,
  name,
  canWithdraw,
  actions,
}: {
  agent: Agent;
  review: Review;
  name: (id: string | null) => string;
  canWithdraw: boolean;
  actions: ReviewActions;
}) {
  const { t, fmt } = useI18n();
  const [withdrawing, setWithdrawing] = useState(false);
  const counted = review.approvals.filter((a) => a.counted && a.decision === 'approve').length;
  return (
    <Section
      title={t('reviews.header.title')}
      actions={
        review.status === 'open' && canWithdraw ? (
          <Button size="sm" variant="ghost" onClick={() => setWithdrawing(true)}>
            {t('reviews.header.withdraw')}
          </Button>
        ) : undefined
      }
    >
      <div className="review-state">
        <LifecycleBadge agent={agent} review={review} />
        {review.status !== 'open' ? <Badge>{t(`reviews.closed.${review.status}`)}</Badge> : null}
      </div>
      <KeyValue
        items={[
          [
            t('reviews.header.requestedBy'),
            `${name(review.openedBy)} · ${fmt.relative(review.openedAt)}`,
          ],
          [
            t('reviews.header.base'),
            review.baseVersion ? `v${review.baseVersion.version}` : t('reviews.header.noBase'),
          ],
          [t('reviews.header.revision'), `#${review.revision.seq}`],
          [
            t('reviews.header.approvals'),
            t('reviews.header.approvalsOf', { count: counted, required: review.requiredApprovals }),
          ],
          [
            t('reviews.header.required'),
            review.approvalRequired
              ? t('reviews.header.requiredYes')
              : t('reviews.header.requiredNo'),
          ],
        ]}
      />
      {review.unknownAuthor ? <p className="muted">{t('reviews.header.unknownAuthor')}</p> : null}
      {review.approvals.length ? (
        <>
          <h3>{t('reviews.approvals.title')}</h3>
          <ul className="plain-list">
            {review.approvals.map((a) => (
              <ApprovalRow key={a.id} a={a} name={name(a.reviewerId)} />
            ))}
          </ul>
        </>
      ) : null}
      <ConfirmDialog
        open={withdrawing}
        title={t('reviews.header.withdrawTitle')}
        confirmLabel={t('reviews.header.withdraw')}
        danger
        onClose={() => setWithdrawing(false)}
        onConfirm={() => actions.withdraw()}
      >
        <p>{t('reviews.header.withdrawText')}</p>
      </ConfirmDialog>
    </Section>
  );
}
