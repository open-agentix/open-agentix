import { CostModel, DefaultSecretResolver, type SecretResolver } from '@openagentix/core';
import pino, { type Logger } from 'pino';
import {
  catalogPriceTable,
  loadModelCatalog,
  modelPriceEntries,
  type FetchLike,
  type ModelCatalog,
} from '@openagentix/providers';
import { createCache, type Cache } from './cache.js';
import type { Config } from './config.js';
import { createDatabase, waitForDatabase, type Database, type Db } from './db/client.js';
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
  /** Pinned model catalog snapshot (loaded from disk once, never fetched). */
  modelCatalog: ModelCatalog;
  /** Outbound HTTP for model providers (tests inject a fake; defaults to proxy-aware fetch). */
  fetchImpl?: FetchLike;
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
  const logger = overrides.logger ?? createLogger(config.logLevel);
  const db = config.database;
  const database =
    overrides.database ??
    (await createDatabase({
      url: db.url,
      password: db.password,
      poolMax: db.poolMax,
      statementTimeoutMs: db.statementTimeoutMs,
    }));
  if (!overrides.database) {
    await waitForDatabase(database, db.connectRetries, db.connectBackoffMs, (attempt, err) =>
      logger.warn({ attempt, err: (err as Error).message }, 'database not reachable yet, retrying'),
    );
    if (db.migrateOnStart) await database.migrate();
  }
  const modelCatalog = overrides.modelCatalog ?? loadModelCatalog();
  return {
    config,
    database,
    db: database.db,
    cache: overrides.cache ?? (await createCache(config.cache.url, config.cache.maxEntries)),
    metrics: overrides.metrics ?? new Metrics(),
    logger,
    secrets: overrides.secrets ?? new DefaultSecretResolver(process.env, config.secrets.dir),
    // Prices: pinned model catalog snapshot, overridden by OAX_PRICE_TABLE.
    costModel:
      overrides.costModel ??
      new CostModel([
        ...catalogPriceTable(modelCatalog),
        ...config.providers.flatMap((p) => modelPriceEntries(p.name, p.models)),
        ...config.priceTable,
      ]),
    modelCatalog,
    now: overrides.now ?? (() => new Date()),
    ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
    ...(overrides.ldapFactory ? { ldapFactory: overrides.ldapFactory } : {}),
    ...(overrides.oidcClient ? { oidcClient: overrides.oidcClient } : {}),
  };
}
