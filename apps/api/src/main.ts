import { loadConfig } from './config.js';
import { createControlNode } from './bootstrap.js';
import { initTelemetry } from './telemetry.js';

const config = loadConfig();
const telemetry = await initTelemetry(config.otel.endpoint, config.otel.serviceName);
const node = await createControlNode(config);
await node.app.listen({ host: config.host, port: config.port });

const shutdown = async (signal: string) => {
  node.app.log.info({ signal }, 'shutting down');
  await node.app.close();
  await node.ctx.cache.close();
  await node.ctx.database.close();
  await telemetry.shutdown();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
