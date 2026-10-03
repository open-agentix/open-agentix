import { useMemo } from 'react';
import { useT } from '../../i18n/i18n';
import { diffLines, diffStats } from '../../lib/diff';

export function DiffView({
  before,
  after,
  label,
}: {
  before: string;
  after: string;
  label: string;
}) {
  const t = useT();
  const lines = useMemo(() => diffLines(before, after), [before, after]);
  const stats = diffStats(lines);
  if (stats.added === 0 && stats.removed === 0) {
    return <p className="muted">{t('agents.diff.identical')}</p>;
  }
  return (
    <figure className="diff">
      <figcaption>
        {label} ·{' '}
        <span className="diff-add-text">{t('agents.diff.added', { count: stats.added })}</span>,{' '}
        <span className="diff-del-text">{t('agents.diff.removed', { count: stats.removed })}</span>
      </figcaption>
      <pre className="diff-body" tabIndex={0}>
        {lines.map((l, i) => (
          <div key={i} className={`diff-line diff-${l.type}`}>
            <span className="diff-no" aria-hidden="true">
              {l.oldNo ?? ''}
            </span>
            <span className="diff-no" aria-hidden="true">
              {l.newNo ?? ''}
            </span>
            <span className="diff-mark">
              {l.type === 'add' ? (
                <>
                  <span aria-hidden="true">+</span>
                  <span className="sr-only">{t('agents.diff.addedLine')}</span>
                </>
              ) : l.type === 'del' ? (
                <>
                  <span aria-hidden="true">−</span>
                  <span className="sr-only">{t('agents.diff.removedLine')}</span>
                </>
              ) : (
                ' '
              )}
            </span>
            <span className="diff-text">{l.text || ' '}</span>
          </div>
        ))}
      </pre>
    </figure>
  );
}
