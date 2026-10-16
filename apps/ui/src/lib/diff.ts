export interface DiffLine {
  type: 'same' | 'add' | 'del';
  text: string;
  /** Line number in the old text (for `same`/`del`). */
  oldNo?: number;
  /** Line number in the new text (for `same`/`add`). */
  newNo?: number;
}

/**
 * Above this many cells (changed old lines times changed new lines) the exact diff is not computed:
 * the table of the longest common subsequence would take too much memory and time for a hostile or
 * generated file (sources can have hundreds of thousands of lines).
 */
export const MAX_DIFF_CELLS = 4_000_000;

/** Common leading and trailing lines of two texts. */
function commonEnds(a: string[], b: string[]): { head: number; tail: number } {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  return { head, tail };
}

/** Whether {@link diffLines} will fall back to "everything between the common ends changed". */
export function diffIsCoarse(oldText: string, newText: string): boolean {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const { head, tail } = commonEnds(a, b);
  return (a.length - head - tail + 1) * (b.length - head - tail + 1) > MAX_DIFF_CELLS;
}

/**
 * Line diff based on the longest common subsequence, after trimming the common ends. When the
 * changed middle is too large (see {@link MAX_DIFF_CELLS}) it is shown as removed lines followed by
 * added lines, which is correct but not minimal.
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const all = { a: oldText.split('\n'), b: newText.split('\n') };
  const { head, tail } = commonEnds(all.a, all.b);
  const a = all.a.slice(head, all.a.length - tail);
  const b = all.b.slice(head, all.b.length - tail);
  const middle = (a.length + 1) * (b.length + 1) > MAX_DIFF_CELLS ? coarse(a, b) : lcsDiff(a, b);
  const out: DiffLine[] = [];
  for (let i = 0; i < head; i++)
    out.push({ type: 'same', text: all.a[i] ?? '', oldNo: i + 1, newNo: i + 1 });
  for (const l of middle)
    out.push({
      ...l,
      ...(l.oldNo !== undefined ? { oldNo: l.oldNo + head } : {}),
      ...(l.newNo !== undefined ? { newNo: l.newNo + head } : {}),
    });
  for (let k = 0; k < tail; k++) {
    const oi = all.a.length - tail + k;
    const ni = all.b.length - tail + k;
    out.push({ type: 'same', text: all.a[oi] ?? '', oldNo: oi + 1, newNo: ni + 1 });
  }
  return out;
}

function coarse(a: string[], b: string[]): DiffLine[] {
  return [
    ...a.map((text, i): DiffLine => ({ type: 'del', text, oldNo: i + 1 })),
    ...b.map((text, j): DiffLine => ({ type: 'add', text, newNo: j + 1 })),
  ];
}

function lcsDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] ?? '', oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if ((lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0)) {
      out.push({ type: 'del', text: a[i] ?? '', oldNo: i + 1 });
      i++;
    } else {
      out.push({ type: 'add', text: b[j] ?? '', newNo: j + 1 });
      j++;
    }
  }
  for (; i < n; i++) out.push({ type: 'del', text: a[i] ?? '', oldNo: i + 1 });
  for (; j < m; j++) out.push({ type: 'add', text: b[j] ?? '', newNo: j + 1 });
  return out;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.type === 'add') added++;
    else if (l.type === 'del') removed++;
  }
  return { added, removed };
}
