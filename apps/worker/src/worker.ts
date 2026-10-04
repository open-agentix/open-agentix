import { randomUUID } from 'node:crypto';
import { createServices, withSpan, type AppContext, type Services } from '@openagentix/api';
import { ToolGateway, type InMemoryTransportFactory } from '@openagentix/mcp';
import type { ProviderRegistry } from '@openagentix/providers';
import {
  InProcessRunner,
  type IsolatingRunner,
  type RunResult,
  type Runner,
} from '@openagentix/runners';
import type { RunnerKind } from '@openagentix/core';
import { NodeDispatcher } from './node-dispatcher.js';
import { RunQueue } from './queue.js';

export interface WorkerOptions {
  workerId?: string;
  providers?: ProviderRegistry;
  /** In-process MCP servers (demo/test); real deployments use stdio or streamable-http connections. */
  inMemoryMcp?: InMemoryTransportFactory;
  runner?: Runner;
  /**
   * Isolating runners (container, ...) by kind plus how run nodes reach the control node. Steps
   * whose effective runner is isolating are executed by short-lived run nodes (ADR 0008).
   */
  isolation?: {
    runners: Partial<Record<RunnerKind, IsolatingRunner & { imageFor(toolbox?: string): string }>>;
    controlUrl: string;
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
  private loop: Promise<void> | null = null;
  private stopping = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly ctx: AppContext,
    private readonly opts: WorkerOptions = {},
  ) {
    this.id = opts.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
    this.services = createServices(ctx);
    this.queue = new RunQueue(ctx, this.id, (runId) =>
      this.services.runNodes.revokeRun(runId, 'lease_lost'),
    );
    this.providers = opts.providers ?? null;
    this.runner = opts.runner ?? new InProcessRunner();
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
    const tools = new ToolGateway(await this.services.catalog.mcpConfigs(toolScope), {
      // Tenant allowlist (tenants.secret_refs) applies in-process exactly as it does for nodes;
      // only connections of PLATFORM scope keep the unrestricted (operator-chosen) resolver.
      ...(await this.services.runNodes.resolverForRun(
        run.tenantId,
        await this.services.catalog.platformMcpNames(toolScope),
      )),
      ...(this.opts.inMemoryMcp ? { inMemory: this.opts.inMemoryMcp } : {}),
    });
    try {
      return await withSpan('oax.run', { 'oax.run_id': runId, 'oax.worker': this.id }, async () => {
        const prepared = await this.services.control.prepare(runId);
        log.info(
          { agent: prepared.definition.name, version: prepared.definition.version },
          'run started',
        );
        const scope = { tenantId: run.tenantId, teamId: run.teamId, agentId: run.agentId };
        const result = await this.runner.execute(prepared, {
          // Providers resolve per run: platform providers plus the run tenant's BYOK connections.
          providers: this.providers ?? (await this.services.models.registryFor(scope)),
          tools,
          control,
          costModel: await this.services.models.costModelFor(scope),
          signal: abort.signal,
          // Without isolation configured, a step that asks for an isolating runner has nowhere
          // to run: the dispatcher still exists and fails it closed instead of running it inline.
          dispatcher: new NodeDispatcher(
            {
              services: this.services,
              runners: this.opts.isolation?.runners ?? {},
              workerId: this.id,
              controlUrl: this.opts.isolation?.controlUrl ?? '',
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
        return result;
      });
    } catch (e) {
      log.error({ err: e }, 'run crashed');
      const result: RunResult = {
        status: 'failed',
        outputs: [],
        usage: { tokensIn: 0, tokensOut: 0, costMicros: 0, steps: 0, toolCalls: 0 },
        error: { code: 'worker_error', message: (e as Error).message },
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
  }
}
