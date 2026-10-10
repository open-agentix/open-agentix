import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/** Minimal adapter so that the same checks run on PGlite and on a real PostgreSQL. */
export interface Sql {
  query<T = Record<string, unknown>>(q: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(q: string): Promise<unknown>;
  /** Runs a multi-statement script on one connection; a failure inside BEGIN/COMMIT rolls back. */
  script(q: string): Promise<unknown>;
  migrate(folder: string): Promise<void>;
  /** A dedicated connection (real PostgreSQL only) for tests that need two open transactions. */
  session?: () => Promise<{
    query: (q: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
    release: () => void;
  }>;
  close(): Promise<void>;
  /** Connection string for a control node on this database (memory:// for PGlite). */
  url: string;
}

export const PG_URL = process.env.OAX_TEST_DATABASE_URL;

export async function openPglite(): Promise<Sql> {
  const c = new PGlite();
  return {
    query: (q, params) => c.query(q, params) as never,
    exec: (q) => c.exec(q),
    script: (q) =>
      c.exec(q).catch(async (e: unknown) => {
        await c.exec('rollback');
        throw e;
      }),
    url: 'memory://',
    migrate: (folder) => migrate(drizzle(c) as never, { migrationsFolder: folder }),
    close: () => c.close(),
  };
}

/** A throwaway database on the server of OAX_TEST_DATABASE_URL, dropped on close. */
export async function openPostgres(): Promise<Sql> {
  const name = `w13_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  await admin.query(`create database ${name}`);
  const url = new URL(PG_URL!);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  return {
    query: (q, params) => pool.query(q, params) as never,
    exec: (q) => pool.query(q),
    url: url.toString(),
    script: async (q) => {
      const c = await pool.connect();
      try {
        return await c.query(q);
      } catch (e) {
        await c.query('rollback');
        throw e;
      } finally {
        c.release();
      }
    },
    migrate: (folder) => migratePg(drizzlePg(pool) as never, { migrationsFolder: folder }),
    session: async () => {
      const c = await pool.connect();
      return { query: (q, params) => c.query(q, params) as never, release: () => c.release() };
    },
    close: async () => {
      await pool.end();
      // No `with (force)`: terminating a connection that is still closing surfaces as an uncaught
      // error of the application pool. Wait until the server has seen every client leave instead.
      for (let attempt = 0; ; attempt++) {
        try {
          await admin.query(`drop database ${name}`);
          break;
        } catch (e) {
          if ((e as { code?: string }).code !== '55006' || attempt >= 50) throw e;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      await admin.end();
    },
  };
}

export const sqlTargets: [string, () => boolean, () => Promise<Sql>][] = [
  ['PGlite', () => true, openPglite],
  ['PostgreSQL', () => !!PG_URL, openPostgres],
];

/** The message of the database error behind a rejected promise (or 'no error'). */
export const failure = (p: Promise<unknown>) =>
  p.then(
    () => 'no error',
    (e: unknown) => String((e as { cause?: Error }).cause?.message ?? (e as Error).message),
  );

/** The SQLSTATE of a rejected database call, if any. */
export const sqlState = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) =>
      (e as { cause?: { code?: string }; code?: string }).cause?.code ??
      (e as { code?: string }).code,
  );
