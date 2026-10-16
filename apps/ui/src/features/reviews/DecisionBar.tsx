import { useId, useState } from 'react';
import type { DecisionKind, Review } from '../../api/types';
import { Button, TextAreaField } from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import { ineligibility } from './decisionReasons';
import { failureText, type ReviewActions } from './reviewActions';

const KINDS: {
  kind: DecisionKind;
  label: 'approve' | 'requestChanges' | 'reject';
  needsComment: boolean;
}[] = [
  { kind: 'approve', label: 'approve', needsComment: false },
  { kind: 'request_changes', label: 'requestChanges', needsComment: true },
  { kind: 'reject', label: 'reject', needsComment: true },
];

/**
 * Approve, request changes or reject. When the caller may not decide, the buttons are disabled
 * and the reason is written next to them (and linked with `aria-describedby`), so that nobody has
 * to guess. The server decides again with the digests of what was on screen.
 */
export function DecisionBar({
  review,
  approverScope,
  teamName,
  actions,
}: {
  review: Review;
  approverScope: 'tenant' | 'team' | 'other-team' | undefined;
  teamName: string | undefined;
  actions: ReviewActions;
}) {
  const { t } = useI18n();
  const reasonId = useId();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<DecisionKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const reason = ineligibility(review, approverScope);
  const submit = async (kind: DecisionKind) => {
    setBusy(kind);
    setError(null);
    setDone(null);
    try {
      await actions.decide(review, kind, comment);
      setComment('');
      setDone(t(`reviews.decision.done.${kind}`));
    } catch (e) {
      setError(failureText(e, t));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="decision-bar card" role="region" aria-label={t('reviews.decision.title')}>
      <h2>{t('reviews.decision.title')}</h2>
      {reason ? (
        <p id={reasonId} className="decision-reason" role="note">
          {t(reason.key, { team: teamName ?? t('reviews.decision.thisTeam') })}
          {reason.scope === 'team'
            ? ` ${t('reviews.decision.scopeTeam', { team: teamName ?? t('reviews.decision.thisTeam') })}`
            : ''}
          {reason.scope === 'other-team'
            ? ` ${t('reviews.decision.scopeOtherTeam', { team: teamName ?? t('reviews.decision.thisTeam') })}`
            : ''}
        </p>
      ) : null}
      <TextAreaField
        label={t('reviews.decision.comment')}
        hint={t('reviews.decision.commentHint')}
        rows={3}
        value={comment}
        disabled={reason !== null}
        onChange={(e) => setComment(e.target.value)}
      />
      <div className="form-actions">
        {KINDS.map(({ kind, label, needsComment }) => (
          <Button
            key={kind}
            variant={kind === 'approve' ? 'primary' : kind === 'reject' ? 'danger' : 'secondary'}
            loading={busy === kind}
            disabled={reason !== null || busy !== null || (needsComment && comment.trim() === '')}
            aria-describedby={reason ? reasonId : undefined}
            onClick={() => void submit(kind)}
          >
            {t(`reviews.decision.${label}`)}
          </Button>
        ))}
      </div>
      <div aria-live="polite">
        {done ? <p className="success-text">{done}</p> : null}
        {error ? (
          <p className="error-text" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
