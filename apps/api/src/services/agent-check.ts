import { createHash } from 'node:crypto';
import {
  ADVISOR_SYSTEM_PROMPT,
  buildAdvisorPrompt,
  classificationRank,
  generateAgentsMd,
  hasPermission,
  lintPlan,
  modelFindings,
  parsePlan,
  withModelFindings,
  type AccessClass,
  type AgentPlan,
  type AgentPlanLint,
  type OfferedConnection,
  type PlanFinding,
  type Principal,
  type ValidationIssue,
  genAiProviderName,
} from '@openagentix/core';
import type { ModelProvider } from '@openagentix/providers';
import { costLedger } from '../db/schema.js';
import type { Db } from '../db/client.js';
import type { AppContext } from '../context.js';
import { HttpError, forbidden } from '../errors.js';
import type { AuditService } from './audit.js';
import type { BudgetsService } from './budgets.js';
import type { CatalogService, ConnectionRow } from './catalog.js';
import type { ModelsService } from './models.js';
import { monthOf } from './runs.js';

/** Cost attribution label of plan checks that use a model (visible in `/v1/costs`). */
export const AGENT_CHECK_USE_CASE = 'agent-check';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const MODEL_MAX_TOKENS = 1500;
/** Clearance a provider needs: plans carry no classification, drafts default to `internal`. */
const ADVISOR_CLASSIFICATION = 'internal';

export interface PlanUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

export interface PlanCheckInput {
  source: string;
  /** Restrict the offered capabilities to these connection names. */
  connections?: string[] | undefined;
  /** Optional model-assisted suggestions (can only add `info`/`warning` findings). */
  assist?: { provider: string; model: string } | undefined;
}

export interface PlanCheckResult {
  valid: boolean;
  errors: ValidationIssue[];
  plan: AgentPlan | null;
  lint: AgentPlanLint | null;
  usage: PlanUsage | null;
}

export interface PlanGenerateInput {
  source: string;
  connections?: string[] | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  owner?: string | undefined;
}

export interface PlanGenerateResult {
  valid: boolean;
  errors: ValidationIssue[];
  plan: AgentPlan | null;
  lint: AgentPlanLint | null;
  /** The draft agents.md, or `null` when the plan is invalid or has error findings. */
  draft: string | null;
}

const accessOf = (v: unknown): AccessClass =>
  v === 'read' ||
  (typeof v === 'object' && v !== null && (v as { access?: unknown }).access === 'read')
    ? 'read'
    : 'write';

/**
 * What a stored MCP connection offers, reduced to names and access classes. `tools` may be a list
 * of names (every tool counts as write) or `{ name: { access } }`; `profiles` maps a profile name
 * to tool names. Anything else is ignored, so a connection that declares nothing (also empty `tools`/`profiles`, the stored defaults) is "not
 * declared" (conventional `read`/`write` profiles, every tool write) and never grants more.
 */
export function offeredFromConnection(
  row: Pick<ConnectionRow, 'name' | 'config'>,
): OfferedConnection {
  const cfg = (row.config ?? {}) as Record<string, unknown>;
  const out: {
    name: string;
    tools?: Record<string, AccessClass>;
    profiles?: Record<string, string[]>;
  } = {
    name: row.name,
  };
  const t = cfg.tools;
  if (Array.isArray(t)) {
    out.tools = Object.fromEntries(
      t
        .filter((x): x is string => typeof x === 'string')
        .slice(0, 1000)
        .map((n) => [n, 'write' as const]),
    );
  } else if (t && typeof t === 'object' && Object.keys(t).length > 0) {
    out.tools = Object.fromEntries(
      Object.entries(t)
        .slice(0, 1000)
        .map(([n, v]) => [n, accessOf(v)] as const),
    );
  }
  const p = cfg.profiles;
  if (p && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).length > 0) {
    out.profiles = Object.fromEntries(
      Object.entries(p)
        .slice(0, 100)
        .filter((e): e is [string, unknown[]] => Array.isArray(e[1]))
        .map(([n, tools]) => [n, tools.filter((x): x is string => typeof x === 'string')]),
    );
  }
  return out;
}

/** The scripted answer of the simulated provider (tests and the demo): one fixed info note. */
const SIMULATED_NOTES = JSON.stringify({
  notes: [
    {
      severity: 'info',
      message: 'Simulated model: no additional observations. Review each step against its purpose.',
    },
  ],
});

/**
 * Agent Check and Agent Plan v1 (ADR 0008 section 4): advisory only. The deterministic lint and
 * the generator run in core; this service supplies the tenant's connections, runs the optional
 * model step (permission, budget, clearance, cost ledger) and audits what happened. Nothing is
 * stored and nothing is published.
 */
export class AgentCheckService {
  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
    private readonly catalog: CatalogService,
    private readonly models: ModelsService,
    private readonly budgets: BudgetsService,
  ) {}

  private async offered(
    principal: Principal,
    names: readonly string[] | undefined,
  ): Promise<OfferedConnection[]> {
    if (!hasPermission(principal, 'connections:read'))
      throw forbidden('missing permission connections:read');
    const rows = (await this.catalog.listConnections(principal)).filter((r) => r.kind === 'mcp');
    const wanted = names ? new Set(names) : null;
    return rows
      .filter((r) => !wanted || wanted.has(r.name))
      .map(offeredFromConnection)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  async check(principal: Principal, input: PlanCheckInput): Promise<PlanCheckResult> {
    if (input.assist && !hasPermission(principal, 'agents:write'))
      throw forbidden('model-assisted checks need permission agents:write');
    const offered = await this.offered(principal, input.connections);
    const parsed = parsePlan(input.source);
    if (!parsed.plan)
      return { valid: false, errors: parsed.errors, plan: null, lint: null, usage: null };
    const plan = parsed.plan;
    let lint = lintPlan(plan, offered);
    let usage: PlanUsage | null = null;
    if (input.assist) {
      const advice = await this.advise(principal, plan, lint, offered, input.assist);
      usage = advice.usage;
      lint = withModelFindings(lint, advice.findings);
    }
    await this.audit.append({
      actor: principal.userId,
      tenantId: principal.tenantId,
      action: 'plan.checked',
      target: lint.planDigest,
      payload: {
        planDigest: lint.planDigest,
        lintVersion: lint.lintVersion,
        model: usage ? `${usage.provider}/${usage.model}` : null,
        summary: lint.summary,
        costMicros: usage?.costMicros ?? 0,
      },
    });
    return { valid: true, errors: [], plan, lint, usage };
  }

  async generate(principal: Principal, input: PlanGenerateInput): Promise<PlanGenerateResult> {
    const offered = await this.offered(principal, input.connections);
    const parsed = parsePlan(input.source);
    if (!parsed.plan)
      return { valid: false, errors: parsed.errors, plan: null, lint: null, draft: null };
    const plan = parsed.plan;
    const lint = lintPlan(plan, offered);
    const draft =
      lint.summary.error > 0
        ? null
        : generateAgentsMd(plan, lint, {
            ...(input.provider ? { provider: input.provider } : {}),
            ...(input.model ? { model: input.model } : {}),
            ...(input.owner ? { owner: input.owner } : {}),
          });
    await this.audit.append({
      actor: principal.userId,
      tenantId: principal.tenantId,
      action: 'plan.generated',
      target: lint.planDigest,
      payload: {
        planDigest: lint.planDigest,
        summary: lint.summary,
        draftDigest: draft ? `sha256:${createHash('sha256').update(draft).digest('hex')}` : null,
      },
    });
    return { valid: true, errors: [], plan, lint, draft };
  }

  /** The model step: costed and budget-checked like a run step, output is untrusted data. */
  private async advise(
    principal: Principal,
    plan: AgentPlan,
    lint: AgentPlanLint,
    offered: readonly OfferedConnection[],
    assist: { provider: string; model: string },
  ): Promise<{ findings: PlanFinding[]; usage: PlanUsage }> {
    const target = { tenantId: principal.tenantId, teamId: null, useCase: AGENT_CHECK_USE_CASE };
    const verdict = await this.budgets.verdictFor(target);
    const breach = verdict.breaches[0];
    if (breach) {
      await this.audit.append({
        actor: principal.userId,
        tenantId: principal.tenantId,
        action: 'budget.blocked',
        target: lint.planDigest,
        payload: { stage: 'plan.check', breaches: verdict.breaches },
      });
      throw new HttpError(402, `${breach.scope}_budget_exceeded`, breach.message);
    }
    const scope = { tenantId: principal.tenantId, teamId: null, agentId: '' };
    const registry = await this.models.registryFor(scope);
    if (!registry.has(assist.provider))
      throw new HttpError(
        400,
        'validation_failed',
        `model provider "${assist.provider}" is not configured`,
      );
    const provider: ModelProvider = registry.get(assist.provider);
    if (classificationRank(provider.clearance) < classificationRank(ADVISOR_CLASSIFICATION)) {
      throw new HttpError(
        403,
        'policy_denied',
        `provider "${provider.name}" is not cleared for ${ADVISOR_CLASSIFICATION} data`,
      );
    }
    let inputTokens = 0;
    let outputTokens = 0;
    let findings: PlanFinding[];
    try {
      const res = await provider.complete({
        model: assist.model,
        system: ADVISOR_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildAdvisorPrompt(plan, lint, offered) }],
        maxTokens: MODEL_MAX_TOKENS,
        temperature: 0,
        ...(provider.kind === 'simulated'
          ? { hints: { simulation: [{ text: SIMULATED_NOTES }] } }
          : {}),
      });
      inputTokens = res.usage.inputTokens;
      outputTokens = res.usage.outputTokens;
      findings = modelFindings(plan, res.text);
    } catch (e) {
      // The deterministic result stands without the model; say so in one fixed finding.
      this.ctx.logger.warn(
        { provider: provider.name, err: (e as Error).message },
        'plan advisor failed',
      );
      findings = [
        {
          code: 'MODEL',
          severity: 'info',
          path: 'plan',
          message: 'model suggestions are unavailable: the model call failed',
          source: 'model',
        },
      ];
    }
    const costModel = await this.models.costModelFor(scope);
    const costMicros = costModel.modelCall(provider.name, assist.model, {
      inputTokens,
      outputTokens,
    }).totalMicros;
    if (inputTokens > 0 || outputTokens > 0 || costMicros > 0) {
      await this.ctx.db.transaction(async (tx) => {
        await tx.insert(costLedger).values({
          runId: NIL_UUID,
          stepSeq: null,
          tenantId: principal.tenantId,
          useCase: AGENT_CHECK_USE_CASE,
          agentId: NIL_UUID,
          teamId: null,
          provider: provider.name,
          model: assist.model,
          month: monthOf(this.ctx.now()),
          tokensIn: inputTokens,
          tokensOut: outputTokens,
          costMicros,
        });
        await this.budgets.raiseAlerts(tx as unknown as Db, target, costMicros);
      });
      this.ctx.metrics.cost(genAiProviderName(provider.kind, provider.family), costMicros);
    }
    return {
      findings,
      usage: {
        provider: provider.name,
        model: assist.model,
        inputTokens,
        outputTokens,
        costMicros,
      },
    };
  }
}
