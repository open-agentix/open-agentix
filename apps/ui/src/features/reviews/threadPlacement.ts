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
