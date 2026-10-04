import { executePipeline } from './executor.js';
import type { PreparedRun, RunResult, Runner, RunnerContext } from './types.js';

/** Default runner: executes the run inside the worker process (default). */
export class InProcessRunner implements Runner {
  readonly kind = 'in-process' as const;

  async execute(run: PreparedRun, ctx: RunnerContext): Promise<RunResult> {
    const result = await executePipeline(run, ctx);
    await ctx.control.completeRun(run.runId, result);
    return result;
  }
}
