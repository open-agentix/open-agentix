import { randomUUID } from 'node:crypto';
import { HttpError } from '../errors.js';
import {
  ContextGuard,
  CostModel,
  expandProfiles,
  loadAgentDefinition,
  type AccessCatalog,
  type PolicyBundle,
} from '@openagentix/core';
import { createEvent, isCloudEvent, parseCloudEvent } from '@openagentix/events';
import {
  modelToolName,
  type ExposedTool,
  type GatewayCallResult,
  type PolicyGate,
  type ToolGateway,
} from '@openagentix/mcp';
import { ProviderRegistry, SimulatedProvider } from '@openagentix/providers';
import {
  LocalControlPlane,
  executePipeline,
  type RunResult,
  type StepInput,
} from '@openagentix/runners';

/**
 * Tool gateway for dry runs: exposes the granted tools and decides every call with the real
 * policy gate, but never contacts an MCP server - allowed calls return a synthetic result.
 */
export function dryRunToolGateway(): ToolGateway {
  const gateway = {
    // Prompts of a dry run are guarded like those of a real run.
    guard: new ContextGuard(),
    async exposedTools(agent: {
      tools: { server: string; tool: string }[];
    }): Promise<ExposedTool[]> {
      return agent.tools.map((t) => {
        const tool = t.tool.replace(/\*$/, '');
        return {
          modelName: modelToolName(t.server, tool),
          server: t.server,
          tool,
          description: `${t.server}/${tool} (dry run)`,
          inputSchema: { type: 'object', additionalProperties: true },
        };
      });
    },
    async call(
      call: { server: string; tool: string; args: Record<string, unknown> },
      gate: PolicyGate,
      opts: { approved?: boolean } = {},
    ): Promise<GatewayCallResult> {
      const decision = await gate.decide(call);
      if (decision.effect === 'deny') return { status: 'denied', decision };
      if (decision.effect === 'require_approval' && !opts.approved)
        return { status: 'approval_required', decision };
      const text = JSON.stringify({
        dryRun: true,
        server: call.server,
        tool: call.tool,
        args: call.args,
      });
      return {
        status: 'ok',
        decision,
        result: { text, isError: false, truncated: false, bytes: text.length },
      };
    },
    async close(): Promise<void> {},
  };
  return gateway as unknown as ToolGateway;
}

export interface DryRunResult {
  result: RunResult;
  steps: StepInput[];
  auditValid: boolean;
}

/**
 * Executes an agents.md source (usually a draft) without persisting anything: every agent uses the
 * deterministic `simulated` provider, tool calls pass the policy gate but are not executed, and
 * approvals are answered with `approve`.
 */
export async function dryRunAgent(
  source: string,
  data: unknown,
  bundles: PolicyBundle[],
  approve: 'all' | 'none',
  catalog: AccessCatalog = {},
): Promise<DryRunResult> {
  // Same expansion as publish, so a draft is tested with the grants a version would get.
  const { definition: expanded, errors } = expandProfiles(loadAgentDefinition(source), catalog);
  if (errors.length > 0)
    throw new HttpError(400, 'validation_failed', 'tool grants are not allowed', errors);
  const definition = {
    ...expanded,
    agents: expanded.agents.map((a) => ({ ...a, provider: 'simulated' })),
  };
  const control = new LocalControlPlane({
    definition,
    policies: bundles,
    approve: () => (approve === 'all' ? 'approved' : 'rejected'),
    actor: 'dry-run',
  });
  const event = isCloudEvent(data)
    ? parseCloudEvent(data)
    : createEvent({ source: '/dry-run', type: 'io.openagentix.manual', data: data ?? null });
  const result = await executePipeline(
    { runId: randomUUID(), definition, event, policies: bundles },
    {
      providers: ProviderRegistry.of([new SimulatedProvider({ name: 'simulated' })]),
      tools: dryRunToolGateway(),
      control,
      costModel: new CostModel(),
    },
  );
  return { result, steps: control.steps, auditValid: control.verifyAudit().valid };
}
