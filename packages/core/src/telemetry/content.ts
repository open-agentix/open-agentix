import type { ContextGuard } from '../context-guard.js';
import { redactPii, type PiiKind } from '../pii.js';

/**
 * Gated content capture (ADR 0015 section 5.4, slice S10): the text of the model's input and
 * output messages, built for the one place that may carry it, a tenant-owned exporter. This module
 * is pure; the decision whether content may be captured at all (operator allow, tenant opt-in,
 * clearance, region) is made by the caller.
 *
 * What is captured, and what never is:
 * - system, user and assistant TEXT only. Messages of the `tool` role, tool calls of assistant
 *   messages (arguments) and every non-text part are never read, so a tool argument or result cannot
 *   reach a span through this path;
 * - every text passes the secret guard (known secrets, token shapes, invisible characters) and then
 *   the personal data redactor of ADR 0012 section 7.3;
 * - each attribute is at most {@link CONTENT_MAX_BYTES} bytes of UTF-8 JSON; when the input is longer,
 *   the newest messages are kept and the cut text is truncated.
 */

export const CONTENT_MAX_BYTES = 8 * 1024;
export const CONTENT_INPUT_KEY = 'gen_ai.input.messages';
export const CONTENT_OUTPUT_KEY = 'gen_ai.output.messages';
export const CONTENT_KEYS: readonly string[] = [CONTENT_INPUT_KEY, CONTENT_OUTPUT_KEY];

/** Characters of one message that are scanned for secrets and personal data (the tail is kept). */
const SCAN_MAX_CHARS = 32_768;
/** Messages scanned per attribute, newest first. */
const MAX_MESSAGES = 64;

export interface ContentMessage {
  role: string;
  content?: unknown;
}

export interface ContentRedactions {
  /** Replacements made by the secret guard. */
  secrets: number;
  /** Replacements by the personal data redactor, per kind. */
  pii: Partial<Record<PiiKind, number>>;
}

export interface ContentAttributes {
  attributes: Partial<Record<typeof CONTENT_INPUT_KEY | typeof CONTENT_OUTPUT_KEY, string>>;
  truncated: boolean;
  redactions: ContentRedactions;
}

const TEXT_ROLES = new Set(['system', 'user', 'assistant']);
const byteLength = (s: string) => Buffer.byteLength(s, 'utf8');

/** The tail of a long text, without the (possibly cut) first word, so a cut token is never scanned. */
function scanWindow(text: string): string {
  if (text.length <= SCAN_MAX_CHARS) return text;
  const tail = text.slice(text.length - SCAN_MAX_CHARS);
  const ws = tail.search(/\s/);
  return ws < 0 ? '' : tail.slice(ws + 1);
}

function clean(text: string, guard: ContextGuard, acc: ContentRedactions): string {
  const g = guard.text(scanWindow(text));
  acc.secrets += g.report.secrets.total + g.report.invisible.total;
  const p = redactPii(g.text);
  for (const [k, n] of Object.entries(p.counts) as [PiiKind, number][])
    acc.pii[k] = (acc.pii[k] ?? 0) + n;
  return p.text;
}

function serialize(role: string, text: string): string {
  return JSON.stringify({ role, parts: [{ type: 'text', content: text }] });
}

/** Cuts `text` at a code point boundary so that the serialised message fits `budget` bytes. */
function fit(role: string, text: string, budget: number): string | null {
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    let cut = text.slice(0, mid);
    // Never end in the middle of a surrogate pair.
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
    if (byteLength(serialize(role, cut)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  let best = text.slice(0, lo);
  if (/[\uD800-\uDBFF]$/.test(best)) best = best.slice(0, -1);
  const out = serialize(role, best);
  return byteLength(out) <= budget ? out : null;
}

/** One attribute value: a JSON array of the newest messages that fit the cap. */
function pack(
  entries: readonly { role: string; text: string }[],
): { value: string; truncated: boolean } | null {
  if (entries.length === 0) return null;
  const kept: string[] = [];
  let used = 2; // the brackets
  let truncated = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    const s = serialize(e.role, e.text);
    const size = byteLength(s) + (kept.length > 0 ? 1 : 0);
    if (used + size <= CONTENT_MAX_BYTES) {
      kept.unshift(s);
      used += size;
      continue;
    }
    truncated = true;
    // Older messages are dropped; the first one that does not fit is cut when nothing is kept yet.
    if (kept.length === 0) {
      const cut = fit(e.role, e.text, CONTENT_MAX_BYTES - 2);
      if (cut) kept.unshift(cut);
    }
    break;
  }
  if (kept.length < entries.length) truncated = true;
  if (kept.length === 0) return null;
  const value = `[${kept.join(',')}]`;
  return byteLength(value) <= CONTENT_MAX_BYTES ? { value, truncated } : null;
}

/**
 * Builds the two content attributes of a model call. `input.messages` holds the system text and the
 * messages of the call, `output` the text of the response (tool calls of the response are ignored).
 */
export function buildContentAttributes(
  call: { system?: string | undefined; messages: readonly ContentMessage[]; outputText: string },
  guard: ContextGuard,
): ContentAttributes {
  const redactions: ContentRedactions = { secrets: 0, pii: {} };
  const input: { role: string; text: string }[] = [];
  if (typeof call.system === 'string' && call.system !== '')
    input.push({ role: 'system', text: call.system });
  for (const m of call.messages) {
    if (!TEXT_ROLES.has(m.role) || typeof m.content !== 'string' || m.content === '') continue;
    input.push({ role: m.role, text: m.content });
  }
  // Newest messages first for the bound, then cleaned (an older message is never scanned).
  const recent = input.slice(-MAX_MESSAGES);
  const cleanedIn = recent
    .map((e) => ({ role: e.role, text: clean(e.text, guard, redactions) }))
    .filter((e) => e.text !== '');
  const attributes: ContentAttributes['attributes'] = {};
  let truncated = recent.length < input.length;
  const packedIn = pack(cleanedIn);
  if (packedIn) {
    attributes[CONTENT_INPUT_KEY] = packedIn.value;
    truncated ||= packedIn.truncated;
  }
  if (typeof call.outputText === 'string' && call.outputText !== '') {
    const out = clean(call.outputText, guard, redactions);
    const packedOut = out === '' ? null : pack([{ role: 'assistant', text: out }]);
    if (packedOut) {
      attributes[CONTENT_OUTPUT_KEY] = packedOut.value;
      truncated ||= packedOut.truncated;
    }
  }
  return { attributes, truncated, redactions };
}
