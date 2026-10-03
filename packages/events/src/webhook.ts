import { createHmac, timingSafeEqual } from 'node:crypto';
import { OaxError, type OaxEvent } from '@openagentix/core';
import { EVENT_TYPES, createEvent, isCloudEvent, parseCloudEvent, sourceUri } from './envelope.js';

/**
 * Inbound webhooks: HMAC-SHA256 signatures + replay protection.
 *
 * Scheme `oax-v1` (default): headers `x-oax-timestamp: <unix seconds>`,
 * `x-oax-signature: v1=<hex hmac(secret, "<timestamp>.<raw body>")>` and optional
 * `x-oax-delivery: <unique id>`. Several `v1=` values (comma separated) allow secret rotation.
 *
 * Scheme `github`: `x-hub-signature-256: sha256=<hex hmac(secret, raw body)>`, replay protection
 * via `x-github-delivery`.
 */
export type WebhookScheme = 'oax-v1' | 'github';

export class WebhookError extends OaxError {
  constructor(
    code:
      | 'signature_missing'
      | 'signature_invalid'
      | 'timestamp_invalid'
      | 'replayed'
      | 'payload_invalid',
    message: string,
  ) {
    super(code, message);
  }
}

/** Remembers seen delivery ids; implementations: in-memory (single node) or database (cluster). */
export interface ReplayGuard {
  /** Returns false if the id was already seen within the TTL (and records it otherwise). */
  checkAndRemember(key: string, ttlMs: number): Promise<boolean>;
}

export class MemoryReplayGuard implements ReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly maxEntries = 100_000,
    private readonly now: () => number = Date.now,
  ) {}

  async checkAndRemember(key: string, ttlMs: number): Promise<boolean> {
    const t = this.now();
    const expires = this.seen.get(key);
    if (expires !== undefined && expires > t) return false;
    this.seen.delete(key);
    this.seen.set(key, t + ttlMs);
    if (this.seen.size > this.maxEntries) {
      for (const [k, exp] of this.seen) {
        if (exp <= t || this.seen.size > this.maxEntries) this.seen.delete(k);
        else break;
      }
    }
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}

export type HeaderBag = Record<string, string | string[] | undefined>;

function header(headers: HeaderBag, name: string): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function hmacHex(secret: string, data: string | Buffer): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}

/** Produces the headers a sender must set for the `oax-v1` scheme (used by clients and tests). */
export function signWebhook(
  secret: string,
  rawBody: string | Buffer,
  timestamp: number,
  deliveryId?: string,
): Record<string, string> {
  const sig = hmacHex(secret, Buffer.concat([Buffer.from(`${timestamp}.`), Buffer.from(rawBody)]));
  return {
    'x-oax-timestamp': String(timestamp),
    'x-oax-signature': `v1=${sig}`,
    ...(deliveryId ? { 'x-oax-delivery': deliveryId } : {}),
  };
}

export function signGithubWebhook(secret: string, rawBody: string | Buffer): string {
  return `sha256=${hmacHex(secret, rawBody)}`;
}

export interface VerifyWebhookInput {
  scheme: WebhookScheme;
  /** Current and (during rotation) previous secret. */
  secrets: readonly string[];
  headers: HeaderBag;
  rawBody: string | Buffer;
  replayGuard: ReplayGuard;
  /** Allowed clock skew for `oax-v1` timestamps (default 300 s). */
  toleranceSeconds?: number;
  now?: () => number;
}

export interface VerifiedWebhook {
  deliveryId: string;
}

export async function verifyWebhook(input: VerifyWebhookInput): Promise<VerifiedWebhook> {
  const body = Buffer.from(input.rawBody);
  const now = (input.now ?? Date.now)();
  const tolerance = (input.toleranceSeconds ?? 300) * 1000;
  let deliveryId: string;
  if (input.scheme === 'github') {
    const sig = header(input.headers, 'x-hub-signature-256');
    if (!sig?.startsWith('sha256='))
      throw new WebhookError('signature_missing', 'missing x-hub-signature-256');
    const given = sig.slice(7);
    if (!input.secrets.some((s) => safeEqualHex(hmacHex(s, body), given))) {
      throw new WebhookError('signature_invalid', 'webhook signature does not match');
    }
    deliveryId = header(input.headers, 'x-github-delivery') ?? given;
  } else {
    const ts = header(input.headers, 'x-oax-timestamp');
    const sig = header(input.headers, 'x-oax-signature');
    if (!ts || !sig)
      throw new WebhookError('signature_missing', 'missing x-oax-timestamp or x-oax-signature');
    if (!/^\d{1,12}$/.test(ts) || Math.abs(now - Number(ts) * 1000) > tolerance) {
      throw new WebhookError(
        'timestamp_invalid',
        'timestamp is invalid or outside the allowed window',
      );
    }
    const candidates = sig
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.startsWith('v1='))
      .map((p) => p.slice(3));
    const signed = Buffer.concat([Buffer.from(`${ts}.`), body]);
    const ok = input.secrets.some((s) => {
      const expected = hmacHex(s, signed);
      return candidates.some((c) => safeEqualHex(expected, c));
    });
    if (!ok) throw new WebhookError('signature_invalid', 'webhook signature does not match');
    deliveryId = header(input.headers, 'x-oax-delivery') ?? `${ts}:${candidates[0]}`;
  }
  // Remember for twice the tolerance so a replay inside the window is always caught.
  if (!(await input.replayGuard.checkAndRemember(deliveryId, tolerance * 2))) {
    throw new WebhookError('replayed', `delivery ${deliveryId} was already processed`);
  }
  return { deliveryId };
}

export interface WebhookEventInput {
  sourceName: string;
  rawBody: string | Buffer;
  contentType?: string | undefined;
  deliveryId?: string;
  maxBytes?: number;
}

/**
 * Normalises a verified webhook body: structured CloudEvents are validated and kept, any other
 * JSON (or text) is wrapped into a `io.openagentix.webhook.received` event.
 */
export function webhookToEvent(input: WebhookEventInput): OaxEvent {
  const buf = Buffer.from(input.rawBody);
  if (buf.length > (input.maxBytes ?? 1024 * 1024)) {
    throw new WebhookError('payload_invalid', 'payload too large');
  }
  const text = buf.toString('utf8');
  const isJson = !input.contentType || /json/i.test(input.contentType);
  let data: unknown = text;
  if (isJson) {
    try {
      data = text.length ? JSON.parse(text) : null;
    } catch {
      throw new WebhookError('payload_invalid', 'body is not valid JSON');
    }
  }
  if (isCloudEvent(data)) return parseCloudEvent(data);
  return createEvent({
    source: sourceUri('webhook', input.sourceName),
    type: EVENT_TYPES.webhook,
    data,
    ...(input.deliveryId ? { id: input.deliveryId } : {}),
    datacontenttype: isJson ? 'application/json' : (input.contentType ?? 'text/plain'),
  });
}
