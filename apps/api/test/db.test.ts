import { randomUUID } from 'node:crypto';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, schema, type Database } from '../src/db/client.js';

let database: Database;

beforeAll(async () => {
  database = await createDatabase({ url: 'memory://' });
  await database.migrate();
});
afterAll(async () => {
  await database.close();
});

const failure = (p: Promise<unknown>) =>
  p.then(
    () => 'no error',
    (e: unknown) => String((e as { cause?: Error }).cause?.message ?? (e as Error).message),
  );

const rows = async (q: ReturnType<typeof sql>) =>
  (await database.db.execute(q)) as unknown as { rows: Record<string, unknown>[] };

describe('migrations', () => {
  it('create every table of the drizzle schema', async () => {
    const { rows: tables } = await rows(
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const names = new Set(tables.map((t) => t.table_name));
    for (const table of Object.values(schema)) {
      if (typeof table === 'object' && table && Symbol.for('drizzle:IsDrizzleTable') in table) {
        expect(names.has(getTableConfig(table as never).name)).toBe(true);
      }
    }
    expect(await database.ping()).toBe(true);
    expect(database.kind).toBe('pglite');
  });

  it('keeps the audit log and agent versions append-only', async () => {
    await database.db
      .insert(schema.auditLog)
      .values({
        seq: 1,
        ts: new Date(),
        actor: 'a',
        action: 'x',
        payloadDigest: 'd',
        prevHash: 'p',
        hash: 'h',
      });
    expect(await failure(database.db.execute(sql`update audit_log set actor = 'mallory'`))).toMatch(
      /append-only/,
    );
    expect(await failure(database.db.execute(sql`delete from audit_log`))).toMatch(/append-only/);
    expect(await failure(database.db.execute(sql`truncate audit_log`))).toMatch(/append-only/);
    const agentId = randomUUID();
    const versionId = randomUUID();
    await database.db.insert(schema.agents).values({ id: agentId, name: 'x', draftSource: '' });
    await database.db
      .insert(schema.agentVersions)
      .values({
        id: versionId,
        agentId,
        version: '1.0.0',
        digest: 'd',
        source: 's',
        definition: {},
      });
    expect(
      await failure(database.db.execute(sql`update agent_versions set source = 'changed'`)),
    ).toMatch(/append-only/);
  });
});
