/**
 * Review helpers for the tool snapshots of an MCP connection (ADR 0016 section 5). Tool names,
 * descriptions and schemas are untrusted text from the server: they are shown as data, with
 * characters that do not render made visible so that a reviewer can see what a model would read.
 */

export interface ReviewTool {
  name: string;
  title?: string | null | undefined;
  description?: string | null | undefined;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown> | null | undefined;
  annotations?: Record<string, unknown> | null | undefined;
}

export const TOOL_FIELDS = [
  'title',
  'description',
  'inputSchema',
  'outputSchema',
  'annotations',
] as const;
export type ToolField = (typeof TOOL_FIELDS)[number];

export interface ToolChange {
  name: string;
  kind: 'added' | 'removed' | 'changed';
  /** The fields whose value differs (all fields for an added or removed tool). */
  fields: { field: ToolField; before: string | null; after: string | null }[];
}

// Code point ranges of characters that do not render or reorder text: C0/C1 controls (except tab,
// line feed and carriage return), soft hyphen, zero-width and bidi controls, tag characters,
// line/paragraph separators, variation selectors and other format characters.
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x61c, 0x61c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff9, 0xfffb],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe007f],
];

const isInvisible = (cp: number): boolean => INVISIBLE_RANGES.some(([a, b]) => cp >= a && cp <= b);

/** Replaces characters that are invisible or reorder text with a visible marker like `[U+200B]`. */
export function visibleText(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    out += isInvisible(cp) ? `[U+${cp.toString(16).toUpperCase().padStart(4, '0')}]` : ch;
  }
  return out;
}

/** True when {@link visibleText} would change the text. */
export function hasInvisible(s: string): boolean {
  for (const ch of s) if (isInvisible(ch.codePointAt(0)!)) return true;
  return false;
}

/** Stable, sorted JSON of a value (display and comparison only; the digest is computed server-side). */
export function stable(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, x]) => [k, sort(x)]),
          )
        : v;
  return JSON.stringify(sort(value), null, 2);
}

function fieldText(tool: ReviewTool, field: ToolField): string | null {
  const v = tool[field];
  if (v === undefined || v === null) return null;
  return typeof v === 'string' ? v : stable(v);
}

/** What changed from `before` to `after`, by tool name. Unchanged tools are not listed. */
export function diffTools(
  before: readonly ReviewTool[],
  after: readonly ReviewTool[],
): ToolChange[] {
  const a = new Map(before.map((t) => [t.name, t]));
  const b = new Map(after.map((t) => [t.name, t]));
  const out: ToolChange[] = [];
  for (const name of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(name);
    const y = b.get(name);
    const fields = TOOL_FIELDS.flatMap((field) => {
      const bf = x ? fieldText(x, field) : null;
      const af = y ? fieldText(y, field) : null;
      return bf === af ? [] : [{ field, before: bf, after: af }];
    });
    if (!x)
      out.push({
        name,
        kind: 'added',
        fields: TOOL_FIELDS.flatMap((field) => {
          const af = fieldText(y!, field);
          return af === null ? [] : [{ field, before: null, after: af }];
        }),
      });
    else if (!y)
      out.push({
        name,
        kind: 'removed',
        fields: TOOL_FIELDS.flatMap((field) => {
          const bf = fieldText(x, field);
          return bf === null ? [] : [{ field, before: bf, after: null }];
        }),
      });
    else if (fields.length > 0) out.push({ name, kind: 'changed', fields });
  }
  return out;
}
