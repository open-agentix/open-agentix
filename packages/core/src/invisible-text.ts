/**
 * Removal of invisible and steering Unicode from text that is about to reach a model.
 *
 * Why: characters that render as nothing (zero-width, bidirectional controls, the Unicode "tag"
 * block, stray control codes) let an attacker hide instructions in an issue, a web page or a tool
 * result that a human reviewer cannot see but the model reads. Removing them is cheap and
 * deterministic (it complements, and does not replace, the structural rule that untrusted text is
 * data and never instructions).
 *
 * Policy (see docs/security-input-hardening.md):
 * - always removed: zero-width characters (U+200B, U+2060-U+2064, U+FEFF), directional marks and
 *   bidi controls (U+200E, U+200F, U+202A-U+202E, U+2066-U+2069), tag characters (U+E0000-U+E007F),
 *   variation selectors supplement (U+E0100-U+E01EF, used to smuggle bytes), C0/C1 control codes
 *   and DEL except tab, line feed and carriage return, the Arabic letter mark (U+061C, a bidi
 *   control), and other format characters and fillers that render as nothing (soft hyphen,
 *   combining grapheme joiner, Hangul fillers, Khmer inherent vowels, Mongolian vowel separator,
 *   deprecated format controls U+206A-U+206F, interlinear annotation controls U+FFF9-U+FFFB,
 *   shorthand and musical format controls);
 * - variation selectors U+FE00-U+FE0F (U+FE0F is emoji presentation) are kept only as the first
 *   selector after a visible character: a run of them smuggles bytes (one per selector), a single
 *   one is how emoji and standardized variants are written;
 * - conditionally kept: ZWJ (U+200D) and ZWNJ (U+200C) only BETWEEN two non-ASCII characters that
 *   are letters, marks or emoji. That keeps emoji sequences (family, flags with modifiers) and
 *   Persian, Indic or Arabic text intact, while `ig<ZWJ>nore` between ASCII letters, a joiner at
 *   the edge of a word and runs of joiners are removed;
 */

export type InvisibleClass =
  'zero_width' | 'joiner' | 'bidi' | 'tag' | 'variation' | 'control' | 'format';

/** Every class name a report can contain (the audit accepts these only). */
export const INVISIBLE_CLASSES: readonly InvisibleClass[] = [
  'zero_width',
  'joiner',
  'bidi',
  'tag',
  'variation',
  'control',
  'format',
];

export interface InvisibleReport {
  total: number;
  /** Removed code points per class (counts only, never the characters). */
  classes: Partial<Record<InvisibleClass, number>>;
}

// One pass, linear: the character class is flat (no nesting, no backtracking).
/* eslint-disable no-control-regex, no-misleading-character-class -- the point of these patterns */
const INVISIBLE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\u{1BCA0}-\u{1BCA3}\u{1D173}-\u{1D17A}\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

const INVISIBLE_ONE = new RegExp(INVISIBLE.source, 'u');

const JOINER_NEIGHBOUR = /^[\p{L}\p{M}\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0F}]$/u;
/* eslint-enable no-control-regex, no-misleading-character-class */

function classOf(cp: number): InvisibleClass {
  if (cp === 0x200c || cp === 0x200d) return 'joiner';
  if (cp === 0x200b || cp === 0xfeff || (cp >= 0x2060 && cp <= 0x2064)) return 'zero_width';
  if (cp === 0x200e || cp === 0x200f || (cp >= 0x202a && cp <= 0x202e)) return 'bidi';
  if ((cp >= 0x2066 && cp <= 0x2069) || cp === 0x061c) return 'bidi';
  if (cp >= 0xe0000 && cp <= 0xe007f) return 'tag';
  if (isVariationSelector(cp)) return 'variation';
  if (cp <= 0x9f) return 'control';
  return 'format';
}

function isVariationSelector(cp: number | undefined): boolean {
  return cp !== undefined && ((cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef));
}

/** U+FE00-U+FE0F directly after a visible character (not after another selector or at the start). */
function selectsVariant(text: string, index: number): boolean {
  const before = codePointBefore(text, index);
  if (before === undefined || isVariationSelector(before)) return false;
  return !INVISIBLE_ONE.test(String.fromCodePoint(before));
}

function codePointBefore(text: string, index: number): number | undefined {
  if (index <= 0) return undefined;
  const low = text.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.codePointAt(index - 2);
  }
  return low;
}

function isJoinerNeighbour(cp: number | undefined): boolean {
  return cp !== undefined && cp > 0x7f && JOINER_NEIGHBOUR.test(String.fromCodePoint(cp));
}

/** The joiner at `index` sits between two non-ASCII letters, marks or emoji (and is not stacked). */
function joinsText(text: string, index: number): boolean {
  return (
    isJoinerNeighbour(codePointBefore(text, index)) &&
    isJoinerNeighbour(text.codePointAt(index + 1))
  );
}

export function stripInvisible(text: string): { text: string; report: InvisibleReport } {
  const report: InvisibleReport = { total: 0, classes: {} };
  const out = text.replace(INVISIBLE, (ch, offset: number) => {
    const cp = ch.codePointAt(0)!;
    if ((cp === 0x200c || cp === 0x200d) && joinsText(text, offset)) return ch;
    if (cp >= 0xfe00 && cp <= 0xfe0f && selectsVariant(text, offset)) return ch;
    const cls = classOf(cp);
    report.total++;
    report.classes[cls] = (report.classes[cls] ?? 0) + 1;
    return '';
  });
  return { text: report.total === 0 ? text : out, report };
}
