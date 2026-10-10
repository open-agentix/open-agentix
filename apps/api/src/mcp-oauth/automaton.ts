/**
 * Aho-Corasick multi-pattern matcher over ASCII, stored in typed arrays (first-child /
 * next-sibling edges). Scanning is linear in the text whatever the patterns look like (shared
 * prefixes, periodic strings), which is what the redactor needs: patterns are chosen by other
 * parties. Build cost is proportional to the total pattern length.
 */
const ROOT = 0;
const NONE = -1;
const ASCII_MAX = 127;

export class Automaton {
  private readonly first: Int32Array;
  private readonly next: Int32Array;
  private readonly ch: Uint8Array;
  private readonly fail: Int32Array;
  /** Length of the longest pattern that ends at this state (through the suffix links). */
  private readonly longest: Int32Array;
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
    let count = 0;
    for (const p of patterns) if (this.insert(p)) count++;
    this.patterns = count;
    this.link();
  }

  private child(node: number, c: number): number {
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
      }
      node = to;
    }
    this.longest[node] = Math.max(this.longest[node] as number, pattern.length);
    return true;
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
