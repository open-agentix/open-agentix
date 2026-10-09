import { isGuardReportEmpty, type GuardReport } from '@openagentix/core';
import type { StepInput } from './types.js';

/** Where in a run text was guarded; part of the audit entry. */
export type GuardSource = 'input' | 'tool_result' | 'tool_error';

/** Step name of the audit entry. A run node may report exactly this control step (counts only). */
export const INPUT_GUARD_STEP = 'input_guard';

/**
 * Records that the context guard removed or replaced something. The entry names the source, the
 * tool (a configured name, never content), counts and class or kind names; never the content.
 * Does nothing for an empty report, so a clean run adds no entries.
 */
export async function recordGuardReport(
  step: (s: StepInput) => Promise<void>,
  agentId: string,
  source: GuardSource,
  report: GuardReport | undefined,
  tool?: string,
): Promise<void> {
  if (!report || isGuardReportEmpty(report)) return;
  await step({
    kind: 'control',
    agentId,
    name: INPUT_GUARD_STEP,
    status: 'ok',
    output: { source, ...(tool ? { tool } : {}), ...report },
  });
}
