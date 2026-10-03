import { randomUUID } from 'node:crypto';
import {
  CostModel,
  DefaultSecretResolver,
  loadAgentDefinition,
  type PolicyBundle,
  type PriceEntry,
  type SecretResolver,
  type VerifyResult,
} from '@openagentix/core';
import { EVENT_TYPES, createEvent, isCloudEvent, parseCloudEvent } from '@openagentix/events';
import {
  McpServerConfigSchema,
  ToolGateway,
  demoServerFactories,
  inMemoryServers,
  type McpServerConfigInput,
} from '@openagentix/mcp';
import { DEFAULT_PROVIDERS, ProviderRegistry, type ProviderConfig } from '@openagentix/providers';
import { executePipeline } from './executor.js';
import { LocalControlPlane } from './local-control-plane.js';
import type { PreparedRun, RunResult, Runner, RunnerContext, StepInput } from './types.js';

/** Runner for a developer machine (`oax run`): same executor, local control plane. */
export class LocalRunner implements Runner {
  readonly kind = 'local' as const;

  async execute(run: PreparedRun, ctx: RunnerContext): Promise<RunResult> {
    const result = await executePipeline(run, ctx);
    await ctx.control.completeRun(run.runId, result);
    return result;
  }
}

export interface LocalRunOptions {
  agentsSource: string;
  /** A CloudEvent or any JSON payload (wrapped into a manual event). */
  event: unknown;
  providers?: ProviderConfig[];
  /** MCP servers; defaults to the built-in demo servers for every referenced server name. */
  mcpServers?: McpServerConfigInput[];
  approve?: 'all' | 'none';
  prices?: PriceEntry[];
  policies?: PolicyBundle[];
  secrets?: SecretResolver;
  onStep?: (step: StepInput) => void;
  signal?: AbortSignal;
}

export interface LocalRunReport {
  runId: string;
  result: RunResult;
  steps: StepInput[];
  audit: VerifyResult;
}

export function toEvent(payload: unknown) {
  return isCloudEvent(payload)
    ? parseCloudEvent(payload)
    : createEvent({ source: '/sources/local/cli', type: EVENT_TYPES.manual, data: payload });
}

export async function runLocal(opts: LocalRunOptions): Promise<LocalRunReport> {
  const definition = loadAgentDefinition(opts.agentsSource);
  const secrets = opts.secrets ?? new DefaultSecretResolver();
  const providers = await ProviderRegistry.create(opts.providers ?? DEFAULT_PROVIDERS, { secrets });
  const referenced = [...new Set(definition.agents.flatMap((a) => a.tools.map((t) => t.server)))];
  const mcp = (
    opts.mcpServers ?? referenced.map((name) => ({ name, transport: 'in-memory' as const }))
  ).map((c) => McpServerConfigSchema.parse(c));
  const tools = new ToolGateway(mcp, { secrets, inMemory: inMemoryServers(demoServerFactories()) });
  const control = new LocalControlPlane({
    definition,
    policies: opts.policies ?? [],
    approve: () => (opts.approve === 'all' ? 'approved' : 'rejected'),
    ...(opts.onStep ? { onStep: (_id: string, s: StepInput) => opts.onStep?.(s) } : {}),
  });
  const runId = randomUUID();
  try {
    const result = await new LocalRunner().execute(
      { runId, definition, event: toEvent(opts.event), policies: opts.policies ?? [] },
      {
        providers,
        tools,
        control,
        costModel: new CostModel(opts.prices ?? []),
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
    );
    return { runId, result, steps: control.steps, audit: control.verifyAudit() };
  } finally {
    await tools.close();
  }
}
