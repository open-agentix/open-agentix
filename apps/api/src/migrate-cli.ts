import { createDatabase, waitForDatabase } from './db/client.js';
import { loadDatabaseConfig } from './db/settings.js';

/**
 * Applies database migrations and exits (Helm pre-install/pre-upgrade Job or init container).
 * Needs only the database settings; safe to run concurrently (advisory lock).
 */
const cfg = loadDatabaseConfig();
const db = await createDatabase({
  url: cfg.url,
  password: cfg.password,
  poolMax: 1,
  statementTimeoutMs: cfg.statementTimeoutMs,
});
await waitForDatabase(db, cfg.connectRetries, cfg.connectBackoffMs, (attempt) =>
  console.warn(`database not reachable, retry ${attempt}`),
);
await db.migrate();
const status = await db.schemaStatus();
await db.close();
console.warn(`migrations applied (${status.applied}/${status.expected})`);
