import {
  OaxError,
  describeViolations,
  evaluateWhen,
  redact,
  validateHandover,
  type AgentSpec,
  type HandoverCheck,
  type HandoverViolation,
} from '@openagentix/core';
import type { AgentOutput, PreparedRun, StepInput } from './types.js';

/** A failure of the typed-handover machinery; the executor turns it into a failed run. */
export class HandoverFailure extends Error {
  constructor(
    readonly code: 'handover_invalid' | 'handover_missing' | 'condition_error',
    message: string,
  ) {
    super(message);
  }
}

/** The value of a step's output as later steps see it: the parsed JSON, else the text. */
export function outputValue(o: AgentOutput): unknown {
  return Object.hasOwn(o, 'json') ? o.json : o.content;
}

export interface StepStart {
  skipped: boolean;
  /** `true` when the step has `input.from` (minimal handover, prompt is the JSON map only). */
  explicit: boolean;
  /** What the step receives (validated when it declares `input.schema`). */
  value: unknown;
}

/**
 * Per-run state of the typed handover logic shared by the executors: which steps produced a
 * (validated) output, `when` evaluation, input assembly and validation, output validation.
 * Everything that is recorded carries paths, keywords and digests only, never values.
 */
export class StepFlow {
  /** Output values of the steps that ran, by step id (no prototype, so ids cannot collide). */
  private readonly values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

  constructor(
    private readonly run: PreparedRun,
    private readonly record: (s: StepInput) => Promise<void>,
  ) {}

  private get named(): Readonly<Record<string, unknown>> | undefined {
    return this.run.definition.schemas;
  }

  /** Loop head of a step: `when`, then input assembly and input validation. */
  async begin(agent: AgentSpec, previous: AgentOutput | null): Promise<StepStart> {
    const agentId = agent.id;
    if (agent.when !== undefined) {
      let verdict: boolean;
      try {
        verdict = evaluateWhen(agent.when, { event: this.run.event, steps: this.values });
      } catch (e) {
        const reason = e instanceof OaxError ? e.message : 'the condition could not be evaluated';
        await this.record({
          kind: 'condition',
          agentId,
          name: 'when',
          status: 'error',
          output: { when: agent.when, reason },
        });
        throw new HandoverFailure(
          'condition_error',
          `condition of agent "${agentId}" failed: ${reason}`,
        );
      }
      if (!verdict) {
        await this.record({
          kind: 'condition',
          agentId,
          name: 'when',
          status: 'skipped',
          output: { when: agent.when },
        });
        return { skipped: true, explicit: false, value: null };
      }
    }
    const from = agent.input?.from;
    let value: unknown;
    if (from) {
      const map: Record<string, unknown> = {};
      for (const source of from) {
        if (source === 'event') {
          map[source] = this.run.event.data ?? null;
        } else if (Object.hasOwn(this.values, source)) {
          map[source] = this.values[source];
        } else {
          await this.recordInvalid(agentId, 'input', 1, '', [
            { instancePath: `/${source}`, keyword: 'missing', schemaPath: '#' },
          ]);
          throw new HandoverFailure(
            'handover_missing',
            `agent "${agentId}" needs the output of "${source}", which did not run`,
          );
        }
      }
      value = map;
    } else {
      value = previous ? outputValue(previous) : (this.run.event.data ?? null);
    }
    if (agent.input?.schema) {
      const check = validateHandover(agent.input.schema, this.named, value);
      if (!check.ok) {
        await this.recordInvalid(agentId, 'input', 1, check.schemaDigest, check.errors);
        throw new HandoverFailure(
          'handover_invalid',
          `input of agent "${agentId}" does not match its input schema`,
        );
      }
    }
    return { skipped: false, explicit: from !== undefined, value };
  }

  /**
   * Validates the final text of a step against `output.schema`. Returns `null` when the step has no
   * output schema or the output is valid.
   */
  checkOutput(agent: AgentSpec, text: string): HandoverCheck | null {
    if (!agent.output) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        ok: false,
        schemaDigest: '',
        errors: [{ instancePath: '', keyword: 'json', schemaPath: '#' }],
      };
    }
    const check = validateHandover(agent.output.schema, this.named, parsed);
    return check.ok ? null : check;
  }

  async recordInvalid(
    agentId: string,
    direction: 'input' | 'output',
    attempt: number,
    schemaDigest: string,
    errors: HandoverViolation[],
  ): Promise<void> {
    await this.record({
      kind: 'handover',
      agentId,
      name: direction,
      status: 'error',
      output: { direction, attempt, schemaDigest, errors },
    });
  }

  async recordRetry(agentId: string, check: HandoverCheck): Promise<void> {
    await this.record({
      kind: 'handover',
      agentId,
      name: 'retry',
      status: 'pending',
      output: {
        direction: 'output',
        attempt: 2,
        schemaDigest: check.schemaDigest,
        errors: check.errors,
      },
    });
  }

  /** Message for the single retry turn (rule names and paths only). */
  retryMessage(check: HandoverCheck): string {
    return (
      'Your final answer does not match the required output schema:\n' +
      `${describeViolations(check.errors)}\n` +
      'Answer again with only the corrected JSON document.'
    );
  }

  /** Registers the output of a step that ran so that later steps can read it. */
  complete(out: AgentOutput): void {
    this.values[out.agentId] = outputValue(out);
  }
}

/** Prompt of a step with `input.from`: the selected values and nothing else. */
export function buildHandoverPrompt(value: unknown): string {
  return `Input for this step:\n\`\`\`json\n${JSON.stringify(redact(value ?? null), null, 2)}\n\`\`\``;
}
