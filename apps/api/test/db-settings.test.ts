import { describe, expect, it } from 'vitest';
import { createDatabase, expectedMigrations, waitForDatabase } from '../src/db/client.js';
import { loadDatabaseConfig } from '../src/db/settings.js';
import { loadConfig } from '../src/config.js';

describe('loadDatabaseConfig', () => {
  it('uses the URL and a separate password', () => {
    const c = loadDatabaseConfig({
      OAX_DATABASE_URL: 'postgres://app@db:5432/oax',
      OAX_DATABASE_PASSWORD: 'p@ss:w/rd',
      OAX_DB_STATEMENT_TIMEOUT_MS: '5000',
    });
    expect(c).toMatchObject({
      url: 'postgres://app@db:5432/oax',
      password: 'p@ss:w/rd',
      statementTimeoutMs: 5000,
      migrateOnStart: true,
      connectRetries: 30,
    });
  });

  it('builds the URL from PG* variables', () => {
    const c = loadDatabaseConfig({
      PGHOST: 'db.internal',
      PGUSER: 'app user',
      PGPASSWORD: 'secret',
      PGDATABASE: 'oax',
      PGSSLMODE: 'require',
      PGPORT: '6432',
    });
    expect(c.url).toBe('postgres://app%20user@db.internal:6432/oax?sslmode=require');
    expect(c.password).toBe('secret');
    expect(loadDatabaseConfig({ PGHOST: 'h' }).url).toBe('postgres://h:5432/openagentix');
  });

  it('rejects missing or invalid settings and needs no other configuration', () => {
    expect(() => loadDatabaseConfig({})).toThrow(/OAX_DATABASE_URL or PGHOST/);
    expect(() => loadDatabaseConfig({ PGHOST: 'h', PGSSLMODE: 'bogus' })).toThrow(
      /invalid database configuration/,
    );
    // The migration job does not need OAX_RUN_TOKEN_SECRET even in production.
    expect(loadDatabaseConfig({ NODE_ENV: 'production', OAX_DATABASE_URL: 'memory://' }).url).toBe(
      'memory://',
    );
    expect(
      loadConfig({ NODE_ENV: 'test', PGHOST: 'db', OAX_DATABASE_PASSWORD: 'x' }).database.password,
    ).toBe('x');
  });
});

describe('migrations and readiness', () => {
  it('migrates idempotently under the advisory lock and reports the schema status', async () => {
    const db = await createDatabase({ url: 'memory://' });
    expect(await db.schemaStatus()).toEqual({
      expected: expectedMigrations(),
      applied: 0,
      ok: false,
    });
    await db.migrate();
    await db.migrate();
    expect(await db.schemaStatus()).toEqual({ expected: 2, applied: 2, ok: true });
    await db.close();
  });

  it('waits for the database with backoff and gives up after the retries', async () => {
    let calls = 0;
    const retries: number[] = [];
    await waitForDatabase(
      { ping: async () => (++calls < 3 ? Promise.reject(new Error('ECONNREFUSED')) : true) },
      5,
      1,
      (a) => retries.push(a),
    );
    expect(retries).toEqual([1, 2]);
    await expect(waitForDatabase({ ping: async () => false }, 1, 1)).rejects.toThrow(
      /ping returned false/,
    );
  });
});
