import { sha256Hex } from '../canonical.js';

/**
 * Line anchors of review comments (ADR 0017 section 9). A thread on a line of the diff is anchored
 * to a revision (or the base version), a side, a line number and the SHA-256 of the line text. The
 * server computes the hash from the stored source, never from the client, so an anchor cannot name a
 * line the revision does not have. When the draft moves on, a thread whose anchor no longer matches
 * the line of the current head is outdated: it is kept, but it is not shown on a line.
 */

/** The most lines a source may have for an anchor (a source is at most 64 KiB; this is a hard stop). */
export const MAX_ANCHOR_LINE = 100_000;

export const ANCHOR_SIDES = ['base', 'head'] as const;
export type AnchorSide = (typeof ANCHOR_SIDES)[number];

/**
 * The lines of a source as the console numbers them: split on `\n` only, so a number means the same
 * thing on both ends. A trailing `\r` is part of the line break, not of the line.
 */
export function sourceLines(source: string): string[] {
  return source.split('\n');
}

/** SHA-256 of a line without trailing blanks, so reformatting the end of a line keeps the anchor. */
export function lineHash(line: string): string {
  return sha256Hex(line.replace(/[ \t\r]+$/, ''));
}

/** The hash of line `line` (1-based) of `lines`, or `null` when the source has no such line. */
export function hashOfLine(lines: readonly string[], line: number): string | null {
  const text = Number.isInteger(line) && line >= 1 ? lines[line - 1] : undefined;
  return text === undefined ? null : lineHash(text);
}

/** Whether the anchor still names the same text in `lines` (the current source of its side). */
export function anchorMatches(
  anchor: { line: number; lineHash: string },
  lines: readonly string[],
): boolean {
  return hashOfLine(lines, anchor.line) === anchor.lineHash;
}
