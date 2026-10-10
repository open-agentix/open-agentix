import { OaxError } from '@openagentix/core';
import { z } from 'zod';

/** Keyset pagination: opaque cursor over (timestamp, id) or (sequence) - never OFFSET. */
export const PageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});

export interface TimeCursor {
  t: Date;
  id: string;
}

export function encodeTimeCursor(t: Date, id: string): string {
  return Buffer.from(JSON.stringify([t.toISOString(), id])).toString('base64url');
}

export function decodeTimeCursor(cursor: string | undefined): TimeCursor | null {
  if (!cursor) return null;
  try {
    const [t, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [
      string,
      string,
    ];
    const date = new Date(t);
    if (Number.isNaN(date.getTime()) || typeof id !== 'string') throw new Error('bad cursor');
    return { t: date, id };
  } catch {
    throw new OaxError('invalid_cursor', 'cursor is invalid');
  }
}

export function encodeSeqCursor(seq: number): string {
  return Buffer.from(String(seq)).toString('base64url');
}

export function decodeSeqCursor(cursor: string | undefined): number | null {
  if (!cursor) return null;
  const n = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!Number.isInteger(n) || n < 0) throw new OaxError('invalid_cursor', 'cursor is invalid');
  return n;
}

/** Cursor over a text sort key (a name, a slug path) and an id that breaks ties. */
export interface NameCursor {
  key: string;
  id: string;
}

export function encodeNameCursor(key: string, id = ''): string {
  return Buffer.from(JSON.stringify([key, id])).toString('base64url');
}

export function decodeNameCursor(cursor: string | undefined): NameCursor | null {
  if (!cursor) return null;
  try {
    const [key, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [
      string,
      string,
    ];
    if (typeof key !== 'string' || typeof id !== 'string') throw new Error('bad cursor');
    return { key, id };
  } catch {
    throw new OaxError('invalid_cursor', 'cursor is invalid');
  }
}

/** Takes `limit + 1` rows and returns the page plus the cursor of the last row (if more exist). */
export function page<T>(
  rows: T[],
  limit: number,
  cursorOf: (row: T) => string,
): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last ? cursorOf(last) : null };
}
