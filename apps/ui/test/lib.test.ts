import { describe, expect, it, vi } from 'vitest';
import { ApiError, call, toApiError } from '../src/api/client';
import { clean } from '../src/api/queries';
import { isTerminal } from '../src/api/types';
import { session } from '../src/auth/session';
import {
  detectLocale,
  formatters,
  isLocale,
  loadLocale,
  rememberLocale,
  translate,
} from '../src/i18n/i18n';
import de from '../src/i18n/locales/de.json';
import en from '../src/i18n/locales/en.json';
import { diffLines, diffStats } from '../src/lib/diff';
import { localDate, monthStartDate, shortId, startOfToday } from '../src/lib/hooks';
import { REDACTED, redact, redactString } from '../src/lib/redact';
import { parseSse } from '../src/lib/sse';
import { applyTheme, storedTheme } from '../src/theme/theme';

function keys(obj: unknown, prefix = ''): string[] {
  if (!obj || typeof obj !== 'object') return [prefix];
  return Object.entries(obj).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}

describe('i18n', () => {
  it('German has exactly the English keys', () => {
    expect(keys(de).sort()).toEqual(keys(en).sort());
  });

  it('uses the technical terms Input / Output for token counts in both languages', () => {
    for (const lang of ['en', 'de'] as const) {
      expect(translate(lang, 'steps.tokens', { in: '265', out: '36' })).toBe(
        '265 Input / 36 Output',
      );
    }
    expect(en.costs.tokensIn).toBe('Input tokens');
    expect(en.costs.tokensOut).toBe('Output tokens');
    expect(de.costs.tokensIn).toBe('Input-Tokens');
    expect(de.costs.tokensOut).toBe('Output-Tokens');
  });

  it('keeps the German translation free of over-translated terms and formal address', () => {
    const text = JSON.stringify(de);
    expect(text).not.toMatch(/\b(rein|raus)\b/);
    expect(text).not.toMatch(
      /\b(Läufe|Lauf|Testlauf|Richtlinien?|Mandanten?|Werkzeuge?|Geheimnisse?)\b/,
    );
    expect(text).not.toMatch(/\b(Eingabe|Ausgaben?|Betreiben)\b/);
    expect(text).not.toMatch(/\b(Sie|Ihr|Ihre|Ihnen)\b/);
    expect(de.nav.groups.operate).toBe('Betrieb');
    expect(en.nav.groups.operate).toBe('Operations');
  });

  it('translates with variables and plurals', async () => {
    await loadLocale('de');
    expect(translate('en', 'dashboard.greeting', { name: 'Ada' })).toBe('Hello Ada');
    expect(translate('de', 'dashboard.greeting', { name: 'Ada' })).toBe('Hallo Ada');
    expect(translate('en', 'agents.errors', { count: 1 })).toBe('1 error');
    expect(translate('en', 'agents.errors', { count: 3 })).toBe('3 errors');
    expect(translate('en', 'missing.key')).toBe('missing.key');
    expect(translate('en', 'dashboard.greeting', {})).toBe('Hello {name}');
  });

  it('detects the browser language and remembers a manual choice', () => {
    const spy = vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['de-AT', 'en']);
    expect(detectLocale()).toBe('de');
    spy.mockReturnValue(['fr-FR']);
    expect(detectLocale()).toBe('en');
    rememberLocale('de');
    expect(detectLocale()).toBe('de');
    spy.mockRestore();
    expect(isLocale('xx')).toBe(false);
  });

  it('formats numbers, money, dates and durations', () => {
    const fmt = formatters('en');
    expect(fmt.usd(1.5)).toBe('$1.50');
    expect(fmt.number(12345)).toBe('12,345');
    expect(fmt.duration(null)).toBe('–');
    expect(fmt.duration(250)).toBe('250 ms');
    expect(fmt.duration(1500)).toBe('1.5 s');
    expect(fmt.duration(125_000)).toBe('2 min 5 s');
    expect(fmt.date(null)).toBe('–');
    expect(fmt.dateTime('2026-10-03T10:00:00Z')).toMatch(/2026/);
    expect(fmt.date('2026-10-03T10:00:00Z')).toMatch(/Oct/);
    const now = Date.parse('2026-10-03T12:00:00Z');
    expect(fmt.relative(null)).toBe('–');
    expect(fmt.relative('2026-10-03T11:59:30Z', now)).toBe('30 seconds ago');
    expect(fmt.relative('2026-10-03T11:30:00Z', now)).toBe('30 minutes ago');
    expect(fmt.relative('2026-10-03T09:00:00Z', now)).toBe('3 hours ago');
    expect(fmt.relative('2026-10-01T12:00:00Z', now)).toBe('2 days ago');
  });
});

describe('diff', () => {
  it('marks added, removed and unchanged lines', () => {
    const lines = diffLines('a\nb\nc', 'a\nc\nd');
    expect(lines.map((l) => `${l.type}:${l.text}`)).toEqual(['same:a', 'del:b', 'same:c', 'add:d']);
    expect(diffStats(lines)).toEqual({ added: 1, removed: 1 });
    expect(diffLines('x', 'x')).toEqual([{ type: 'same', text: 'x', oldNo: 1, newNo: 1 }]);
    expect(diffStats(diffLines('a\nb', ''))).toEqual({ added: 1, removed: 2 });
  });
});

describe('redaction', () => {
  it('hides secret values but keeps references', () => {
    expect(
      redact({
        password: 'x',
        nested: { apiKey: 'y', envSecrets: { TOKEN: 'MY_SECRET_NAME' }, secretRef: 'NAME' },
        list: ['Bearer abc.def', 'plain'],
        n: 1,
        nil: null,
      }),
    ).toEqual({
      password: REDACTED,
      nested: { apiKey: REDACTED, envSecrets: { TOKEN: 'MY_SECRET_NAME' }, secretRef: 'NAME' },
      list: [REDACTED, 'plain'],
      n: 1,
      nil: null,
    });
    expect(redactString('key AKIAABCDEFGHIJKLMNOP and ghp_abcdefghijklmnopqrstuvwxyz')).toBe(
      `key ${REDACTED} and ${REDACTED}`,
    );
    let deep: unknown = 'Bearer x';
    for (let i = 0; i < 25; i++) deep = [deep];
    expect(JSON.stringify(redact(deep))).toContain('Bearer x');
  });
});

describe('sse parser', () => {
  it('parses complete events and keeps the rest', () => {
    const { messages, rest } = parseSse(
      'id: 1\nevent: step\ndata: {"a":1}\n\n: keep-alive\n\nevent: status\r\ndata: x\r\ndata: y\r\n\r\ndata: partial',
    );
    expect(messages).toEqual([
      { event: 'step', data: '{"a":1}', id: '1' },
      { event: 'status', data: 'x\ny' },
    ]);
    expect(rest).toBe('data: partial');
    expect(parseSse('event: end\n\n').messages).toEqual([]);
    expect(parseSse('data\n\n').messages).toEqual([{ event: 'message', data: '' }]);
  });
});

describe('api client', () => {
  it('maps error bodies to ApiError', async () => {
    const e = toApiError(409, { error: 'conflict', message: 'exists', details: { a: 1 } });
    expect(e).toMatchObject({
      status: 409,
      code: 'conflict',
      message: 'exists',
      details: { a: 1 },
    });
    expect(toApiError(500, null)).toMatchObject({ code: 'error', message: 'HTTP 500' });
    expect(toApiError(0, undefined).code).toBe('network');
    expect(toApiError(400, { message: 'm' }).code).toBe('error');
    const ok = await call(
      Promise.resolve({ data: 1, response: new Response(null, { status: 200 }) }),
    );
    expect(ok).toBe(1);
    await expect(call(Promise.reject(new Error('offline')))).rejects.toMatchObject({
      status: 0,
      code: 'network',
    });
    await expect(call(Promise.reject('x'))).rejects.toBeInstanceOf(ApiError);
    const abort = new DOMException('aborted', 'AbortError');
    await expect(call(Promise.reject(abort))).rejects.toBe(abort);
    await expect(
      call(
        Promise.resolve({
          error: { message: 'nope' },
          response: new Response(null, { status: 403 }),
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('drops empty query values', () => {
    expect(clean({ a: 1, b: undefined, c: '', d: null, e: 'x' })).toEqual({ a: 1, e: 'x' });
  });
});

describe('session', () => {
  it('stores, expires and notifies', () => {
    const events: string[] = [];
    const off = session.subscribe((r) => events.push(r));
    session.set('tok', new Date(Date.now() + 1000).toISOString());
    expect(session.token()).toBe('tok');
    expect(session.token(Date.now() + 2000)).toBeNull();
    session.set('tok2', new Date(Date.now() + 1000).toISOString());
    session.expire();
    session.clear();
    off();
    expect(events).toEqual(['login', 'login', 'expired', 'logout']);
    expect(session.token()).toBeNull();
  });

  it('falls back to memory when storage is blocked', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    session.set('memtok', new Date(Date.now() + 1000).toISOString());
    expect(session.token()).toBe('memtok');
    expect(storedTheme()).toBe('system');
    rememberLocale('de');
    expect(detectLocale()).toBeDefined();
    get.mockRestore();
    set.mockRestore();
    session.clear();
  });
});

describe('misc helpers', () => {
  it('computes day and month starts', () => {
    const d = new Date(2026, 9, 3, 15, 30);
    expect(new Date(startOfToday(d)).getHours()).toBe(0);
    expect(monthStartDate(d)).toBe('2026-10-01');
    expect(localDate(d)).toBe('2026-10-03');
    expect(shortId('1234567890')).toBe('12345678');
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('running')).toBe(false);
  });

  it('applies themes', () => {
    applyTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    applyTheme('system');
    expect(document.documentElement.dataset.theme).toBeUndefined();
    window.localStorage.setItem('oax.theme', 'light');
    expect(storedTheme()).toBe('light');
  });
});
