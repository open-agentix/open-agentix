/** Number of deterministic tenant colour tokens (`--tenant-N-bg/fg` in styles/tokens.css). */
export const TENANT_COLORS = 12;

/** Stable colour index for a tenant: FNV-1a hash of its id (falls back to the slug). */
export function tenantColorIndex(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % TENANT_COLORS;
}

/** Two initials for the tile: first letters of the first two words, or the first two letters. */
export function tenantInitials(name: string): string {
  const words = name
    .trim()
    .split(/[\s\-_/.]+/)
    .filter(Boolean);
  const letters =
    words.length >= 2 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}
