import { loadConfig } from './config.js';
import { createControlNode } from './bootstrap.js';
import { activateAirgap } from './airgap.js';
import { initTelemetry } from './telemetry.js';

const config = loadConfig();
// The air-gapped check runs before the exporter (and its header secret) exists (#220); the
// context activates the same configuration again once the exporter is up.
const egress = activateAirgap(config);
const telemetry = await initTelemetry(config.otel, {
  egress,
  warn: (fields, message) =>
    console.warn(JSON.stringify({ level: 'warn', ...fields, msg: message })),
});
const node = await createControlNode(config);
telemetry.attachStats(node.ctx.metrics.otel);
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
