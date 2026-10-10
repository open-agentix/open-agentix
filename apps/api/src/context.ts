import { isSpanContextValid, trace } from '@opentelemetry/api';
import { CostModel, DefaultSecretResolver, type SecretResolver } from '@openagentix/core';
import { eq } from 'drizzle-orm';
import pino, { type Logger } from 'pino';
import {
  catalogPriceTable,
  loadModelCatalog,
  modelPriceEntries,
  type FetchLike,
  type HostLookup,
  type ModelCatalog,
} from '@openagentix/providers';
import {
  activateAirgap,
  checkStoredConnections,
  stdioAirgapContext,
  failClosed,
  getNetworkSettings,
} from './airgap.js';
import { connections } from './db/schema.js';
import { findStdioViolations } from './stdio.js';
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
  /** Name resolution for the SSRF checks of tenant-controlled endpoints (tests inject a fake). */
  hostLookup?: HostLookup;
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

/** Adds the active span's ids to every log line, for log-to-trace correlation (ids only). */
export function traceLogFields(): { trace_id?: string; span_id?: string } {
  const ctx = trace.getActiveSpan()?.spanContext();
  return ctx && isSpanContextValid(ctx) ? { trace_id: ctx.traceId, span_id: ctx.spanId } : {};
}

export function createLogger(level: string, name = 'openagentix'): Logger {
  return pino({
    name,
    level,
    redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' },
    mixin: traceLogFields,
  });
}

/**
 * Existing tenant stdio connections that break the stdio rules (ADR 0016 S0) are never changed or
 * deleted: they fail closed at run time. This makes them visible at start-up (a warning and the
 * `oax_mcp_stdio_violations` gauge); `GET /v1/connections/stdio-violations` lists them per tenant.
 */
export async function reportStdioViolations(
  db: Db,
  config: Config,
  logger: Logger,
  metrics: Metrics,
): Promise<void> {
  try {
    const rows = await db.select().from(connections).where(eq(connections.kind, 'mcp'));
    const bad = findStdioViolations(rows, config.mcp.stdioCommands);
    metrics.mcpStdioViolations.set(bad.length);
    if (bad.length > 0)
      logger.warn(
        { count: bad.length, connections: bad.map((v) => v.connection.id) },
        'tenant stdio MCP connections violate the stdio rules and are refused at run time (OAX_MCP_STDIO_COMMANDS, docs/mcp.md)',
      );
  } catch (err) {
    // A start-up without the table (fresh database, migrations pending) is not an error here.
    logger.debug({ err }, 'stdio violation report skipped');
  }
}

export async function createContext(
  config: Config,
  overrides: Partial<AppContext> = {},
): Promise<AppContext> {
  const logger = overrides.logger ?? createLogger(config.logLevel);
  // Air-gapped mode is fail-closed: invalid endpoints abort start-up before anything connects.
  const egress = activateAirgap(config);
  // Network configuration warnings (plain http proxies, unreachable routes, scheme-less proxy
  // variables) are not errors, but an operator must be able to see them.
  for (const warning of getNetworkSettings()?.warnings ?? [])
    logger.warn({ warning }, 'network configuration warning');
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
    const problems = checkStoredConnections(rows, egress, stdioAirgapContext(config));
    if (problems.length > 0) failClosed(problems);
    logger.info(
      { allowlist: egress.status().allowlist },
      'air-gapped mode: egress allowlist active',
    );
  }
  const metrics = overrides.metrics ?? new Metrics();
  await reportStdioViolations(database.db, config, logger, metrics);
  const modelCatalog = overrides.modelCatalog ?? loadModelCatalog();
  return {
    config,
    database,
    db: database.db,
    cache: overrides.cache ?? (await createCache(config.cache.url, config.cache.maxEntries)),
    metrics,
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
    ...(overrides.hostLookup ? { hostLookup: overrides.hostLookup } : {}),
    ...(overrides.ldapFactory ? { ldapFactory: overrides.ldapFactory } : {}),
    ...(overrides.oidcClient ? { oidcClient: overrides.oidcClient } : {}),
  };
}
