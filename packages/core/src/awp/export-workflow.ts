import type { PublishedDefinition } from '../agents/profiles.js';
import type { Trigger } from '../agents/schema.js';
import type { AgentExport, SecretUse } from './export-agent.js';
import type { ExportContext } from './export-context.js';
import type { JsonObject } from './types.js';

/** Event types a webhook and a mail trigger map to (a convention, see docs/awp.md). */
const EVENT_TYPES = { webhook: 'webhook.received', mail: 'mail.received' } as const;
const CRON_FIELDS = 5;

function exportTrigger(ctx: ExportContext, trigger: Trigger, path: string): JsonObject | null {
  switch (trigger.type) {
    case 'manual':
      return { type: 'manual' };
    case 'webhook':
    case 'mail':
      return { type: 'event', source: trigger.source, eventType: EVENT_TYPES[trigger.type] };
    case 'kafka':
      return {
        type: 'event',
        source: 'kafka',
        eventType: 'message',
        filter: { topic: trigger.topic },
      };
    case 'cron': {
      if (trigger.schedule.trim().split(/\s+/).length !== CRON_FIELDS) {
        ctx.refuse(
          'trigger_not_representable',
          `${path}.schedule`,
          'AWP schedules have exactly five cron fields',
        );
        return null;
      }
      if (trigger.timezone === undefined) {
        // agents.md uses the process time zone, AWP defaults to UTC: no silent reinterpretation.
        ctx.refuse(
          'trigger_not_representable',
          `${path}.timezone`,
          'a schedule needs an explicit timezone (agents.md uses the process time zone)',
        );
        return null;
      }
      return { type: 'schedule', cron: trigger.schedule.trim(), timezone: trigger.timezone };
    }
    default:
      ctx.refuse('trigger_not_representable', path, 'unknown trigger type');
      return null;
  }
}

export interface TriggerExport {
  triggers: JsonObject[];
  /** An external event starts the run, so the first step receives the payload as an input. */
  hasEvent: boolean;
}

/** True when an external event (webhook, mail, Kafka) starts the run. */
export function hasEventTrigger(def: PublishedDefinition): boolean {
  return (def.triggers ?? []).some((t) => ['webhook', 'mail', 'kafka'].includes(t.type));
}

export function exportTriggers(ctx: ExportContext, def: PublishedDefinition): TriggerExport {
  const source = def.triggers ?? [{ type: 'manual' as const }];
  const triggers = source.flatMap((t, i): JsonObject[] => {
    const exported = exportTrigger(ctx, t, `triggers.${i}`);
    return exported ? [exported] : [];
  });
  return { triggers, hasEvent: hasEventTrigger(def) };
}

/**
 * Workflow steps in pipeline order, chained through `dependsOn` and the previous step's `result`
 * output; the first step receives the event payload when an event triggers the run.
 */
export function exportSteps(
  ctx: ExportContext,
  def: PublishedDefinition,
  exported: ReadonlyMap<string, AgentExport>,
  hasEvent: boolean,
): JsonObject[] {
  const order = def.pipeline ?? def.agents.map((a) => a.id);
  const seen = new Set<string>();
  const steps: JsonObject[] = [];
  order.forEach((id, k) => {
    const base = exported.get(id);
    if (!base || seen.has(id)) {
      ctx.refuse(
        'pipeline_not_representable',
        `pipeline.${k}`,
        base
          ? `agent "${id}" appears twice in the pipeline`
          : `pipeline names unknown agent "${id}"`,
      );
      return;
    }
    seen.add(id);
    const step: JsonObject = { ...base.step, outputs: [{ name: 'result' }] };
    const previous = order[k - 1];
    if (previous !== undefined) {
      step.dependsOn = [previous];
      step.task = `\${{ steps.${previous}.outputs.result }}`;
    } else if (hasEvent) step.task = '${{ inputs.event }}';
    steps.push(step);
  });
  return steps;
}

/** `spec.secrets`: one declaration per name, scoped to the agents that reference it. */
export function exportSecrets(ctx: ExportContext, uses: readonly SecretUse[]): JsonObject[] {
  const byName = new Map<string, { ref: string; scope: string[] }>();
  for (const u of uses) {
    const known = byName.get(u.name);
    if (known && known.ref !== u.ref)
      ctx.refuse(
        'secret_not_representable',
        `agents.${u.agentId}.credentials`,
        `secrets "${known.ref}" and "${u.ref}" map to the same AWP name "${u.name}"`,
      );
    else if (known) known.scope.push(u.agentId);
    else byName.set(u.name, { ref: u.ref, scope: [u.agentId] });
  }
  return [...byName]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, v]): JsonObject => {
      const secret: JsonObject = { name, source: 'openagentix', scope: [...new Set(v.scope)] };
      if (v.ref !== name) secret.key = v.ref;
      return secret;
    });
}

/** `spec.approval` for the tools that need a human approval; `null` when none does. */
export function exportApproval(
  def: PublishedDefinition,
  agents: readonly AgentExport[],
): JsonObject | null {
  const requiredFor = [...new Set(agents.flatMap((a) => a.approvalRequired))];
  if (requiredFor.length === 0) return null;
  const approval: JsonObject = { requiredFor };
  const roles = def.approvals?.approverRoles ?? [];
  if (roles.length > 0) approval.approvers = roles.map((role) => ({ role }));
  if (def.approvals?.timeoutSeconds !== undefined)
    approval.timeout = `${def.approvals.timeoutSeconds}s`;
  // On timeout the run fails with `approval_timeout`; a rejection prevents only the action.
  approval.onTimeout = 'fail';
  return approval;
}
