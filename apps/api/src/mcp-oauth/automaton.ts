/**
 * Aho-Corasick multi-pattern matcher over ASCII, stored in typed arrays (first-child /
 * next-sibling edges). Scanning is linear in the text whatever the patterns look like (shared
 * prefixes, periodic strings), which is what the redactor needs: patterns are chosen by other
 * parties. Build cost is proportional to the total pattern length. The first levels of the trie
 * (where the branching is wide) use dense 128-entry tables; deeper nodes, which of random strings
 * have one or two children, use the sibling lists.
 */
const ROOT = 0;
const NONE = -1;
const ASCII_MAX = 127;
const ALPHABET = 128;
/** Nodes at this depth or above get a dense table. */
const DENSE_DEPTH = 2;

export class Automaton {
  private readonly first: Int32Array;
  private readonly next: Int32Array;
  private readonly ch: Uint8Array;
  private readonly fail: Int32Array;
  /** Length of the longest pattern that ends at this state (through the suffix links). */
  private readonly longest: Int32Array;
  private readonly depth: Uint8Array;
  /** Index of the node's dense table, or -1. */
  private readonly denseOf: Int32Array;
  private dense: Int32Array = new Int32Array(0);
  private denseCount = 0;
  private nodes = 1;
  readonly patterns: number;

  constructor(patterns: readonly string[]) {
    let total = 1;
    for (const p of patterns) total += p.length;
    this.first = new Int32Array(total).fill(NONE);
    this.next = new Int32Array(total).fill(NONE);
    this.ch = new Uint8Array(total);
    this.fail = new Int32Array(total);
    this.longest = new Int32Array(total);
    this.depth = new Uint8Array(total);
    this.denseOf = new Int32Array(total).fill(NONE);
    this.dense = new Int32Array(ALPHABET).fill(NONE); // the root's table
    this.denseOf[ROOT] = 0;
    this.denseCount = 1;
    let count = 0;
    for (const p of patterns) if (this.insert(p)) count++;
    this.patterns = count;
    this.link();
  }

  private child(node: number, c: number): number {
    const d = this.denseOf[node] as number;
    if (d !== NONE) return this.dense[d * ALPHABET + c] as number;
    for (let k = this.first[node] as number; k !== NONE; k = this.next[k] as number)
      if (this.ch[k] === c) return k;
    return NONE;
  }

  private insert(pattern: string): boolean {
    if (pattern.length === 0) return false;
    let node = ROOT;
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern.charCodeAt(i);
      if (c > ASCII_MAX) return false; // not indexable; the nodes already added are harmless
      let to = this.child(node, c);
      if (to === NONE) {
        to = this.nodes++;
        this.ch[to] = c;
        this.next[to] = this.first[node] as number;
        this.first[node] = to;
        this.depth[to] = (this.depth[node] as number) + 1;
        this.addEdge(node, c, to);
      }
      node = to;
    }
    this.longest[node] = Math.max(this.longest[node] as number, pattern.length);
    return true;
  }

  /** Records the edge in the dense table of `node`, and gives `to` a table if it is shallow. */
  private addEdge(node: number, c: number, to: number): void {
    const d = this.denseOf[node] as number;
    if (d !== NONE) this.dense[d * ALPHABET + c] = to;
    if ((this.depth[to] as number) <= DENSE_DEPTH) this.allocDense(to);
  }

  private allocDense(node: number): void {
    const need = (this.denseCount + 1) * ALPHABET;
    if (need > this.dense.length) {
      const grown = new Int32Array(Math.max(need, this.dense.length * 2)).fill(NONE);
      grown.set(this.dense);
      this.dense = grown;
    }
    this.denseOf[node] = this.denseCount++;
  }

  /** Breadth-first failure links and inherited match lengths. */
  private link(): void {
    const queue = new Int32Array(this.nodes);
    let head = 0;
    let tail = 0;
    for (let k = this.first[ROOT] as number; k !== NONE; k = this.next[k] as number) {
      this.fail[k] = ROOT;
      queue[tail++] = k;
    }
    while (head < tail) {
      const u = queue[head++] as number;
      for (let v = this.first[u] as number; v !== NONE; v = this.next[v] as number) {
        const c = this.ch[v] as number;
        let f = this.fail[u] as number;
        while (f !== ROOT && this.child(f, c) === NONE) f = this.fail[f] as number;
        const t = this.child(f, c);
        this.fail[v] = t !== NONE ? t : ROOT;
        this.longest[v] = Math.max(
          this.longest[v] as number,
          this.longest[this.fail[v] as number] as number,
        );
        queue[tail++] = v;
      }
    }
  }

  /** Replaces every occurrence of any pattern (overlaps merged) with `replacement`. */
  replaceAll(text: string, replacement: string): string {
    const starts: number[] = [];
    const ends: number[] = [];
    let state = ROOT;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c > ASCII_MAX) {
        state = ROOT;
        continue;
      }
      for (;;) {
        const to = this.child(state, c);
        if (to !== NONE) {
          state = to;
          break;
        }
        if (state === ROOT) break;
        state = this.fail[state] as number;
      }
      const len = this.longest[state] as number;
      if (len === 0) continue;
      let start = i - len + 1;
      // Merge with earlier ranges that touch or overlap this one.
      while (ends.length > 0 && (ends[ends.length - 1] as number) >= start - 1) {
        start = Math.min(start, starts.pop() as number);
        ends.pop();
      }
      starts.push(start);
      ends.push(i);
    }
    if (starts.length === 0) return text;
    let out = '';
    let last = 0;
    for (let k = 0; k < starts.length; k++) {
      out += text.slice(last, starts[k]) + replacement;
      last = (ends[k] as number) + 1;
    }
    return out + text.slice(last);
  }
}
