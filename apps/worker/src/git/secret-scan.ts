import { createHash } from 'node:crypto';
import { SECRET_PATTERNS } from '@openagentix/core';

/**
 * Scan of text that leaves the platform (patch, commit message, pull request title and body) for
 * credential-shaped strings (issue #140: test code can read secrets and write them into a file
 * that the patch delivers). Fail closed: any hit blocks delivery. The report names the pattern
 * and a digest of the match, never the match.
 *
 * Limits (stated honestly): a determined attacker can encode a secret beyond what is decoded here
 * (one level of base64 and hex, plus reversal). The scan is a tripwire in front of the human
 * review of the draft pull request, not a guarantee.
 */
export interface SecretHit {
  pattern: string;
  /** First 12 hex characters of the SHA-256 of the match (never the match). */
  digest: string;
  /** `plain`, `base64`, `hex` or `reversed`. */
  via: string;
}

const PATTERNS = SECRET_PATTERNS;

const dig = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 12);

function scanPlain(text: string, via: string, out: SecretHit[]): void {
  for (const [name, re] of PATTERNS) {
    const m = re.exec(text);
    if (m) out.push({ pattern: name, digest: dig(m[0]), via });
  }
}

function decodedViews(text: string): [string, string][] {
  const views: [string, string][] = [];
  const b64 = text.match(/[A-Za-z0-9+/_-]{24,}={0,2}/g) ?? [];
  const hex = text.match(/\b(?:[0-9a-fA-F]{2}){16,}\b/g) ?? [];
  const decoded: string[] = [];
  for (const chunk of b64.slice(0, 500)) {
    const d = Buffer.from(chunk, 'base64').toString('latin1');
    if (/^[\x20-\x7e\r\n\t]{12,}$/.test(d)) decoded.push(d);
  }
  for (const chunk of hex.slice(0, 200)) {
    const d = Buffer.from(chunk, 'hex').toString('latin1');
    if (/^[\x20-\x7e\r\n\t]{12,}$/.test(d)) views.push(['hex', d]);
  }
  for (const d of decoded) views.push(['base64', d]);
  return views;
}

/**
 * @param text what is about to leave the platform
 * @param known exact secret values of this process (tokens in use); matched in plain, base64,
 *   hex and reversed form, as a Git `Authorization` header value and as a URL-encoded value
 */
export function scanForSecrets(text: string, known: readonly string[] = []): SecretHit[] {
  const out: SecretHit[] = [];
  scanPlain(text, 'plain', out);
  for (const [via, view] of decodedViews(text)) scanPlain(view, via, out);
  const reversed = [...text].reverse().join('');
  scanPlain(reversed, 'reversed', out);
  for (const k of known) {
    if (k.length < 8) continue;
    const forms: [string, string][] = [
      ['plain', k],
      ['base64', Buffer.from(k).toString('base64')],
      ['base64', Buffer.from(`x-access-token:${k}`).toString('base64')],
      ['hex', Buffer.from(k).toString('hex')],
      ['reversed', [...k].reverse().join('')],
      ['url-encoded', encodeURIComponent(k)],
    ];
    for (const [via, form] of forms) {
      if (form.length >= 8 && (text.includes(form) || (via === 'plain' && reversed.includes(form))))
        out.push({ pattern: 'known-secret', digest: dig(form), via });
    }
    // split into chunks (a secret written across several lines/strings)
    const compact = text.replace(/["'+\s]/g, '');
    if (compact.includes(k))
      out.push({ pattern: 'known-secret', digest: dig(k), via: 'fragmented' });
  }
  const seen = new Set<string>();
  return out.filter((h) => {
    const key = `${h.pattern}:${h.digest}:${h.via}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
