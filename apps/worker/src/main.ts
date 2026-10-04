import { createContext, createLogger, initTelemetry, loadConfig } from '@openagentix/api';
import { getEgressPolicy } from '@openagentix/core';
import { demoServerFactories, inMemoryServers } from '@openagentix/mcp';
import { ContainerRunner, EgressProxy } from '@openagentix/runners';
import { createWorkerHttpServer } from './http.js';
import { KafkaSources } from './sources.js';
import { CronScheduler } from './scheduler.js';
import { DemoLlmRunner } from './demo-runner.js';
import { Worker } from './worker.js';

const config = loadConfig();
const telemetry = await initTelemetry(
  config.otel.endpoint,
  process.env.OTEL_SERVICE_NAME ?? 'openagentix-worker',
);
const ctx = await createContext(config, {
  logger: createLogger(config.logLevel, 'openagentix-worker'),
});
// Opt-in container runner: one hardened container per isolated step (docs/runners.md).
const container = config.runners.container;
const egressProxy =
  container.enabled && container.egressProxyListen
    ? new EgressProxy({ outer: getEgressPolicy() })
    : undefined;
const containerRunner =
  container.enabled && container.config
    ? new ContainerRunner(container.config, egressProxy ? { egressProxy } : {})
    : undefined;
if (egressProxy && container.egressProxyListen)
  await egressProxy.listen(container.egressProxyListen.port, container.egressProxyListen.host);
// OAX_DEMO_MCP=true registers the built-in demo MCP servers (cve-db, tickets) for `in-memory` connections.
const worker = new Worker(ctx, {
  ...(config.demoMcp ? { inMemoryMcp: inMemoryServers(demoServerFactories()) } : {}),
  // Demo scenarios may run through the Claude Code harness (fixed scenarios, strict limits).
  ...(config.demo.enabled && config.demo.llm === 'claude-code'
    ? { runner: new DemoLlmRunner(config.demo) }
    : {}),
  ...(containerRunner && container.config && container.nodeControlUrl
    ? {
        isolation: {
          runners: { container: containerRunner },
          controlUrl: container.nodeControlUrl,
          limits: {
            cpus: container.config.maxCpus,
            memoryMb: container.config.maxMemoryMb,
            pids: container.config.maxPids,
          },
        },
      }
    : {}),
});
if (containerRunner?.unsafeSocket) {
  ctx.logger.warn(
    'container runner uses the raw Docker socket (OAX_CONTAINER_ALLOW_RAW_SOCKET=true): UNSAFE',
  );
  await worker.services.audit.append({
    actor: 'system',
    action: 'runner.unsafe_socket',
    target: 'container',
    payload: { engine: container.config?.engine ?? 'docker' },
  });
}
const scheduler = new CronScheduler(ctx, worker.services);
const kafka = new KafkaSources(ctx, worker.services);
worker.start();
const http = createWorkerHttpServer(ctx, worker);
http.listen(config.workerHttp.port, config.workerHttp.host);
scheduler.start();
await kafka.start();
ctx.logger.info({ workerId: worker.id, concurrency: config.worker.concurrency }, 'worker started');

const shutdown = async (signal: string) => {
  ctx.logger.info({ signal }, 'worker shutting down');
  scheduler.stop();
  http.close();
  await egressProxy?.close();
  await kafka.stop();
  await worker.stop(signal === 'SIGINT');
  await ctx.database.close();
  await telemetry.shutdown();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
