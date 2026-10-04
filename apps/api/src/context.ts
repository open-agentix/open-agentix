import { CostModel, DefaultSecretResolver, type SecretResolver } from '@openagentix/core';
import pino, { type Logger } from 'pino';
import { catalogPriceTable, loadModelCatalog } from '@openagentix/providers';
import { activateAirgap, checkMcpConnections, failClosed } from './airgap.js';
import { connections } from './db/schema.js';
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
  // Air-gapped mode is fail-closed: invalid endpoints abort start-up before anything connects.
  const egress = activateAirgap(config);
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
  if (egress.airgapped) {
    const rows = await database.db.select().from(connections);
    const problems = checkMcpConnections(rows, egress);
    if (problems.length > 0) failClosed(problems);
    logger.info(
      { allowlist: egress.status().allowlist },
      'air-gapped mode: egress allowlist active',
    );
  }
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
      new CostModel([...catalogPriceTable(loadModelCatalog()), ...config.priceTable]),
    now: overrides.now ?? (() => new Date()),
    ...(overrides.ldapFactory ? { ldapFactory: overrides.ldapFactory } : {}),
    ...(overrides.oidcClient ? { oidcClient: overrides.oidcClient } : {}),
  };
}
