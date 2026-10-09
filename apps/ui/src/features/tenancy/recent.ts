/** Recently used tenants of the switcher: ids in `localStorage`, one list per user. */
export const MAX_RECENT = 5;

const key = (userId: string) => `oax.recentTenants.${userId}`;

const memory = new Map<string, string[]>();

export function readRecent(userId: string): string[] {
  try {
    const raw = window.localStorage.getItem(key(userId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === 'string').slice(0, MAX_RECENT)
      : [];
  } catch {
    /* storage blocked or corrupt: the list of this page only */
    return memory.get(userId) ?? [];
  }
}

/** Moves the tenant to the front (deduplicated, at most five) and returns the new list. */
export function pushRecent(userId: string, tenantId: string): string[] {
  const next = [tenantId, ...readRecent(userId).filter((id) => id !== tenantId)].slice(
    0,
    MAX_RECENT,
  );
  memory.set(userId, next);
  try {
    window.localStorage.setItem(key(userId), JSON.stringify(next));
  } catch {
    /* storage blocked: the list lives for this page only */
  }
  return next;
}
