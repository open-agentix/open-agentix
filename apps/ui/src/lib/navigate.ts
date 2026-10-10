/**
 * Leaves the console for an authorization server (the consent of an OAuth connection). Only http(s)
 * URLs are followed. A seam of its own so that tests can observe the destination.
 */
export function navigateTo(url: string): void {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('unsupported URL scheme');
  window.location.assign(u.toString());
}
