import { OaxError } from '@openagentix/core';
import { z } from 'zod';

/**
 * Database settings, loadable on their own (the migration Job needs nothing else).
 * Either OAX_DATABASE_URL or libpq-style PG* variables; the password may be given separately
 * (OAX_DATABASE_PASSWORD or PGPASSWORD) so it never has to be URL-encoded.
 */
const int = (def: number) => z.coerce.number().int().nonnegative().default(def);
const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

export const DbEnvSchema = z.object({
  OAX_DATABASE_URL: z.string().min(1).optional(),
  OAX_DATABASE_PASSWORD: z.string().optional(),
  PGHOST: z.string().optional(),
  PGPORT: z.coerce.number().int().positive().optional(),
  PGUSER: z.string().optional(),
  PGPASSWORD: z.string().optional(),
  PGDATABASE: z.string().optional(),
  PGSSLMODE: z
    .enum(['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full', 'no-verify'])
    .optional(),
  OAX_DB_POOL_MAX: int(20),
  OAX_DB_STATEMENT_TIMEOUT_MS: int(15_000),
  OAX_DB_MIGRATE_ON_START: bool.default(true),
  OAX_DB_CONNECT_RETRIES: int(30),
  OAX_DB_CONNECT_BACKOFF_MS: int(500),
});

export interface DatabaseConfig {
  url: string;
  password: string | undefined;
  poolMax: number;
  statementTimeoutMs: number;
  migrateOnStart: boolean;
  connectRetries: number;
  connectBackoffMs: number;
}

export function loadDatabaseConfig(
  env: Record<string, string | undefined> = process.env,
): DatabaseConfig {
  const parsed = DbEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new OaxError(
      'config_invalid',
      `invalid database configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const e = parsed.data;
  let url = e.OAX_DATABASE_URL;
  if (!url) {
    if (!e.PGHOST)
      throw new OaxError(
        'config_invalid',
        'invalid configuration: OAX_DATABASE_URL or PGHOST is required',
      );
    const user = e.PGUSER ? `${encodeURIComponent(e.PGUSER)}@` : '';
    const params = e.PGSSLMODE ? `?sslmode=${e.PGSSLMODE}` : '';
    url = `postgres://${user}${e.PGHOST}:${e.PGPORT ?? 5432}/${encodeURIComponent(e.PGDATABASE ?? 'openagentix')}${params}`;
  }
  return {
    url,
    password: e.OAX_DATABASE_PASSWORD ?? e.PGPASSWORD,
    poolMax: e.OAX_DB_POOL_MAX,
    statementTimeoutMs: e.OAX_DB_STATEMENT_TIMEOUT_MS,
    migrateOnStart: e.OAX_DB_MIGRATE_ON_START,
    connectRetries: e.OAX_DB_CONNECT_RETRIES,
    connectBackoffMs: e.OAX_DB_CONNECT_BACKOFF_MS,
  };
}
