import { tenants } from './db/schema.js';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { createServices } from './services/index.js';

/**
 * Operator tool for key rotation (ADR 0017 section 13.6). Every step is idempotent: run it again
 * until `remaining` is 0. Needs the same configuration as the control node (database, KEK).
 *
 *   status                     data keys per key-encryption key
 *   rewrap                     after a KEK rotation: wrap the data keys with the new KEK
 *   rotate-dek <node-id>       new data key version for a node (new writes use it)
 *   reencrypt <node-id|--all>  seal the values of a node under its active data key
 *   retire <node-id|--all>     destroy retired data key versions that nothing uses any more
 *
 *   pnpm --filter @openagentix/api db:keys -- <command> [argument]
 */
const [command, argument] = process.argv.slice(2);
const config = loadConfig();
const ctx = await createContext(config);
const { secretRotation, ...services } = createServices(ctx);
let code = 0;
try {
  const nodes = async (): Promise<string[]> =>
    argument === '--all'
      ? (await ctx.db.select({ id: tenants.id }).from(tenants)).map((t) => t.id)
      : argument
        ? [argument]
        : [];
  switch (command) {
    case 'status':
      console.warn(JSON.stringify(await services.mcpOauth.keys.keysPerKek()));
      break;
    case 'rewrap':
      console.warn(JSON.stringify(await secretRotation.rewrapKeys()));
      break;
    case 'rotate-dek':
      if (!argument) throw new Error('rotate-dek needs a node id');
      console.warn(JSON.stringify({ version: await secretRotation.rotateDataKey(argument) }));
      break;
    case 'reencrypt':
    case 'retire':
      for (const id of await nodes())
        console.warn(
          JSON.stringify({
            node: id,
            ...(command === 'retire'
              ? await secretRotation.retire(id)
              : await secretRotation.reencrypt(id)),
          }),
        );
      break;
    default:
      throw new Error(
        'usage: db:keys -- status | rewrap | rotate-dek <node> | reencrypt|retire <node|--all>',
      );
  }
} catch (e) {
  console.error('key rotation failed:', (e as Error).message);
  code = 1;
} finally {
  await ctx.database.close();
}
process.exit(code);
