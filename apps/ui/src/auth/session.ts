/**
 * Session token storage. The token lives in sessionStorage (scoped to the tab, gone when the
 * browser closes) with an in-memory fallback when storage is unavailable.
 */
const KEY = 'oax.session';

interface Stored {
  token: string;
  expiresAt: string;
}

type Listener = (reason: 'login' | 'logout' | 'expired') => void;

let memory: Stored | null = null;
const listeners = new Set<Listener>();

function read(): Stored | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Stored;
  } catch {
    /* storage blocked: fall back to memory */
  }
  return memory;
}

function write(value: Stored | null): void {
  memory = value;
  try {
    if (value) window.sessionStorage.setItem(KEY, JSON.stringify(value));
    else window.sessionStorage.removeItem(KEY);
  } catch {
    /* storage blocked */
  }
}

function emit(reason: Parameters<Listener>[0]): void {
  for (const l of listeners) l(reason);
}

export const session = {
  token(now: number = Date.now()): string | null {
    const s = read();
    if (!s) return null;
    if (Date.parse(s.expiresAt) <= now) {
      write(null);
      return null;
    }
    return s.token;
  },
  set(token: string, expiresAt: string): void {
    write({ token, expiresAt });
    emit('login');
  },
  clear(): void {
    write(null);
    emit('logout');
  },
  expire(): void {
    write(null);
    emit('expired');
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
