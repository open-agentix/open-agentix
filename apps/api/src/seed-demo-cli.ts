import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { seedDemo } from './demo/seed.js';
import { createServices } from './services/index.js';

/** `pnpm seed:demo` - loads the public demo data set into an empty database (`--force` to add anyway). */
const config = loadConfig();
if (!config.demo.enabled) {
  // The seed publishes without approval (ADR 0017 S3): demo mode only.
  console.error('seed:demo needs OAX_DEMO_MODE=true');
  process.exit(1);
}
const ctx = await createContext(config);
const result = await seedDemo(ctx, createServices(ctx), {
  password: config.demo.password,
  force: process.argv.includes('--force'),
});
console.warn(JSON.stringify(result));
await ctx.database.close();
