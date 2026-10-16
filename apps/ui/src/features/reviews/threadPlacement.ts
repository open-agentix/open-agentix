import type { DiffLine } from '../../lib/diff';
import type { ReviewThread } from '../../api/types';

/**
 * Where the threads of a review appear in its diff. A line thread sits under the diff line it was
 * written on: a `head` anchor under the line with that number in the new text, a `base` anchor
 * under the line with that number in the old text. An outdated thread has no line any more and is
 * listed apart, as are the threads about the review as a whole.
 */
export interface Placement {
  /** Threads per diff line index. */
  byLine: Map<number, ReviewThread[]>;
  general: ReviewThread[];
  outdated: ReviewThread[];
}

export function placeThreads(
  lines: readonly DiffLine[],
  threads: readonly ReviewThread[],
): Placement {
  const headLine = new Map<number, number>();
  const baseLine = new Map<number, number>();
  lines.forEach((l, i) => {
    if (l.newNo !== undefined) headLine.set(l.newNo, i);
    if (l.oldNo !== undefined) baseLine.set(l.oldNo, i);
  });
  const placement: Placement = { byLine: new Map(), general: [], outdated: [] };
  for (const t of threads) {
    if (!t.anchor) placement.general.push(t);
    else if (t.outdated) placement.outdated.push(t);
    else {
      const at = (t.anchor.side === 'head' ? headLine : baseLine).get(t.anchor.line);
      if (at === undefined) placement.outdated.push(t);
      else placement.byLine.set(at, [...(placement.byLine.get(at) ?? []), t]);
    }
  }
  return placement;
}

/** Which side and line a diff line is commented on: deletions on the base, everything else on the head. */
export function anchorOfLine(line: DiffLine): { side: 'base' | 'head'; line: number } | null {
  if (line.type === 'del' && line.oldNo !== undefined) return { side: 'base', line: line.oldNo };
  if (line.newNo !== undefined) return { side: 'head', line: line.newNo };
  return null;
}

/** Lines of context kept around a change, and the most lines the review diff renders. */
export const DIFF_CONTEXT = 3;
export const MAX_RENDERED_LINES = 3000;

export type DiffRow = number | { skipped: number };

/**
 * Which diff lines are rendered: changed lines, a few lines of context around them and every line
 * with a thread; runs of other unchanged lines collapse into one `{ skipped }` row, and the list is
 * cut at {@link MAX_RENDERED_LINES}, so that a huge source cannot create a huge page.
 */
export function visibleRows(
  lines: readonly DiffLine[],
  withThreads: ReadonlySet<number>,
): { rows: DiffRow[]; clipped: boolean } {
  const keep = new Uint8Array(lines.length);
  lines.forEach((l, i) => {
    if (l.type === 'same' && !withThreads.has(i)) return;
    for (
      let k = Math.max(0, i - DIFF_CONTEXT);
      k <= Math.min(lines.length - 1, i + DIFF_CONTEXT);
      k++
    )
      keep[k] = 1;
  });
  const rows: DiffRow[] = [];
  let skipped = 0;
  let shown = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) {
      skipped++;
      continue;
    }
    if (shown >= MAX_RENDERED_LINES) return { rows, clipped: true };
    if (skipped) rows.push({ skipped });
    skipped = 0;
    rows.push(i);
    shown++;
  }
  if (skipped) rows.push({ skipped });
  return { rows, clipped: false };
}
