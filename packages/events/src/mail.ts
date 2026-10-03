import type { OaxEvent } from '@openagentix/core';
import { z } from 'zod';
import { EVENT_TYPES, createEvent, sourceUri } from './envelope.js';

/**
 * Mail-in via webhook (e.g. a Cloudflare Email Routing worker or an IMAP bridge posting JSON).
 * The HTTP request itself is authenticated with the webhook signature scheme.
 */
export const MailPayloadSchema = z.object({
  from: z.string().min(3),
  to: z.union([z.string(), z.array(z.string())]),
  subject: z.string().default(''),
  text: z.string().optional(),
  html: z.string().optional(),
  messageId: z.string().optional(),
  date: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});
export type MailPayload = z.infer<typeof MailPayloadSchema>;

/** Very small HTML-to-text fallback for mails without a text part. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function mailToEvent(
  sourceName: string,
  payload: unknown,
  maxBodyChars = 100_000,
): OaxEvent {
  const mail = MailPayloadSchema.parse(payload);
  const body = (mail.text ?? (mail.html ? htmlToText(mail.html) : '')).slice(0, maxBodyChars);
  return createEvent({
    source: sourceUri('mail', sourceName),
    type: EVENT_TYPES.mail,
    subject: mail.subject,
    ...(mail.messageId ? { id: mail.messageId } : {}),
    data: {
      from: mail.from,
      to: Array.isArray(mail.to) ? mail.to : [mail.to],
      subject: mail.subject,
      body,
      date: mail.date ?? null,
    },
  });
}
