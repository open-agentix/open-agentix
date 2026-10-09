import { createContext, createLogger, initTelemetry, loadConfig } from '@openagentix/api';
import { demoServerFactories, inMemoryServers } from '@openagentix/mcp';
import { ContainerRunner } from '@openagentix/runners';
import { buildIsolation, createKubernetesJobRunner } from './isolation.js';
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
// The egress proxy is NOT part of this process: it is its own service (egress-proxy-cli.js), so that
// a worker attached to the engine network never carries a path to the internet or the platform.
const containerRunner =
  container.enabled && container.config ? new ContainerRunner(container.config) : undefined;
// Opt-in Kubernetes Job runner (OAX_K8S_JOB_ENABLED): one hardened Job per isolated step. Throws
// at start-up (fail closed) when enabled but not running in a cluster or misconfigured.
const kubernetesRunner = createKubernetesJobRunner(config, {
  warn: (m) => ctx.logger.warn(m),
});
const isolation = buildIsolation(config, {
  ...(containerRunner ? { container: containerRunner } : {}),
  ...(kubernetesRunner ? { kubernetes: kubernetesRunner } : {}),
});
if (kubernetesRunner) {
  ctx.logger.info(
    { namespace: kubernetesRunner.config.namespace },
    'kubernetes-job runner enabled',
  );
}
// OAX_DEMO_MCP=true registers the built-in demo MCP servers (cve-db, tickets) for `in-memory` connections.
const worker = new Worker(ctx, {
  ...(config.demoMcp ? { inMemoryMcp: inMemoryServers(demoServerFactories()) } : {}),
  // Demo scenarios may run through the Claude Code harness (fixed scenarios, strict limits).
  ...(config.demo.enabled && config.demo.llm === 'claude-code'
    ? { runner: new DemoLlmRunner(config.demo) }
    : {}),
  ...(isolation ? { isolation } : {}),
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
// Containers that outlived their hard lifetime (crashed worker, lost engine connection) are removed
// at startup and every minute; live nodes carry a future expiry and are never touched.
const reapNodes = () =>
  void containerRunner
    ?.reapOrphans()
    .then((n) => n > 0 && ctx.logger.warn({ removed: n }, 'removed expired run node containers'))
    .catch((err: unknown) => ctx.logger.warn({ err }, 'run node reaper failed'));
reapNodes();
const reaper = containerRunner ? setInterval(reapNodes, 60_000) : undefined;
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
  if (reaper) clearInterval(reaper);
  await kafka.stop();
  await worker.stop(signal === 'SIGINT');
  await ctx.database.close();
  await telemetry.shutdown();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
