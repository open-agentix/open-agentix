import { useEffect, useState } from 'react';

export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title ? `${title} · open-agentix` : 'open-agentix';
  }, [title]);
}

/** Start of the current local day / month as ISO strings (for "today" and "this month"). */
export function startOfToday(now = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}
/** Local calendar date as `YYYY-MM-DD` (what the cost API takes for period bounds). */
export function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** First day of the local month as `YYYY-MM-01`. */
export function monthStartDate(now = new Date()): string {
  return `${localDate(now).slice(0, 7)}-01`;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}
