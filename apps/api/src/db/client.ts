import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import * as schema from './schema.js';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface SchemaStatus {
  /** Migrations shipped with this build. */
  expected: number;
  /** Migrations applied in the database. */
  applied: number;
  /** True when the database has at least the migrations this build needs. */
  ok: boolean;
}

export interface Database {
  db: Db;
  kind: 'postgres' | 'pglite';
  ping(): Promise<boolean>;
  /** Applies pending migrations under a Postgres advisory lock (safe with concurrent replicas). */
  migrate(): Promise<void>;
  schemaStatus(): Promise<SchemaStatus>;
  close(): Promise<void>;
}

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));
/** Advisory lock key used around migrations. */
export const MIGRATION_LOCK = 734_202;

export function expectedMigrations(folder = MIGRATIONS_FOLDER): number {
  const journal = JSON.parse(readFileSync(`${folder}/meta/_journal.json`, 'utf8')) as {
    entries: unknown[];
  };
  return journal.entries.length;
}

export interface DatabaseOptions {
  url: string;
  /** Overrides the password of the URL (no URL encoding needed). */
  password?: string | undefined;
  poolMax?: number;
  statementTimeoutMs?: number;
}

async function appliedMigrations(db: Db): Promise<number> {
  try {
    const res = (await db.execute(
      sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
    )) as unknown as { rows: { n: number }[] };
    return Number(res.rows[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

/**
 * `postgres://...` uses a pg connection pool (prepared statements per connection);
 * `memory://` or `pglite://<dir>` uses embedded PGlite (tests, single-node demos).
 */
export async function createDatabase(opts: DatabaseOptions): Promise<Database> {
  const expected = expectedMigrations();
  const status = async (db: Db): Promise<SchemaStatus> => {
    const applied = await appliedMigrations(db);
    return { expected, applied, ok: applied >= expected };
  };
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
      migrate: async () => {
        await client.query(`select pg_advisory_lock(${MIGRATION_LOCK})`);
        try {
          await migrate(db as never, { migrationsFolder: MIGRATIONS_FOLDER });
        } finally {
          await client.query(`select pg_advisory_unlock(${MIGRATION_LOCK})`);
        }
      },
      schemaStatus: () => status(db),
      close: () => client.close(),
    };
  }
  const { Pool } = await import('pg');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const { migrate } = await import('drizzle-orm/node-postgres/migrator');
  const pool = new Pool({
    connectionString: opts.url,
    ...(opts.password !== undefined ? { password: opts.password } : {}),
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
    migrate: async () => {
      // One session holds the lock and runs the migrations (Helm hook and replicas may race).
      const client = await pool.connect();
      try {
        await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK]);
        await migrate(drizzle(client, { schema }) as never, {
          migrationsFolder: MIGRATIONS_FOLDER,
        });
      } finally {
        await client
          .query('select pg_advisory_unlock($1)', [MIGRATION_LOCK])
          .catch(() => undefined);
        client.release();
      }
    },
    schemaStatus: () => status(db),
    close: () => pool.end(),
  };
}

/** Waits until the database answers, with exponential backoff (capped at 5 s). */
export async function waitForDatabase(
  database: Pick<Database, 'ping'>,
  retries = 30,
  backoffMs = 500,
  onRetry?: (attempt: number, error: unknown) => void,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      if (await database.ping()) return;
      throw new Error('database ping returned false');
    } catch (e) {
      if (attempt >= retries) throw e;
      onRetry?.(attempt + 1, e);
      await new Promise((r) => setTimeout(r, Math.min(5000, backoffMs * 2 ** attempt)));
    }
  }
}

export { schema };
