import type { ReactNode } from 'react';
import { useT } from '../i18n/i18n';
import { useMediaQuery } from '../lib/hooks';
import { VirtualTable, type Column } from './VirtualTable';
import { Spinner } from './ui';

/** Phones get card rows (not hidden columns) at or below this width. */
export const PHONE_QUERY = '(max-width: 600px)';

export interface ListColumn<T> extends Column<T> {
  /**
   * Card line on phones (1 = title line, 2, 3). Default 2. `'hidden'` drops the cell from the
   * card; use it only for purely technical values.
   */
  mobileLine?: 1 | 2 | 3 | 'hidden';
  /** Rendered in the card only, never as a table column (e.g. a tenant chip). */
  mobileOnly?: boolean;
  /** Purely visual cell (e.g. a share bar): no spoken header prefix in the card. */
  decorative?: boolean;
}

interface Props<T> {
  caption: string;
  columns: ListColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  rowHeight?: number;
  maxHeight?: number;
  onEndReached?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  totalLabel?: string;
}

/**
 * `VirtualTable` on wide screens, a list of three-line card rows on phones. Every column stays
 * visible on a phone: it is placed on a card line instead of being hidden.
 */
export function ResponsiveList<T>(props: Props<T>) {
  const phone = useMediaQuery(PHONE_QUERY);
  if (!phone) {
    const { columns, ...rest } = props;
    return <VirtualTable {...rest} columns={columns.filter((c) => !c.mobileOnly)} />;
  }
  return <CardList {...props} />;
}

function CardList<T>({
  caption,
  columns,
  rows,
  rowKey,
  onEndReached,
  hasMore = false,
  loadingMore = false,
  totalLabel,
}: Props<T>) {
  const t = useT();
  const lines = [1, 2, 3] as const;
  return (
    <div>
      <ul className="card-list" aria-label={caption}>
        {rows.map((row) => (
          <li key={rowKey(row)} className="card-row">
            {lines.map((n) => {
              const cells = columns.filter((c) => (c.mobileLine ?? 2) === n);
              if (!cells.length) return null;
              return (
                <div key={n} className={`card-line card-line-${n}`}>
                  {cells.map((c) => (
                    <CardCell key={c.key} header={n === 1 || c.decorative ? null : c.header}>
                      {c.cell(row)}
                    </CardCell>
                  ))}
                </div>
              );
            })}
          </li>
        ))}
      </ul>
      <div className="card-foot">
        {totalLabel ? <span>{totalLabel}</span> : <span />}
        {loadingMore ? (
          <span className="muted">
            <Spinner small /> {t('common.loadingMore')}
          </span>
        ) : hasMore && onEndReached ? (
          <button type="button" className="link-btn" onClick={onEndReached}>
            {t('common.loadMore')}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function CardCell({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <span className="card-cell">
      {header ? <span className="sr-only">{header}: </span> : null}
      {children}
    </span>
  );
}
