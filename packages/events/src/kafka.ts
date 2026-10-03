import type { OaxEvent, SecretResolver } from '@openagentix/core';
import { Kafka, type KafkaConfig, type SASLOptions } from 'kafkajs';
import { z } from 'zod';
import { EVENT_TYPES, createEvent, isCloudEvent, parseCloudEvent, sourceUri } from './envelope.js';

export const KafkaSourceConfigSchema = z.strictObject({
  name: z.string().min(1),
  brokers: z.array(z.string().min(1)).min(1),
  clientId: z.string().default('openagentix'),
  groupId: z.string().min(1),
  topics: z.array(z.string().min(1)).min(1),
  fromBeginning: z.boolean().default(false),
  ssl: z
    .union([
      z.boolean(),
      z.strictObject({
        /** Secret references holding PEM material. */
        caSecret: z.string().optional(),
        certSecret: z.string().optional(),
        keySecret: z.string().optional(),
        rejectUnauthorized: z.boolean().default(true),
      }),
    ])
    .default(false),
  sasl: z
    .strictObject({
      mechanism: z.enum(['plain', 'scram-sha-256', 'scram-sha-512']),
      username: z.string().min(1),
      passwordSecret: z.string().min(1),
    })
    .optional(),
});
export type KafkaSourceConfig = z.infer<typeof KafkaSourceConfigSchema>;

/** Builds a kafkajs client config; secrets are resolved by reference at start-up. */
export async function buildKafkaClientConfig(
  cfg: KafkaSourceConfig,
  secrets: SecretResolver,
): Promise<KafkaConfig> {
  const config: KafkaConfig = { clientId: cfg.clientId, brokers: cfg.brokers };
  if (cfg.ssl === true) config.ssl = true;
  else if (cfg.ssl && typeof cfg.ssl === 'object') {
    config.ssl = {
      rejectUnauthorized: cfg.ssl.rejectUnauthorized,
      ...(cfg.ssl.caSecret ? { ca: [await secrets.resolve(cfg.ssl.caSecret)] } : {}),
      ...(cfg.ssl.certSecret ? { cert: await secrets.resolve(cfg.ssl.certSecret) } : {}),
      ...(cfg.ssl.keySecret ? { key: await secrets.resolve(cfg.ssl.keySecret) } : {}),
    };
  }
  if (cfg.sasl) {
    config.sasl = {
      mechanism: cfg.sasl.mechanism,
      username: cfg.sasl.username,
      password: await secrets.resolve(cfg.sasl.passwordSecret),
    } as SASLOptions;
  }
  return config;
}

export interface KafkaMessageLike {
  key?: Buffer | null;
  value: Buffer | null;
  offset?: string;
  timestamp?: string;
  headers?: Record<string, Buffer | string | (Buffer | string)[] | undefined>;
}

function headerString(v: Buffer | string | (Buffer | string)[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  const first = Array.isArray(v) ? v[0] : v;
  return first === undefined ? undefined : first.toString();
}

/**
 * Converts a Kafka record into an event: CloudEvents binary mode (`ce_*` headers), structured
 * mode (JSON body with `specversion`), or plain payloads wrapped as `io.openagentix.kafka.message`.
 */
export function kafkaMessageToEvent(
  sourceName: string,
  topic: string,
  partition: number,
  message: KafkaMessageLike,
): OaxEvent {
  const raw = message.value?.toString('utf8') ?? '';
  let data: unknown = raw;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    // keep as text
  }
  const h = message.headers ?? {};
  const ceType = headerString(h.ce_type);
  if (ceType && headerString(h.ce_specversion) === '1.0') {
    return parseCloudEvent({
      specversion: '1.0',
      id: headerString(h.ce_id) ?? `${topic}-${partition}-${message.offset ?? '0'}`,
      source: headerString(h.ce_source) ?? sourceUri('kafka', sourceName),
      type: ceType,
      ...(headerString(h.ce_subject) ? { subject: headerString(h.ce_subject) } : {}),
      ...(headerString(h.ce_time) ? { time: headerString(h.ce_time) } : {}),
      datacontenttype: headerString(h['content-type']) ?? 'application/json',
      data,
    });
  }
  if (isCloudEvent(data)) return parseCloudEvent(data);
  return createEvent({
    source: sourceUri('kafka', sourceName),
    type: EVENT_TYPES.kafka,
    id: `${topic}-${partition}-${message.offset ?? '0'}`,
    subject: topic,
    ...(message.timestamp ? { time: new Date(Number(message.timestamp)) } : {}),
    data: { topic, partition, key: message.key?.toString('utf8') ?? null, value: data },
  });
}

/** The part of a kafkajs consumer we use (allows a fake consumer in tests). */
export interface ConsumerLike {
  connect(): Promise<void>;
  subscribe(opts: { topics: string[]; fromBeginning: boolean }): Promise<void>;
  run(opts: {
    eachMessage: (p: {
      topic: string;
      partition: number;
      message: KafkaMessageLike;
    }) => Promise<void>;
  }): Promise<void>;
  disconnect(): Promise<void>;
}

export type ConsumerFactory = (config: KafkaConfig, groupId: string) => ConsumerLike;

export const kafkajsConsumerFactory: ConsumerFactory = (config, groupId) =>
  new Kafka(config).consumer({ groupId }) as unknown as ConsumerLike;

export class KafkaEventSource {
  private consumer: ConsumerLike | null = null;

  constructor(
    private readonly cfg: KafkaSourceConfig,
    private readonly secrets: SecretResolver,
    private readonly factory: ConsumerFactory = kafkajsConsumerFactory,
  ) {}

  /** Connects and dispatches every record; a throwing handler makes kafkajs retry the record. */
  async start(handler: (event: OaxEvent) => Promise<void>): Promise<void> {
    const config = await buildKafkaClientConfig(this.cfg, this.secrets);
    const consumer = this.factory(config, this.cfg.groupId);
    await consumer.connect();
    await consumer.subscribe({ topics: this.cfg.topics, fromBeginning: this.cfg.fromBeginning });
    this.consumer = consumer;
    await consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        await handler(kafkaMessageToEvent(this.cfg.name, topic, partition, message));
      },
    });
  }

  async stop(): Promise<void> {
    await this.consumer?.disconnect();
    this.consumer = null;
  }
}
