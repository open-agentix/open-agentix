/**
 * Persistence for the guided demo tour. Everything degrades gracefully: localStorage first, then
 * sessionStorage, then a module variable (blocked storage never breaks the tour; no cookies).
 */
const DISMISSED_KEY = 'oax.tour.dismissed';
const AUTOSTARTED_KEY = 'oax.tour.autostarted';
const REQUESTED_KEY = 'oax.tour.requested';

type Kind = 'local' | 'session';

const memory = new Map<string, string>();

function area(kind: Kind): Storage | null {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

function read(key: string, kinds: Kind[]): string | null {
  for (const kind of kinds) {
    try {
      const value = area(kind)?.getItem(key);
      if (value !== null && value !== undefined) return value;
    } catch {
      /* try the next area */
    }
  }
  return memory.get(key) ?? null;
}

function write(key: string, value: string, kinds: Kind[]): void {
  for (const kind of kinds) {
    try {
      const store = area(kind);
      if (store) {
        store.setItem(key, value);
        memory.delete(key);
        return;
      }
    } catch {
      /* quota or blocked: try the next area */
    }
  }
  memory.set(key, value);
}

function remove(key: string, kinds: Kind[]): void {
  memory.delete(key);
  for (const kind of kinds) {
    try {
      area(kind)?.removeItem(key);
    } catch {
      /* nothing to remove */
    }
  }
}

/** "Don't show this again" is set (persistent; session-only when storage is blocked). */
export function isDismissed(): boolean {
  return read(DISMISSED_KEY, ['local', 'session']) === '1';
}

export function setDismissed(dismissed: boolean): void {
  if (dismissed) write(DISMISSED_KEY, '1', ['local', 'session']);
  else remove(DISMISSED_KEY, ['local', 'session']);
}

/** The tour already started on its own in this browser session (it auto-starts once). */
export function wasAutoStarted(): boolean {
  return read(AUTOSTARTED_KEY, ['session']) === '1';
}

export function markAutoStarted(): void {
  write(AUTOSTARTED_KEY, '1', ['session']);
}

/** A visitor asked for the tour before signing in (login page link); consumed once. */
export function requestTour(): void {
  write(REQUESTED_KEY, '1', ['session']);
}

export function takeTourRequest(): boolean {
  const requested = read(REQUESTED_KEY, ['session']) === '1';
  if (requested) remove(REQUESTED_KEY, ['session']);
  return requested;
}

/** Clears every tour flag (used by tests and by "reset the tour"). */
export function resetTour(): void {
  for (const key of [DISMISSED_KEY, AUTOSTARTED_KEY, REQUESTED_KEY]) {
    remove(key, ['local', 'session']);
  }
}
