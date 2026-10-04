/**
 * One line of plain text: control characters, format characters (zero-width, bidi overrides),
 * line and paragraph separators and runs of whitespace all become single spaces.
 */
export function oneLine(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
