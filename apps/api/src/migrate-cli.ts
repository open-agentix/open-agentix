import { loadConfig } from './config.js';
import { createDatabase } from './db/client.js';

/** Applies database migrations and exits (Helm pre-upgrade Job / init container). */
const config = loadConfig();
const db = await createDatabase({ url: config.database.url, poolMax: 1 });
await db.migrate();
await db.close();
console.warn('migrations applied');
