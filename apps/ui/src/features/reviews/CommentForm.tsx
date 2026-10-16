import { useState } from 'react';
import { Button, TextAreaField } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { failureText } from './reviewActions';

export const MAX_COMMENT_CHARS = 10_000;

/** A comment box: Markdown subset, a character counter, and the API's refusal shown in place. */
export function CommentForm({
  label,
  submitLabel,
  initial = '',
  onSubmit,
  onCancel,
}: {
  label: string;
  submitLabel: string;
  initial?: string;
  onSubmit: (text: string) => Promise<unknown>;
  onCancel?: () => void;
}) {
  const t = useT();
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const empty = text.trim().length === 0;
  const tooLong = text.length > MAX_COMMENT_CHARS;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(text);
      setText('');
      onCancel?.();
    } catch (e) {
      setError(failureText(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="comment-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <TextAreaField
        label={label}
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        error={tooLong ? t('reviews.errors.comment_too_long') : null}
        hint={
          <>
            {t('reviews.comment.hint')}{' '}
            <span aria-live="polite">
              {t('reviews.comment.counter', { count: text.length, max: MAX_COMMENT_CHARS })}
            </span>
          </>
        }
      />
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
      <div className="form-actions">
        <Button
          type="submit"
          variant="primary"
          size="sm"
          loading={busy}
          disabled={empty || tooLong}
        >
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
