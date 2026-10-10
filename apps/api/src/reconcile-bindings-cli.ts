import { createDatabase, waitForDatabase } from './db/client.js';
import { loadDatabaseConfig } from './db/settings.js';
import { reconcileAllBindings } from './services/role-bindings.js';

/**
 * Operator tool (ADR 0014 S1, #216): recomputes the mirror in `tenant_role_bindings` from
 * `users.global_roles` and repairs drift in both directions, one transaction per user. Idempotent
 * and safe to run next to a live control node. `--dry-run` only lists the users that would change.
 * Exit code 0 = done (or clean), 1 = failed. Needs only the database settings, like db:migrate.
 *
 *   pnpm --filter @openagentix/api db:reconcile-bindings [-- --dry-run]
 */
const dryRun = process.argv.includes('--dry-run');
const cfg = loadDatabaseConfig();
const db = await createDatabase({
  url: cfg.url,
  password: cfg.password,
  poolMax: 1,
  statementTimeoutMs: cfg.statementTimeoutMs,
});
let code = 0;
try {
  await waitForDatabase(db, cfg.connectRetries, cfg.connectBackoffMs, (attempt) =>
    console.warn(`database not reachable, retry ${attempt}`),
  );
  const s = await reconcileAllBindings(db.db, { dryRun });
  console.warn(
    `${dryRun ? 'would repair' : 'repaired'} ${s.users} user(s): ` +
      `${s.added} binding(s) added, ${s.removed} removed`,
  );
  for (const id of s.fixed) console.warn(`  user ${id}`);
} catch (e) {
  console.error('reconcile failed', e);
  code = 1;
} finally {
  await db.close();
}
process.exit(code);
