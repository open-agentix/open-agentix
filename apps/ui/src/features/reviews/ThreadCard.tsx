import { useState } from 'react';
import type { ReviewComment, ReviewThread } from '../../api/types';
import { Badge, Button } from '../../components/ui';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useI18n } from '../../i18n/i18n';
import { CommentForm } from './CommentForm';
import { Markdown } from './Markdown';
import type { ReviewActions } from './reviewActions';

function CommentItem({
  comment,
  thread,
  mine,
  open,
  name,
  actions,
}: {
  comment: ReviewComment;
  thread: ReviewThread;
  mine: boolean;
  open: boolean;
  name: string;
  actions: ReviewActions;
}) {
  const { t, fmt } = useI18n();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  return (
    <li className="comment">
      <div className="comment-head">
        <strong>{name}</strong>
        <time dateTime={comment.createdAt}>{fmt.relative(comment.createdAt)}</time>
        {comment.editedAt ? <span className="muted">{t('reviews.comment.edited')}</span> : null}
      </div>
      {comment.deleted ? (
        <p className="muted">{t('reviews.comment.deleted')}</p>
      ) : editing ? (
        <CommentForm
          label={t('reviews.comment.editLabel')}
          submitLabel={t('common.save')}
          initial={comment.body}
          onSubmit={(text) => actions.edit(thread.id, comment.id, text)}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <Markdown source={comment.body} />
      )}
      {mine && !comment.deleted && !editing ? (
        <div className="comment-actions">
          {open ? (
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              {t('common.edit')}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => setRemoving(true)}>
            {t('common.delete')}
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={removing}
        title={t('reviews.comment.deleteTitle')}
        confirmLabel={t('common.delete')}
        danger
        onClose={() => setRemoving(false)}
        onConfirm={() => actions.remove(thread.id, comment.id)}
      >
        <p>{t('reviews.comment.deleteText')}</p>
      </ConfirmDialog>
    </li>
  );
}

/** One thread: its comments, a reply box and the resolve control. */
export function ThreadCard({
  thread,
  open,
  meId,
  name,
  actions,
  context,
}: {
  thread: ReviewThread;
  open: boolean;
  meId: string | undefined;
  name: (id: string | null) => string;
  actions: ReviewActions;
  /** What the thread is about, for the heading ("Line 12", "Review"). */
  context: string;
}) {
  const { t } = useI18n();
  const [replying, setReplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = async () => {
    setError(null);
    try {
      await actions.setResolved(thread.id, !thread.resolved);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <article
      className={thread.resolved ? 'thread thread-resolved' : 'thread'}
      aria-label={t('reviews.thread.label', { context })}
      data-outdated={thread.outdated || undefined}
    >
      <div className="thread-head">
        <strong>{context}</strong>
        {thread.outdated ? <Badge tone="warning">{t('reviews.thread.outdated')}</Badge> : null}
        {thread.resolved ? (
          <Badge tone="success">
            {t('reviews.thread.resolvedBy', { name: name(thread.resolvedBy) })}
          </Badge>
        ) : null}
      </div>
      <ul className="comments">
        {thread.comments.map((c) => (
          <CommentItem
            key={c.id}
            comment={c}
            thread={thread}
            mine={c.authorId === meId}
            open={open}
            name={name(c.authorId)}
            actions={actions}
          />
        ))}
      </ul>
      {open ? (
        <div className="thread-actions">
          {replying ? (
            <CommentForm
              label={t('reviews.thread.replyLabel')}
              submitLabel={t('reviews.thread.reply')}
              onSubmit={(text) => actions.reply(thread.id, text)}
              onCancel={() => setReplying(false)}
            />
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setReplying(true)}>
              {t('reviews.thread.reply')}
            </Button>
          )}
          {thread.canResolve ? (
            <Button size="sm" variant="ghost" onClick={() => void toggle()}>
              {thread.resolved ? t('reviews.thread.reopen') : t('reviews.thread.resolve')}
            </Button>
          ) : null}
          {error ? (
            <p className="error-text" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
