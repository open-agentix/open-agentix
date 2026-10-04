import {
  DEMO_EVENT_SOURCE,
  DEMO_TOOL_SERVERS,
  findDemoScenario,
  type Config,
} from '@openagentix/api';
import { OaxError, type AgentDefinition } from '@openagentix/core';
import {
  ClaudeCodeHarness,
  InProcessRunner,
  executeWithHarness,
  type ExternalHarness,
  type PreparedRun,
  type RunResult,
  type Runner,
  type RunnerContext,
} from '@openagentix/runners';

export interface DemoLlmRunnerOptions {
  /** Defaults to the Claude Code harness with the configured token file. */
  harness?: ExternalHarness;
  /** Where the harness work directories live (default: the OS temp dir). */
  workRoot?: string | undefined;
}

/**
 * Worker runner for the public demo with `OAX_DEMO_LLM=claude-code`. Only runs that were started
 * from a fixed demo scenario go through the Claude Code harness, and the worker re-derives
 * everything from the scenario table: the event payload comes from the table (not from the stored
 * event), the model and strict budgets come from the configuration. All other runs use the
 * normal in-process runner (simulated provider). The harness has no built-in tools (no shell,
 * file or web access); its only tool source is the policy gate with the in-memory demo servers.
 */
export class DemoLlmRunner implements Runner {
  readonly kind = 'in-process' as const;
  private readonly fallback = new InProcessRunner();
  private readonly harness: ExternalHarness;

  constructor(
    private readonly demo: Config['demo'],
    private readonly opts: DemoLlmRunnerOptions = {},
  ) {
    this.harness =
      opts.harness ??
      new ClaudeCodeHarness({
        ...(demo.llmTokenFile ? { oauthTokenFile: demo.llmTokenFile } : {}),
        defaultMaxTurns: 4,
      });
  }

  /** Strictly limited, fixed-model copy of the demo agent definition. */
  restrict(def: AgentDefinition): AgentDefinition {
    for (const a of def.agents)
      for (const t of a.tools)
        if (!DEMO_TOOL_SERVERS.includes(t.server))
          throw new OaxError(
            'demo_tool_refused',
            `demo agents may only use ${DEMO_TOOL_SERVERS.join(', ')}; "${t.server}" is not allowed`,
          );
    const cap = (value: number | undefined, limit: number) =>
      value === undefined ? limit : Math.min(value, limit);
    return {
      ...def,
      budget: {
        ...def.budget,
        maxCostUsd: cap(def.budget.maxCostUsd, this.demo.runBudgetUsd),
        maxSteps: cap(def.budget.maxSteps, 4 * Math.max(1, def.pipeline.length)),
        maxToolCalls: cap(def.budget.maxToolCalls, 4),
        timeoutSeconds: cap(def.budget.timeoutSeconds, 120),
      },
      agents: def.agents.map((a) => ({
        ...a,
        provider: 'claude-code',
        model: this.demo.llmModel,
        budget: {
          ...a.budget,
          maxSteps: cap(a.budget?.maxSteps, 4),
          maxCostUsd: cap(a.budget?.maxCostUsd, this.demo.runBudgetUsd),
        },
      })),
    };
  }

  async execute(run: PreparedRun, ctx: RunnerContext): Promise<RunResult> {
    const scenario =
      run.event.source === DEMO_EVENT_SOURCE ? findDemoScenario(run.event.subject) : undefined;
    if (!scenario) return this.fallback.execute(run, ctx);
    let result: RunResult;
    try {
      const fixed: PreparedRun = {
        ...run,
        definition: this.restrict(run.definition),
        // Never trust the stored payload: the scenario table is the only source of event data.
        event: { ...run.event, data: scenario.data },
        limits: { ...run.limits, maxCostMicros: Math.round(this.demo.runBudgetUsd * 1e6) },
      };
      result = await executeWithHarness(fixed, ctx, this.harness, {
        clearance: 'internal',
        ...((this.opts.workRoot ?? this.demo.workDir)
          ? { workRoot: (this.opts.workRoot ?? this.demo.workDir)! }
          : {}),
      });
    } catch (e) {
      result = {
        status: 'failed',
        outputs: [],
        usage: { tokensIn: 0, tokensOut: 0, costMicros: 0, steps: 0, toolCalls: 0 },
        error: {
          code: e instanceof OaxError ? e.code : 'demo_error',
          message: (e as Error).message,
        },
      };
    }
    await ctx.control.completeRun(run.runId, result);
    return result;
  }
}
