import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useRef, type ReactNode } from 'react';
import { useT } from '../i18n/i18n';
import { Spinner } from './ui';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
}

/**
 * Virtualised table with native table semantics (spacer rows keep the DOM small). Calls
 * `onEndReached` when the user scrolls near the end, for keyset pagination.
 */
export function VirtualTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  rowHeight = 44,
  maxHeight = 600,
  onEndReached,
  hasMore = false,
  loadingMore = false,
  totalLabel,
}: {
  caption: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  rowHeight?: number;
  maxHeight?: number;
  onEndReached?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  totalLabel?: string;
}) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 10,
    initialRect: { width: 1024, height: maxHeight },
  });
  const items = virtualizer.getVirtualItems();
  const last = items[items.length - 1];
  useEffect(() => {
    if (!onEndReached || !hasMore || loadingMore || !last) return;
    if (last.index >= rows.length - 5) onEndReached();
  }, [last, rows.length, hasMore, loadingMore, onEndReached]);
  const top = items[0]?.start ?? 0;
  const bottom = virtualizer.getTotalSize() - (last?.end ?? 0);
  return (
    <div
      className="table-wrap"
      ref={scrollRef}
      style={{ maxHeight }}
      tabIndex={0}
      role="region"
      aria-label={t('common.tableRegion', { name: caption })}
    >
      <table className="table" aria-rowcount={rows.length + 1}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr aria-rowindex={1}>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={c.className}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {top > 0 ? (
            <tr aria-hidden="true" className="spacer">
              <td colSpan={columns.length} style={{ height: top }} />
            </tr>
          ) : null}
          {items.map((v) => {
            const row = rows[v.index] as T;
            return (
              <tr key={rowKey(row)} aria-rowindex={v.index + 2} style={{ height: rowHeight }}>
                {columns.map((c) => (
                  <td key={c.key} className={c.className}>
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            );
          })}
          {bottom > 0 ? (
            <tr aria-hidden="true" className="spacer">
              <td colSpan={columns.length} style={{ height: bottom }} />
            </tr>
          ) : null}
        </tbody>
      </table>
      <div className="table-foot">
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
