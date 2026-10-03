import { fileURLToPath } from 'node:url';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import * as schema from './schema.js';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface Database {
  db: Db;
  kind: 'postgres' | 'pglite';
  ping(): Promise<boolean>;
  migrate(): Promise<void>;
  close(): Promise<void>;
}

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

export interface DatabaseOptions {
  url: string;
  poolMax?: number;
  statementTimeoutMs?: number;
}

/**
 * `postgres://...` uses a pg connection pool (prepared statements per connection);
 * `memory://` or `pglite://<dir>` uses embedded PGlite (tests, single-node demos).
 */
export async function createDatabase(opts: DatabaseOptions): Promise<Database> {
  if (opts.url.startsWith('memory://') || opts.url.startsWith('pglite://')) {
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    const dir = opts.url.startsWith('pglite://') ? opts.url.slice('pglite://'.length) : undefined;
    const client = new PGlite(dir);
    const db = drizzle(client, { schema }) as unknown as Db;
    return {
      db,
      kind: 'pglite',
      ping: async () => (await client.query('select 1')).rows.length === 1,
      migrate: () => migrate(db as never, { migrationsFolder: MIGRATIONS_FOLDER }),
      close: () => client.close(),
    };
  }
  const { Pool } = await import('pg');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const { migrate } = await import('drizzle-orm/node-postgres/migrator');
  const pool = new Pool({
    connectionString: opts.url,
    max: opts.poolMax ?? 20,
    statement_timeout: opts.statementTimeoutMs ?? 15_000,
    application_name: 'openagentix',
  });
  const db = drizzle(pool, { schema }) as unknown as Db;
  return {
    db,
    kind: 'postgres',
    ping: async () => {
      await db.execute(sql`select 1`);
      return true;
    },
    migrate: () => migrate(db as never, { migrationsFolder: MIGRATIONS_FOLDER }),
    close: () => pool.end(),
  };
}

export { schema };
