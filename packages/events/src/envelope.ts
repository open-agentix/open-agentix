import { randomUUID } from 'node:crypto';
import {
  OaxEventSchema,
  ValidationError,
  type Classification,
  type OaxEvent,
} from '@openagentix/core';

export const EVENT_TYPES = {
  webhook: 'io.openagentix.webhook.received',
  mail: 'io.openagentix.mail.received',
  cron: 'io.openagentix.cron.tick',
  kafka: 'io.openagentix.kafka.message',
  manual: 'io.openagentix.manual',
} as const;

export interface CreateEventInput {
  source: string;
  type: string;
  data?: unknown;
  id?: string;
  subject?: string;
  time?: Date;
  classification?: Classification;
  datacontenttype?: string;
}

/** Builds a CloudEvents 1.0 envelope. */
export function createEvent(input: CreateEventInput): OaxEvent {
  return {
    specversion: '1.0',
    id: input.id ?? randomUUID(),
    source: input.source,
    type: input.type,
    time: (input.time ?? new Date()).toISOString(),
    datacontenttype: input.datacontenttype ?? 'application/json',
    ...(input.subject !== undefined ? { subject: input.subject } : {}),
    ...(input.classification ? { oaxclassification: input.classification } : {}),
    data: input.data ?? null,
  };
}

export function isCloudEvent(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as Record<string, unknown>).specversion === '1.0' &&
    typeof (value as Record<string, unknown>).type === 'string'
  );
}

/** Validates an incoming structured-mode CloudEvent. */
export function parseCloudEvent(value: unknown): OaxEvent {
  const r = OaxEventSchema.safeParse(value);
  if (!r.success) {
    throw new ValidationError(
      'invalid CloudEvent',
      r.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
    );
  }
  return r.data;
}

/** Source URI convention for configured event sources. */
export function sourceUri(kind: string, name: string): string {
  return `/sources/${kind}/${name}`;
}
