import { convertLegacyVersions } from './services/legacy-awp.js';
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
// AWP-3b: the one-time conversion of the published versions (idempotent, per agent in a transaction).
const converted = await convertLegacyVersions(db.db, (agent, err) =>
  console.warn(`conversion failed for agent ${agent}: ${(err as Error).message}`),
);
const status = await db.schemaStatus();
await db.close();
console.warn(`migrations applied (${status.applied}/${status.expected})`);
console.warn(
  `legacy versions converted to AWP manifests: ${converted.converted}, unconvertible: ${converted.unconvertible} (${converted.agents} agents)`,
);
