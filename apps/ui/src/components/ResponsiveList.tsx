import { useId, type ReactNode } from 'react';
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

/** A titled run of rows (group-by). Order of `groups` is the display order. */
export interface RowGroup<T> {
  key: string;
  label: string;
  rows: T[];
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
  /** Group the rows under sticky headings (headed `rowgroup`s on wide screens). */
  groups?: RowGroup<T>[];
}

/**
 * `VirtualTable` on wide screens, a list of three-line card rows on phones. Every column stays
 * visible on a phone: it is placed on a card line instead of being hidden.
 */
export function ResponsiveList<T>(props: Props<T>) {
  const phone = useMediaQuery(PHONE_QUERY);
  if (!phone) {
    const { columns, groups, ...rest } = props;
    const wide = columns.filter((c) => !c.mobileOnly);
    return groups ? (
      <GroupedTable {...rest} columns={wide} groups={groups} />
    ) : (
      <VirtualTable {...rest} columns={wide} />
    );
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
  groups,
}: Props<T>) {
  const t = useT();
  const lines = [1, 2, 3] as const;
  const items = (list: T[]) =>
    list.map((row) => (
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
    ));
  return (
    <div>
      {groups ? (
        groups.map((g) => (
          <section key={g.key} className="group-section" aria-label={g.label}>
            <h2 className="group-head">
              {g.label} <span className="group-count">({g.rows.length})</span>
            </h2>
            <ul className="card-list" aria-label={`${caption}: ${g.label}`}>
              {items(g.rows)}
            </ul>
          </section>
        ))
      ) : (
        <ul className="card-list" aria-label={caption}>
          {items(rows)}
        </ul>
      )}
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

/** Non-virtual table with one headed `tbody` per group; the headings stick below the header. */
function GroupedTable<T>({
  caption,
  columns,
  rowKey,
  maxHeight = 600,
  onEndReached,
  hasMore = false,
  loadingMore = false,
  totalLabel,
  groups,
}: Props<T> & { groups: RowGroup<T>[] }) {
  const t = useT();
  const base = useId();
  return (
    <div
      className="table-wrap"
      style={{ maxHeight }}
      tabIndex={0}
      role="region"
      aria-label={t('common.tableRegion', { name: caption })}
    >
      <table className="table table-grouped">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={c.className}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        {groups.map((g, i) => (
          <tbody key={g.key} aria-labelledby={`${base}-${i}`}>
            <tr className="group-row">
              <th id={`${base}-${i}`} colSpan={columns.length} scope="rowgroup">
                <h2 className="group-head">
                  {g.label} <span className="group-count">({g.rows.length})</span>
                </h2>
              </th>
            </tr>
            {g.rows.map((row) => (
              <tr key={rowKey(row)}>
                {columns.map((c) => (
                  <td key={c.key} className={c.className}>
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        ))}
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

function CardCell({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <span className="card-cell">
      {header ? <span className="sr-only">{header}: </span> : null}
      {children}
    </span>
  );
}
