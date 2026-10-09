import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { meQuery } from '../auth/auth';
import { session } from '../auth/session';

export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

/** `Page · Tenant · open-agentix`; the tenant part appears once `/v1/me` has loaded. */
export function useDocumentTitle(title: string): void {
  const { data: me } = useQuery({ ...meQuery, enabled: !!session.token() });
  const tenant = me?.tenant.name ?? '';
  useEffect(() => {
    document.title = [title, tenant, 'open-agentix'].filter(Boolean).join(' · ');
  }, [title, tenant]);
}

/** Tracks a CSS media query; false where `matchMedia` is missing. */
export function useMediaQuery(query: string): boolean {
  const read = () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
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
