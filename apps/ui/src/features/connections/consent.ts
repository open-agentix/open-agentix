/**
 * The console's half of the OAuth consent binding (ADR 0016 section 7.2). When a consent starts the
 * console keeps a random nonce in the session storage of this tab and sends only its SHA-256 to the
 * control node. The authorization server sends the browser back with `state`, `code` and `iss` in
 * the URL fragment; only a tab that holds the nonce can complete the consent. A link forwarded to
 * someone else leads to a console that has no nonce and therefore completes nothing.
 */
const KEY = 'oax.mcp.consent';

interface Stored {
  connectionId: string;
  nonce: string;
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A fresh nonce (256 bits) and its hash; the nonce is not kept until {@link rememberConsent}. */
export async function newNonce(): Promise<{ nonce: string; hash: string }> {
  const nonce = b64url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  return { nonce, hash: await sha256Hex(nonce) };
}

export function rememberConsent(connectionId: string, nonce: string): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify({ connectionId, nonce } satisfies Stored));
  } catch {
    // storage blocked: the consent cannot be completed in this tab, and the user is told so
  }
}

/** Reads and removes the consent this tab started, if any. */
export function takeConsent(): Stored | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    window.sessionStorage.removeItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Stored>;
    return typeof v.connectionId === 'string' && typeof v.nonce === 'string'
      ? { connectionId: v.connectionId, nonce: v.nonce }
      : null;
  } catch {
    return null;
  }
}

export interface ReturnedConsent {
  state: string;
  code?: string;
  iss?: string;
  error?: string;
}

/**
 * The answer of the authorization server as the callback put it in the fragment. The fragment is
 * removed from the address bar at once (history entry, not just the display).
 */
export function takeReturnedConsent(): ReturnedConsent | null {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return null;
  const q = new URLSearchParams(hash);
  const state = q.get('oauth_state');
  if (!state) return null;
  window.history.replaceState(
    window.history.state,
    '',
    window.location.pathname + window.location.search,
  );
  return {
    state,
    ...(q.has('oauth_code') ? { code: q.get('oauth_code') as string } : {}),
    ...(q.has('oauth_iss') ? { iss: q.get('oauth_iss') as string } : {}),
    ...(q.has('oauth_error') ? { error: q.get('oauth_error') as string } : {}),
  };
}
