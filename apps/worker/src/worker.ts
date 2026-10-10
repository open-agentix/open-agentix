import { randomUUID } from 'node:crypto';
import {
  createServices,
  getNetworkSettings,
  withSpan,
  type AppContext,
  type Services,
} from '@openagentix/api';
import { ToolGateway, type InMemoryTransportFactory } from '@openagentix/mcp';
import {
  createOutboundDispatcher,
  type OutboundDispatcher,
  type ProviderRegistry,
} from '@openagentix/providers';
import {
  InProcessRunner,
  type IsolatingRunner,
  type RunResult,
  type Runner,
} from '@openagentix/runners';
import {
  OaxError,
  contextGuardFromEnv,
  runTraceIdentity,
  type HarnessKind,
  type RunnerKind,
} from '@openagentix/core';
import type { PullRequestDelivery } from './git/delivery.js';
import { executorTelemetry } from './executor-spans.js';
import { NodeDispatcher } from './node-dispatcher.js';
import { RunQueue } from './queue.js';

/**
 * The gateway of the worker process starts only operator-defined (platform) stdio servers. A
 * stdio server a tenant defined runs in a run node or not at all (ADR 0016 section 3.1).
 */
export function workerStdioGuard(
  platformNames: ReadonlySet<string>,
): (cfg: { name: string }) => void {
  return (cfg) => {
    if (platformNames.has(cfg.name)) return;
    throw new OaxError(
      'mcp_stdio_requires_isolation',
      `stdio connection "${cfg.name}" was defined by a tenant and may only run in a run node, not in the worker process`,
    );
  };
}

export interface WorkerOptions {
  workerId?: string;
  providers?: ProviderRegistry;
  /** In-process MCP servers (demo/test); real deployments use stdio or streamable-http connections. */
  inMemoryMcp?: InMemoryTransportFactory;
  runner?: Runner;
  /** Outbound dispatcher of HTTP MCP servers (tests); default: built from the network settings. */
  mcpOutbound?: OutboundDispatcher;
  /** Pull request delivery for steps with a `pull-request` output (DOG-4); off when unset. */
  delivery?: (services: Services, workerId: string) => PullRequestDelivery | undefined;
  /**
   * Isolating runners (container, ...) by kind plus how run nodes reach the control node. Steps
   * whose effective runner is isolating are executed by short-lived run nodes (ADR 0008).
   */
  isolation?: {
    runners: Partial<
      Record<
        RunnerKind,
        IsolatingRunner & { imageFor(toolbox?: string, harness?: HarnessKind): string }
      >
    >;
    controlUrl: string;
    /** Per-runner override of `controlUrl`. */
    controlUrls?: Partial<Record<RunnerKind, string>>;
    limits: { cpus: number; memoryMb: number; pids: number };
    /** How often a running node's run is checked for cancellation (default 2 s). */
    cancelPollMs?: number;
  };
}

/**
 * The worker process: claims runs, executes them with a runner and reports through the same
 * run-token-scoped control plane API that remote worker nodes use.
 */
export class Worker {
  readonly id: string;
  readonly services: Services;
  readonly queue: RunQueue;
  private readonly active = new Map<string, AbortController>();
  private readonly providers: ProviderRegistry | null;
  private readonly runner: Runner;
  private readonly delivery: PullRequestDelivery | undefined;
  private loop: Promise<void> | null = null;
  private stopping = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private mcpOutboundImpl: OutboundDispatcher | undefined;

  constructor(
    readonly ctx: AppContext,
    private readonly opts: WorkerOptions = {},
  ) {
    this.id = opts.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
    this.services = createServices(ctx);
    this.delivery = opts.delivery?.(this.services, this.id);
    this.queue = new RunQueue(ctx, this.id, (runId) =>
      this.services.runNodes.revokeRun(runId, 'lease_lost'),
    );
    this.providers = opts.providers ?? null;
    this.runner = opts.runner ?? new InProcessRunner();
  }

  /**
   * The dispatcher every HTTP MCP request of this worker leaves through (ADR 0016 S1): the network
   * configuration and the air-gapped allowlist of the process apply to it.
   */
  private mcpOutbound(): OutboundDispatcher {
    if (this.opts.mcpOutbound) return this.opts.mcpOutbound;
    const settings = getNetworkSettings();
    return (this.mcpOutboundImpl ??= createOutboundDispatcher({
      ...(settings ? { network: settings.net } : {}),
      allowPlainHttpForPlatform: true,
    }));
  }

  get running(): boolean {
    return this.loop !== null && !this.stopping;
  }

  get activeRuns(): number {
    return this.active.size;
  }

  /** Executes one claimed run end to end. */
  async execute(runId: string): Promise<RunResult> {
    const log = this.ctx.logger.child({ runId, workerId: this.id });
    const abort = new AbortController();
    this.active.set(runId, abort);
    const token = this.services.control.issueToken(runId, this.id);
    const control = this.services.control.forToken(token);
    // Tool servers resolve per run: only connections of the run's tenant (and platform ones) exist.
    const run = await this.services.runs.get(runId);
    const toolScope = { tenantId: run.tenantId, teamId: run.teamId, agentId: run.agentId };
    // Configs and platform names from one resolution: the stdio guard below decides by name.
    const { configs: mcp, platformNames } = await this.services.catalog.mcpRunConfigs(toolScope);
    const tools = new ToolGateway(
      mcp,
      {
        // Tenant allowlist (tenants.secret_refs) applies in-process exactly as it does for nodes;
        // only connections of PLATFORM scope keep the unrestricted (operator-chosen) resolver.
        ...(await this.services.runNodes.resolverForRun(run.tenantId, platformNames)),
        // ADR 0016 S0, last wall: whatever reaches this gateway runs in the trusted worker, where
        // only operator-defined (platform) stdio servers may start. A tenant stdio server runs in
        // a run node or not at all.
        stdioGuard: workerStdioGuard(platformNames),
        // HTTP servers: only platform connections are operator configuration, everything else gets
        // the tenant destination rules and pinned DNS (ADR 0016 section 4).
        outbound: this.mcpOutbound(),
        originFor: (server) => (platformNames.has(server) ? 'platform' : 'tenant'),
        ...(this.opts.inMemoryMcp ? { inMemory: this.opts.inMemoryMcp } : {}),
      },
      contextGuardFromEnv(process.env),
    );
    try {
      const prepared = await this.services.control.prepare(runId);
      log.info(
        { agent: prepared.definition.name, version: prepared.definition.version },
        'run started',
      );
      // One span per attempt (lease), a child of the run's stored root context: a run that a crashed
      // worker lost and another worker retries stays one trace with several attempt spans. Runs
      // created before the trace identity existed have none and start their own trace.
      const identity = runTraceIdentity(run);
      const span = {
        name: `invoke_workflow ${prepared.definition.name}`,
        kind: 'invoke_workflow',
        ...(identity ? { parent: { traceId: identity.traceId, spanId: identity.rootSpanId } } : {}),
      } as const;
      const rootId = await this.services.tenants.rootIdOf(run.tenantId).catch(() => undefined);
      const attributes = {
        'gen_ai.operation.name': 'invoke_workflow',
        'gen_ai.workflow.name': prepared.definition.name,
        'oax.agent.version': prepared.definition.version,
        'oax.run.attempt': run.attempts,
        'oax.run.id': runId,
        'oax.tenant.id': run.tenantId,
        ...(rootId ? { 'oax.tenant.root_id': rootId } : {}),
      };
      return await withSpan(span, attributes, async (attempt) => {
        // Second wall (also for versions published before the rule): a step that runs in this
        // process must not hold a grant on a tenant-defined stdio server.
        const stdio = await this.services.catalog.stdioIsolationIssues(
          prepared.definition,
          toolScope,
        );
        if (stdio.length > 0) {
          this.ctx.metrics.mcpStdioRefused.inc({ code: 'mcp_stdio_requires_isolation' });
          await this.services.audit.append({
            actor: `worker:${this.id}`,
            tenantId: run.tenantId,
            action: 'mcp.stdio.refused',
            target: runId,
            runId,
            payload: {
              code: 'mcp_stdio_requires_isolation',
              issues: stdio.map((v) => ({ step: v.step, connection: v.server, path: v.path })),
            },
          });
          throw new OaxError('mcp_stdio_requires_isolation', stdio[0]!.message, stdio);
        }
        const scope = { tenantId: run.tenantId, teamId: run.teamId, agentId: run.agentId };
        const telemetry = executorTelemetry({
          runId,
          tenantId: run.tenantId,
          tenantRootId: rootId,
        });
        const result = await this.runner.execute(prepared, {
          // Providers resolve per run: platform providers plus the run tenant's BYOK connections.
          providers: this.providers ?? (await this.services.models.registryFor(scope)),
          tools,
          control,
          costModel: await this.services.models.costModelFor(scope),
          // Executor spans (ADR 0015 S3); none without a registered SDK.
          ...(telemetry ? { telemetry } : {}),
          signal: abort.signal,
          // Without isolation configured, a step that asks for an isolating runner has nowhere
          // to run: the dispatcher still exists and fails it closed instead of running it inline.
          dispatcher: new NodeDispatcher(
            {
              services: this.services,
              runners: this.opts.isolation?.runners ?? {},
              workerId: this.id,
              ...(this.delivery ? { delivery: this.delivery } : {}),
              controlUrl: this.opts.isolation?.controlUrl ?? '',
              ...(this.opts.isolation?.controlUrls
                ? { controlUrls: this.opts.isolation.controlUrls }
                : {}),
              limits: this.opts.isolation?.limits ?? { cpus: 1, memoryMb: 512, pids: 256 },
              ...(this.opts.isolation?.cancelPollMs
                ? { cancelPollMs: this.opts.isolation.cancelPollMs }
                : {}),
            },
            prepared.definition,
          ),
        });
        log.info(
          { status: result.status, usage: result.usage, error: result.error },
          'run finished',
        );
        attempt.setAttributes({
          'oax.run.status': result.status,
          'gen_ai.usage.input_tokens': result.usage.tokensIn,
          'gen_ai.usage.output_tokens': result.usage.tokensOut,
          'oax.cost.micro_usd': result.usage.costMicros,
        });
        return result;
      });
    } catch (e) {
      log.error({ err: e }, 'run crashed');
      const result: RunResult = {
        status: 'failed',
        outputs: [],
        usage: { tokensIn: 0, tokensOut: 0, costMicros: 0, steps: 0, toolCalls: 0 },
        error: {
          code: e instanceof OaxError && e.code.startsWith('mcp_') ? e.code : 'worker_error',
          message: (e as Error).message,
        },
      };
      await control
        .completeRun(runId, result)
        .catch((err: unknown) => log.error({ err }, 'could not complete run'));
      return result;
    } finally {
      this.active.delete(runId);
      await tools.close();
    }
  }

  /** One scheduling round: recover expired leases and fill free slots. Returns the claimed ids. */
  async tick(): Promise<string[]> {
    await this.queue.reapExpired();
    // Reservations nobody settled (crashed worker or node) are charged in full (ADR 0009 4.3).
    await this.services.modelAccounting
      .expire()
      .catch((err: unknown) => this.ctx.logger.warn({ err }, 'model reservation reaper failed'));
    const free = this.ctx.config.worker.concurrency - this.active.size;
    const claimed = await this.queue.claim(free);
    for (const c of claimed) void this.execute(c.id);
    this.ctx.metrics.workerActiveRuns.set({ worker: this.id }, this.active.size);
    return claimed.map((c) => c.id);
  }

  /** Waits until all currently executing runs finished. */
  async drain(): Promise<void> {
    while (this.active.size > 0) await new Promise((r) => setTimeout(r, 10));
  }

  start(): void {
    if (this.loop) return;
    this.stopping = false;
    this.heartbeatTimer = setInterval(
      () => {
        void this.queue
          .heartbeat([...this.active.keys()])
          .catch((err: unknown) => this.ctx.logger.warn({ err }, 'heartbeat failed'));
      },
      Math.max(1000, (this.ctx.config.worker.leaseSeconds * 1000) / 3),
    );
    this.loop = (async () => {
      while (!this.stopping) {
        try {
          await this.tick();
        } catch (err) {
          this.ctx.logger.error({ err }, 'worker tick failed');
        }
        await new Promise((r) => setTimeout(r, this.ctx.config.worker.pollMs));
      }
    })();
  }

  /** Stops claiming new runs; running runs finish unless `abort` is set. */
  async stop(abort = false): Promise<void> {
    this.stopping = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (abort) for (const a of this.active.values()) a.abort(new Error('worker shutting down'));
    await this.loop;
    this.loop = null;
    await this.drain();
    await this.mcpOutboundImpl?.close().catch(() => undefined);
    this.mcpOutboundImpl = undefined;
  }
}
