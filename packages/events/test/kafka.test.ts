import { StaticSecretResolver, type OaxEvent } from '@openagentix/core';
import { describe, expect, it } from 'vitest';
import {
  KafkaEventSource,
  KafkaSourceConfigSchema,
  buildKafkaClientConfig,
  kafkaMessageToEvent,
  kafkajsConsumerFactory,
  type ConsumerLike,
  type KafkaMessageLike,
} from '../src/index.js';

const secrets = new StaticSecretResolver({ 'kafka-pw': 'pw', ca: 'CA', cert: 'CERT', key: 'KEY' });

describe('kafka config', () => {
  it('builds SASL/TLS config with secret references', async () => {
    const cfg = KafkaSourceConfigSchema.parse({
      name: 'jira',
      brokers: ['b1:9093'],
      groupId: 'oax',
      topics: ['jira.issues'],
      ssl: { caSecret: 'ca', certSecret: 'cert', keySecret: 'key' },
      sasl: { mechanism: 'scram-sha-512', username: 'u', passwordSecret: 'kafka-pw' },
    });
    expect(await buildKafkaClientConfig(cfg, secrets)).toEqual({
      clientId: 'openagentix',
      brokers: ['b1:9093'],
      ssl: { rejectUnauthorized: true, ca: ['CA'], cert: 'CERT', key: 'KEY' },
      sasl: { mechanism: 'scram-sha-512', username: 'u', password: 'pw' },
    });
    const plain = KafkaSourceConfigSchema.parse({
      name: 'x',
      brokers: ['b'],
      groupId: 'g',
      topics: ['t'],
      ssl: true,
    });
    expect((await buildKafkaClientConfig(plain, secrets)).ssl).toBe(true);
    const none = KafkaSourceConfigSchema.parse({
      name: 'x',
      brokers: ['b'],
      groupId: 'g',
      topics: ['t'],
      ssl: {},
    });
    expect((await buildKafkaClientConfig(none, secrets)).ssl).toEqual({ rejectUnauthorized: true });
    expect(kafkajsConsumerFactory({ clientId: 'c', brokers: ['localhost:1'] }, 'g')).toBeTruthy();
  });
});

describe('kafkaMessageToEvent', () => {
  it('handles binary-mode CloudEvents', () => {
    const e = kafkaMessageToEvent('jira', 'jira.issues', 0, {
      value: Buffer.from('{"key":"SEC-1"}'),
      headers: {
        ce_specversion: Buffer.from('1.0'),
        ce_type: 'com.jira.created',
        ce_id: ['id-1'],
        ce_source: '/jira',
        ce_subject: 'SEC-1',
        ce_time: '2026-01-01T00:00:00Z',
      },
    });
    expect(e).toMatchObject({
      id: 'id-1',
      type: 'com.jira.created',
      source: '/jira',
      subject: 'SEC-1',
      data: { key: 'SEC-1' },
    });
    const minimal = kafkaMessageToEvent('jira', 't', 1, {
      value: null,
      offset: '7',
      headers: { ce_specversion: '1.0', ce_type: 'x', ce_id: undefined },
    });
    expect(minimal).toMatchObject({ id: 't-1-7', source: '/sources/kafka/jira', data: null });
  });
  it('handles structured CloudEvents and plain payloads', () => {
    const ce = { specversion: '1.0', id: '1', source: '/s', type: 't' };
    expect(kafkaMessageToEvent('k', 't', 0, { value: Buffer.from(JSON.stringify(ce)) })).toEqual(
      ce,
    );
    const plain = kafkaMessageToEvent('k', 'logs', 2, {
      key: Buffer.from('k1'),
      value: Buffer.from('not json'),
      offset: '5',
      timestamp: '0',
    });
    expect(plain).toMatchObject({
      id: 'logs-2-5',
      type: 'io.openagentix.kafka.message',
      subject: 'logs',
      time: '1970-01-01T00:00:00.000Z',
      data: { topic: 'logs', partition: 2, key: 'k1', value: 'not json' },
    });
    expect(kafkaMessageToEvent('k', 't', 0, { value: Buffer.from('{}') }).id).toBe('t-0-0');
  });
});

describe('KafkaEventSource with a fake consumer', () => {
  it('subscribes and dispatches messages', async () => {
    const log: string[] = [];
    let each:
      | ((p: { topic: string; partition: number; message: KafkaMessageLike }) => Promise<void>)
      | undefined;
    const consumer: ConsumerLike = {
      connect: async () => void log.push('connect'),
      subscribe: async (o) => void log.push(`subscribe:${o.topics.join(',')}:${o.fromBeginning}`),
      run: async (o) => {
        each = o.eachMessage;
        log.push('run');
      },
      disconnect: async () => void log.push('disconnect'),
    };
    const seen: OaxEvent[] = [];
    const src = new KafkaEventSource(
      KafkaSourceConfigSchema.parse({
        name: 'k',
        brokers: ['b'],
        groupId: 'g',
        topics: ['a', 'b'],
        fromBeginning: true,
      }),
      secrets,
      (config, groupId) => {
        log.push(`factory:${groupId}:${config.clientId}`);
        return consumer;
      },
    );
    await src.start(async (e) => void seen.push(e));
    await each?.({
      topic: 'a',
      partition: 0,
      message: { value: Buffer.from('{"x":1}'), offset: '1' },
    });
    await src.stop();
    await src.stop();
    expect(log).toEqual([
      'factory:g:openagentix',
      'connect',
      'subscribe:a,b:true',
      'run',
      'disconnect',
    ]);
    expect(seen[0]?.data).toMatchObject({ value: { x: 1 } });
  });
});
