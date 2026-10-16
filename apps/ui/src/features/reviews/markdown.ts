/**
 * A minimal Markdown subset for review comments (ADR 0017 section 9). Comment text is untrusted
 * tenant content, so this parser produces a small tree of known node kinds and never HTML: the
 * renderer (`Markdown.tsx`) turns those nodes into React elements, which escape every string.
 *
 * Supported: paragraphs, `code` and fenced code blocks, **bold**, *italic* / _italic_, bullet and
 * numbered lists, block quotes, and [links](url) to http and https URLs.
 *
 * Deliberately not supported, shown as plain text instead: raw HTML, images, headings, tables,
 * link titles and reference links, autolinks, URLs of any other scheme (javascript:, data:,
 * vbscript:, file:, relative and protocol-relative URLs) and URLs with credentials.
 *
 * Linear time: the scanner moves forward only, delimiters are found with `indexOf`, and a delimiter
 * that has no closer is remembered so that later openers do not search again; no regular
 * expression has nested or overlapping quantifiers. The input is cut at {@link MAX_MARKDOWN_CHARS}.
 */

export const MAX_MARKDOWN_CHARS = 10_000;
const MAX_URL_CHARS = 2000;
const MAX_INLINE_DEPTH = 3;
const MAX_BLOCK_DEPTH = 3;
const MAX_BLOCKS = 500;
const MAX_LIST_ITEMS = 200;

export type Inline =
  | { kind: 'text'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'link'; href: string; host: string; children: Inline[] };

export type Block =
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'quote'; children: Block[] }
  | { kind: 'code'; value: string };

export interface ParsedMarkdown {
  blocks: Block[];
  /** The input was longer than {@link MAX_MARKDOWN_CHARS} and was cut. */
  truncated: boolean;
}

// ------------------------------------------------------------------ links

// Control characters, whitespace and the C1 range: `java\nscript:` and `ja vascript:` never pass.
const UNSAFE_URL_CHARS = new RegExp(
  `[${(
    [
      [0x00, 0x20],
      [0x7f, 0xa0],
      [0x1680, 0x1680],
      [0x2000, 0x200f],
      [0x2028, 0x202f],
      [0x205f, 0x2064],
      [0x3000, 0x3000],
      [0xfeff, 0xfeff],
    ] as [number, number][]
  )
    .map(([from, to]) => `${String.fromCharCode(from)}-${String.fromCharCode(to)}`)
    .join('')}]`,
);
const HTTP_PREFIX = /^https?:\/\//i;

/**
 * The link a URL written in a comment may become, or `null`. Only absolute `http://` and `https://`
 * URLs without credentials qualify; `host` is what the console shows next to the link text, in the
 * form the browser will connect to (an internationalised name appears in punycode).
 */
export function safeLink(raw: string): { href: string; host: string } | null {
  if (raw.length === 0 || raw.length > MAX_URL_CHARS) return null;
  if (UNSAFE_URL_CHARS.test(raw) || !HTTP_PREFIX.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '' || url.hostname === '') return null;
  return { href: url.href, host: url.hostname };
}

// ------------------------------------------------------------------ inline

/** `indexOf` that remembers a failed search: no later search for the same delimiter can succeed. */
class Finder {
  private readonly failedFrom = new Map<string, number>();
  constructor(private readonly text: string) {}
  find(needle: string, from: number): number {
    const failed = this.failedFrom.get(needle);
    if (failed !== undefined && from >= failed) return -1;
    const at = this.text.indexOf(needle, from);
    if (at < 0) this.failedFrom.set(needle, Math.min(failed ?? from, from));
    return at;
  }
}

const ESCAPABLE = '\\`*_[]()!<>#.-+';
const isWord = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);
const isSpace = (c: string | undefined): boolean => c === undefined || /\s/.test(c);

class InlineParser {
  private readonly finder: Finder;
  private out: Inline[] = [];
  private buffer = '';
  private i = 0;

  constructor(
    private readonly text: string,
    private readonly depth: number,
    private readonly allowLinks: boolean,
  ) {
    this.finder = new Finder(text);
  }

  run(): Inline[] {
    while (this.i < this.text.length) this.step(this.text[this.i]!);
    this.flush();
    return this.out;
  }

  private flush(): void {
    if (this.buffer) this.out.push({ kind: 'text', value: this.buffer });
    this.buffer = '';
  }

  private literal(n = 1): void {
    this.buffer += this.text.slice(this.i, this.i + n);
    this.i += n;
  }

  private push(node: Inline, next: number): void {
    this.flush();
    this.out.push(node);
    this.i = next;
  }

  private step(c: string): void {
    if (c === '\\' && ESCAPABLE.includes(this.text[this.i + 1] ?? '\n')) {
      this.buffer += this.text[this.i + 1];
      this.i += 2;
    } else if (c === '`') this.code();
    else if (c === '*' || c === '_') this.emphasis(c);
    else if (c === '!' && this.text[this.i + 1] === '[') this.image();
    else if (c === '[' && this.allowLinks) this.link();
    else this.literal();
  }

  private code(): void {
    const end = this.finder.find('`', this.i + 1);
    if (end > this.i + 1)
      this.push({ kind: 'code', value: this.text.slice(this.i + 1, end) }, end + 1);
    else this.literal();
  }

  private emphasis(c: string): void {
    const strong = this.text[this.i + 1] === c;
    const open = this.i + (strong ? 2 : 1);
    const delim = strong ? c + c : c;
    const end = this.finder.find(delim, open);
    const inner = end < 0 ? '' : this.text.slice(open, end);
    const flanked = inner.length > 0 && !isSpace(inner[0]) && !isSpace(inner[inner.length - 1]);
    // `_` inside a word (snake_case) is not emphasis.
    const wordInside =
      c === '_' && (isWord(this.text[this.i - 1]) || isWord(this.text[end + delim.length]));
    if (end < 0 || !flanked || wordInside || this.depth >= MAX_INLINE_DEPTH) {
      this.literal(delim.length);
      return;
    }
    const children = new InlineParser(inner, this.depth + 1, this.allowLinks).run();
    this.push({ kind: strong ? 'strong' : 'em', children }, end + delim.length);
  }

  /** `[label](url)` with its end index, or `null` when the construct is not well formed. */
  private bracketed(at: number): { label: string; url: string; end: number } | null {
    const close = this.finder.find(']', at + 1);
    if (close < 0 || this.text[close + 1] !== '(') return null;
    const endUrl = this.finder.find(')', close + 2);
    if (endUrl < 0) return null;
    return {
      label: this.text.slice(at + 1, close),
      url: this.text.slice(close + 2, endUrl),
      end: endUrl + 1,
    };
  }

  private link(): void {
    const b = this.bracketed(this.i);
    const safe = b ? safeLink(b.url) : null;
    if (!b || !safe || b.label.length === 0 || this.depth >= MAX_INLINE_DEPTH) {
      this.literal();
      return;
    }
    // No link inside a link: the label is parsed with links off.
    const children = new InlineParser(b.label, this.depth + 1, false).run();
    this.push({ kind: 'link', href: safe.href, host: safe.host, children }, b.end);
  }

  /** Images are never rendered: the whole construct is shown as the text it was written as. */
  private image(): void {
    const b = this.bracketed(this.i + 1);
    if (b) this.literal(b.end - this.i);
    else this.literal();
  }
}

export function parseInline(text: string, depth = 0, allowLinks = true): Inline[] {
  return new InlineParser(text, depth, allowLinks).run();
}

// ------------------------------------------------------------------ blocks

const FENCE = /^ {0,3}```/;
const QUOTE = /^ {0,3}>/;
const BULLET = /^ {0,3}[-*+] +(.*)$/;
const NUMBERED = /^ {0,3}\d{1,9}[.)] +(.*)$/;

const startsBlock = (line: string): boolean =>
  FENCE.test(line) || QUOTE.test(line) || BULLET.test(line) || NUMBERED.test(line);

function parseBlocks(lines: string[], depth: number): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length && blocks.length < MAX_BLOCKS) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i++;
    } else if (FENCE.test(line)) {
      const body: string[] = [];
      for (i++; i < lines.length && !FENCE.test(lines[i]!); i++) body.push(lines[i]!);
      i++;
      blocks.push({ kind: 'code', value: body.join('\n') });
    } else if (QUOTE.test(line)) {
      const body: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i]!); i++)
        body.push(lines[i]!.replace(/^ {0,3}> ?/, ''));
      if (depth >= MAX_BLOCK_DEPTH)
        blocks.push({ kind: 'paragraph', children: parseInline(body.join('\n')) });
      else blocks.push({ kind: 'quote', children: parseBlocks(body, depth + 1) });
    } else if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = NUMBERED.test(line);
      const pattern = ordered ? NUMBERED : BULLET;
      const items: Inline[][] = [];
      for (; i < lines.length && items.length < MAX_LIST_ITEMS; i++) {
        const m = pattern.exec(lines[i]!);
        if (!m) break;
        items.push(parseInline(m[1]!));
      }
      blocks.push({ kind: 'list', ordered, items });
    } else {
      const body: string[] = [];
      for (
        ;
        i < lines.length &&
        lines[i]!.trim() !== '' &&
        (body.length === 0 || !startsBlock(lines[i]!));
        i++
      )
        body.push(lines[i]!);
      blocks.push({ kind: 'paragraph', children: parseInline(body.join('\n')) });
    }
  }
  return blocks;
}

/** Parses a comment. Never throws, never returns HTML. */
export function parseMarkdown(source: string): ParsedMarkdown {
  const truncated = source.length > MAX_MARKDOWN_CHARS;
  const text = (truncated ? source.slice(0, MAX_MARKDOWN_CHARS) : source).replace(/\r\n?/g, '\n');
  return { blocks: parseBlocks(text.split('\n'), 0), truncated };
}
