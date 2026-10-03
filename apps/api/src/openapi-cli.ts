import { writeFile } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { createControlNode } from './bootstrap.js';
import { renderOpenApi } from './openapi.js';

/** Writes the OpenAPI document: `node dist/openapi-cli.js <path>`. */
const target = process.argv[2] ?? 'openapi.yaml';
const node = await createControlNode(
  loadConfig({ NODE_ENV: 'test', OAX_DATABASE_URL: 'memory://', OAX_LOG_LEVEL: 'silent' }),
);
await writeFile(target, renderOpenApi(node.app));
await node.app.close();
await node.ctx.database.close();
console.warn(`wrote ${target}`);
