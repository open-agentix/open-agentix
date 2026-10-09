/** Splits text into lines that keep their terminator, so a missing final newline is a difference. */
export function splitLines(text: string): string[] {
  return text === '' ? [] : text.split(/(?<=\n)/);
}

type Op = { t: ' ' | '-' | '+'; line: string };

const MAX_EDIT_DISTANCE = 1000;

function myers(a: string[], b: string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  if (n + m === 0) return [];
  const lim = Math.min(n + m, MAX_EDIT_DISTANCE);
  const off = lim + 1;
  const v = new Int32Array(2 * lim + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= lim; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!)) x = v[off + k + 1]!;
      else x = v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace, off, d);
    }
  }
  return null;
}

function backtrack(a: string[], b: string[], trace: Int32Array[], off: number, dMax: number): Op[] {
  const out: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = dMax; d >= 0; d -= 1) {
    const v = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? k + 1 : k - 1;
    const prevX = v[off + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push({ t: ' ', line: a[x - 1]! });
      x -= 1;
      y -= 1;
    }
    if (d > 0) {
      if (x === prevX) out.push({ t: '+', line: b[prevY]! });
      else out.push({ t: '-', line: a[prevX]! });
    }
    x = prevX;
    y = prevY;
  }
  return out.reverse();
}

/** Line operations from `a` to `b`; falls back to "replace the changed middle" for huge edits. */
export function diffLines(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const mid = myers(midA, midB) ?? [
    ...midA.map((line): Op => ({ t: '-', line })),
    ...midB.map((line): Op => ({ t: '+', line })),
  ];
  return [
    ...a.slice(0, start).map((line): Op => ({ t: ' ', line })),
    ...mid,
    ...a.slice(endA).map((line): Op => ({ t: ' ', line })),
  ];
}

function renderLine(prefix: string, line: string): string {
  return line.endsWith('\n')
    ? `${prefix}${line}`
    : `${prefix}${line}\n\\ No newline at end of file\n`;
}

/** Unified-diff hunks (3 lines of context) between two texts; empty string when equal. */
export function unifiedHunks(before: string, after: string, context = 3): string {
  const ops = diffLines(splitLines(before), splitLines(after));
  const changes: number[] = [];
  ops.forEach((o, i) => {
    if (o.t !== ' ') changes.push(i);
  });
  if (changes.length === 0) return '';
  const groups: [number, number][] = [];
  for (const c of changes) {
    const last = groups[groups.length - 1];
    if (last && c - last[1] <= 2 * context) last[1] = c;
    else groups.push([c, c]);
  }
  let out = '';
  for (const [first, last] of groups) {
    const from = Math.max(0, first - context);
    const to = Math.min(ops.length, last + context + 1);
    let oldBefore = 0;
    let newBefore = 0;
    for (let i = 0; i < from; i += 1) {
      if (ops[i]!.t !== '+') oldBefore += 1;
      if (ops[i]!.t !== '-') newBefore += 1;
    }
    let oldCount = 0;
    let newCount = 0;
    let body = '';
    for (let i = from; i < to; i += 1) {
      const o = ops[i]!;
      if (o.t !== '+') oldCount += 1;
      if (o.t !== '-') newCount += 1;
      body += renderLine(o.t, o.line);
    }
    const oldStart = oldCount === 0 ? oldBefore : oldBefore + 1;
    const newStart = newCount === 0 ? newBefore : newBefore + 1;
    out += `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${body}`;
  }
  return out;
}
