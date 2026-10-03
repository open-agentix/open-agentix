import { CostModel, DefaultSecretResolver, type SecretResolver } from '@openagentix/core';
import pino, { type Logger } from 'pino';
import { createCache, type Cache } from './cache.js';
import type { Config } from './config.js';
import { createDatabase, type Database, type Db } from './db/client.js';
import { Metrics } from './metrics.js';
import type { LdapClientFactory } from './auth/ldap.js';
import type { OidcClient } from './auth/oidc.js';

/** Shared dependencies of the control node services (API and in-process worker). */
export interface AppContext {
  config: Config;
  database: Database;
  db: Db;
  cache: Cache;
  metrics: Metrics;
  logger: Logger;
  secrets: SecretResolver;
  costModel: CostModel;
  now: () => Date;
  ldapFactory?: LdapClientFactory;
  oidcClient?: OidcClient;
}

export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-oax-signature"]',
  'req.headers["x-hub-signature-256"]',
  '*.password',
  '*.token',
  '*.secret',
  '*.apiKey',
];

export function createLogger(level: string, name = 'openagentix'): Logger {
  return pino({ name, level, redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' } });
}

export async function createContext(
  config: Config,
  overrides: Partial<AppContext> = {},
): Promise<AppContext> {
  const database =
    overrides.database ??
    (await createDatabase({
      url: config.database.url,
      poolMax: config.database.poolMax,
      statementTimeoutMs: config.database.statementTimeoutMs,
    }));
  if (config.database.migrateOnStart && !overrides.database) await database.migrate();
  return {
    config,
    database,
    db: database.db,
    cache: overrides.cache ?? (await createCache(config.cache.url, config.cache.maxEntries)),
    metrics: overrides.metrics ?? new Metrics(),
    logger: overrides.logger ?? createLogger(config.logLevel),
    secrets: overrides.secrets ?? new DefaultSecretResolver(),
    costModel: overrides.costModel ?? new CostModel(config.priceTable),
    now: overrides.now ?? (() => new Date()),
    ...(overrides.ldapFactory ? { ldapFactory: overrides.ldapFactory } : {}),
    ...(overrides.oidcClient ? { oidcClient: overrides.oidcClient } : {}),
  };
}
