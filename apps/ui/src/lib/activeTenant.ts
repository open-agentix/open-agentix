import { session } from '../auth/session';

/**
 * The tenant the user explicitly chose to act in (tenant switcher). It is sent as `X-OAX-Tenant`
 * with every API call, so it must be one place only: the api client reads it here.
 *
 * The UI is not a trust boundary. The value is never trusted by the console: the API refuses a
 * tenant the principal may not act in (404), and the console then falls back to the home tenant.
 * Storage is `sessionStorage` (per browser tab, gone when the tab closes) with an in-memory
 * fallback; it holds a tenant reference (id, slug, name), never a token.
 */
export interface ActiveTenantRef {
  id: string;
  slug: string;
  name: string;
}

export type ActiveTenantChange = 'switch' | 'stale' | 'reset';

const KEY = 'oax.tenant';
/** Tenant ids are UUIDs; slugs are `[a-z][a-z0-9-]*`. Anything else never reaches a header. */
const SAFE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

let memory: ActiveTenantRef | null = null;
const listeners = new Set<(reason: ActiveTenantChange) => void>();

function valid(v: unknown): v is ActiveTenantRef {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    SAFE.test(r.id) &&
    typeof r.slug === 'string' &&
    typeof r.name === 'string'
  );
}

function read(): ActiveTenantRef | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return valid(parsed) ? parsed : null;
  } catch {
    /* storage blocked or corrupt: fall back to memory */
    return memory;
  }
}

function write(value: ActiveTenantRef | null): void {
  memory = value;
  try {
    if (value) window.sessionStorage.setItem(KEY, JSON.stringify(value));
    else window.sessionStorage.removeItem(KEY);
  } catch {
    /* storage blocked */
  }
}

let staleNotice = false;
let snapshotRaw: string | null = null;
let snapshot: ActiveTenantRef | null = null;

export const activeTenant = {
  /** Current choice, or null (= the principal's home tenant, no header). */
  get(): ActiveTenantRef | null {
    return read();
  },
  /** Stable reference for `useSyncExternalStore`. */
  snapshot(): ActiveTenantRef | null {
    const current = read();
    const raw = current ? `${current.id}|${current.slug}|${current.name}` : null;
    if (raw !== snapshotRaw) {
      snapshotRaw = raw;
      snapshot = current;
    }
    return snapshot;
  },
  /** Header value for `X-OAX-Tenant`, or undefined without an explicit choice. */
  header(): string | undefined {
    const t = read();
    return t && SAFE.test(t.id) ? t.id : undefined;
  },
  set(tenant: ActiveTenantRef): void {
    if (!valid(tenant)) throw new Error('invalid tenant reference');
    write({ id: tenant.id, slug: tenant.slug, name: tenant.name });
    emit('switch');
  },
  clear(reason: Exclude<ActiveTenantChange, 'switch'> = 'reset'): void {
    if (!read()) return;
    write(null);
    if (reason === 'stale') staleNotice = true;
    emit(reason);
  },
  /** True once after a stale choice was dropped, even if that happened before the shell mounted. */
  takeStaleNotice(): boolean {
    const had = staleNotice;
    staleNotice = false;
    return had;
  },
  subscribe(listener: (reason: ActiveTenantChange) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

function emit(reason: ActiveTenantChange): void {
  for (const l of listeners) l(reason);
}

// A new or ended session never inherits the previous user's tenant choice.
session.subscribe(() => {
  write(null);
  emit('reset');
});
