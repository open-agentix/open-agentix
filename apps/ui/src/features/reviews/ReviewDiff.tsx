import { useMemo, useState } from 'react';
import type { ReviewThread } from '../../api/types';
import { useI18n } from '../../i18n/i18n';
import { diffLines, diffStats, type DiffLine } from '../../lib/diff';
import { Button } from '../../components/ui';
import { CommentForm } from './CommentForm';
import type { ReviewActions } from './reviewActions';
import { ThreadCard } from './ThreadCard';
import { anchorOfLine, placeThreads } from './threadPlacement';

interface Shared {
  open: boolean;
  meId: string | undefined;
  name: (id: string | null) => string;
  actions: ReviewActions;
}

function Mark({ line }: { line: DiffLine }) {
  const { t } = useI18n();
  if (line.type === 'same') return <span className="diff-mark"> </span>;
  const added = line.type === 'add';
  return (
    <span className="diff-mark">
      <span aria-hidden="true">{added ? '+' : '−'}</span>
      <span className="sr-only">
        {added ? t('agents.diff.addedLine') : t('agents.diff.removedLine')}
      </span>
    </span>
  );
}

/**
 * The diff of the base version against the reviewed revision, with the comment threads under
 * their lines. Changed lines have a button to start a thread; the diff is a list, so a screen
 * reader announces every line with its number and whether it was added or removed.
 */
export function ReviewDiff({
  base,
  head,
  revisionId,
  threads,
  ...shared
}: Shared & { base: string; head: string; revisionId: string; threads: ReviewThread[] }) {
  const { t } = useI18n();
  const lines = useMemo(() => diffLines(base, head), [base, head]);
  const placement = useMemo(() => placeThreads(lines, threads), [lines, threads]);
  const [composing, setComposing] = useState<number | null>(null);
  const stats = diffStats(lines);
  if (stats.added === 0 && stats.removed === 0)
    return <p className="muted">{t('agents.diff.identical')}</p>;
  return (
    <figure className="diff review-diff">
      <figcaption>
        <span className="diff-add-text">{t('agents.diff.added', { count: stats.added })}</span>,{' '}
        <span className="diff-del-text">{t('agents.diff.removed', { count: stats.removed })}</span>
      </figcaption>
      <ol className="diff-body review-diff-body" aria-label={t('reviews.diff.label')}>
        {lines.map((l, i) => {
          const anchor = anchorOfLine(l);
          const commentable = shared.open && l.type !== 'same' && anchor !== null;
          const commentLabel = anchor
            ? t(
                l.type === 'del' ? 'reviews.diff.commentOnRemoved' : 'reviews.diff.commentOnAdded',
                {
                  line: anchor.line,
                },
              )
            : '';
          return (
            <li key={i} className="review-diff-item">
              <div className={`diff-line diff-${l.type} review-diff-line`}>
                <span className="diff-no" aria-hidden="true">
                  {l.oldNo ?? ''}
                </span>
                <span className="diff-no" aria-hidden="true">
                  {l.newNo ?? ''}
                </span>
                <Mark line={l} />
                <span className="diff-text">{l.text || ' '}</span>
                {commentable ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="diff-comment-btn"
                    aria-label={commentLabel}
                    onClick={() => setComposing(composing === i ? null : i)}
                  >
                    {t('reviews.diff.comment')}
                  </Button>
                ) : null}
              </div>
              {composing === i && anchor ? (
                <div className="diff-thread">
                  <CommentForm
                    label={commentLabel}
                    submitLabel={t('reviews.diff.startThread')}
                    onSubmit={(text) =>
                      shared.actions.startThread(
                        text,
                        anchor.side === 'head' ? { ...anchor, revisionId } : anchor,
                      )
                    }
                    onCancel={() => setComposing(null)}
                  />
                </div>
              ) : null}
              {(placement.byLine.get(i) ?? []).map((th) => (
                <div key={th.id} className="diff-thread">
                  <ThreadCard
                    thread={th}
                    context={t('reviews.thread.line', { line: th.anchor?.line ?? 0 })}
                    {...shared}
                  />
                </div>
              ))}
            </li>
          );
        })}
      </ol>
    </figure>
  );
}
