import { createContext, createLogger, initTelemetry, loadConfig } from '@openagentix/api';
import { demoServerFactories, inMemoryServers } from '@openagentix/mcp';
import { KafkaSources } from './sources.js';
import { CronScheduler } from './scheduler.js';
import { Worker } from './worker.js';

const config = loadConfig();
const telemetry = await initTelemetry(
  config.otel.endpoint,
  process.env.OTEL_SERVICE_NAME ?? 'openagentix-worker',
);
const ctx = await createContext(config, {
  logger: createLogger(config.logLevel, 'openagentix-worker'),
});
// OAX_DEMO_MCP=true registers the built-in demo MCP servers (cve-db, tickets) for `in-memory` connections.
const demo = process.env.OAX_DEMO_MCP === 'true';
const worker = new Worker(ctx, demo ? { inMemoryMcp: inMemoryServers(demoServerFactories()) } : {});
const scheduler = new CronScheduler(ctx, worker.services);
const kafka = new KafkaSources(ctx, worker.services);
worker.start();
scheduler.start();
await kafka.start();
ctx.logger.info({ workerId: worker.id, concurrency: config.worker.concurrency }, 'worker started');

const shutdown = async (signal: string) => {
  ctx.logger.info({ signal }, 'worker shutting down');
  scheduler.stop();
  await kafka.stop();
  await worker.stop(signal === 'SIGINT');
  await ctx.database.close();
  await telemetry.shutdown();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
