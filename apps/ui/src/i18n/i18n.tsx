import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import en from './locales/en.json';

export type Dict = typeof en;
export const LOCALES = ['en', 'de'] as const;
export type Locale = (typeof LOCALES)[number];

type Plural = { one: string; other: string };
type Leaves<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? `${P}${K}`
    : T[K] extends Plural
      ? `${P}${K}`
      : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

/** Every translation key (dot path into en.json). */
export type TKey = Leaves<Dict>;
export type TVars = Record<string, string | number>;
export type TFunction = (key: TKey, vars?: TVars) => string;

const STORAGE_KEY = 'oax.locale';
const dictionaries: Partial<Record<Locale, Dict>> = { en };

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** Remembered choice first, then the browser languages, then English. */
export function detectLocale(): Locale {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    /* storage blocked */
  }
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const lang of langs) {
    const base = lang?.toLowerCase().split('-')[0];
    if (isLocale(base)) return base;
  }
  return 'en';
}

export function rememberLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* storage blocked */
  }
}

/** Loads a dictionary; English is bundled, other locales are separate chunks. */
export async function loadLocale(locale: Locale): Promise<Dict> {
  const cached = dictionaries[locale];
  if (cached) return cached;
  const mod = (await import('./locales/de.json')) as { default: Dict };
  dictionaries.de = mod.default;
  return mod.default;
}

function lookup(dict: Dict, key: string): unknown {
  let node: unknown = dict;
  for (const part of key.split('.')) {
    if (node && typeof node === 'object' && part in node) {
      node = (node as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return node;
}

export function translate(locale: Locale, key: string, vars?: TVars): string {
  const dict = dictionaries[locale] ?? en;
  let value = lookup(dict, key) ?? lookup(en, key);
  if (value && typeof value === 'object') {
    const count = Number(vars?.count ?? 0);
    const rule = new Intl.PluralRules(locale).select(count);
    const forms = value as Plural;
    value = rule === 'one' ? forms.one : forms.other;
  }
  if (typeof value !== 'string') return key;
  if (!vars) return value;
  return value.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

export interface Formatters {
  date: (iso: string | null | undefined) => string;
  dateTime: (iso: string | null | undefined) => string;
  relative: (iso: string | null | undefined, now?: number) => string;
  number: (n: number) => string;
  usd: (n: number) => string;
  duration: (ms: number | null | undefined) => string;
}

export function formatters(locale: Locale): Formatters {
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' });
  const number = new Intl.NumberFormat(locale);
  const usd = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 4,
  });
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const dash = '–';
  return {
    date: (iso) => (iso ? date.format(new Date(iso)) : dash),
    dateTime: (iso) => (iso ? dateTime.format(new Date(iso)) : dash),
    relative: (iso, now = Date.now()) => {
      if (!iso) return dash;
      const seconds = Math.round((Date.parse(iso) - now) / 1000);
      const abs = Math.abs(seconds);
      if (abs < 60) return rtf.format(seconds, 'second');
      if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
      if (abs < 86400) return rtf.format(Math.round(seconds / 3600), 'hour');
      return rtf.format(Math.round(seconds / 86400), 'day');
    },
    number: (n) => number.format(n),
    usd: (n) => usd.format(n),
    duration: (ms) => {
      if (ms === null || ms === undefined) return dash;
      if (ms < 1000) return `${number.format(ms)} ms`;
      if (ms < 60_000) return `${number.format(Math.round(ms / 100) / 10)} s`;
      return `${number.format(Math.floor(ms / 60_000))} min ${Math.round((ms % 60_000) / 1000)} s`;
    },
  };
}

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => Promise<void>;
  t: TFunction;
  fmt: Formatters;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({
  initialLocale,
  children,
}: {
  initialLocale: Locale;
  children: ReactNode;
}) {
  const [locale, setState] = useState<Locale>(initialLocale);
  const setLocale = useCallback(async (next: Locale) => {
    await loadLocale(next);
    rememberLocale(next);
    document.documentElement.lang = next;
    setState(next);
  }, []);
  const value = useMemo<I18nValue>(
    () => ({
      locale,
      setLocale,
      t: (key, vars) => translate(locale, key, vars),
      fmt: formatters(locale),
    }),
    [locale, setLocale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n outside I18nProvider');
  return ctx;
}

export function useT(): TFunction {
  return useI18n().t;
}
