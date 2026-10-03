export interface DiffLine {
  type: 'same' | 'add' | 'del';
  text: string;
  /** Line number in the old text (for `same`/`del`). */
  oldNo?: number;
  /** Line number in the new text (for `same`/`add`). */
  newNo?: number;
}

/** Line diff based on the longest common subsequence. Good enough for agents.md sized files. */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
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
