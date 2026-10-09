import { createHash } from 'node:crypto';
import { createEvent } from '@openagentix/events';
import { and, eq, gte, inArray, like, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { agents, runs, tenants } from '../db/schema.js';
import { HttpError, notFound } from '../errors.js';
import type { Services } from '../services/index.js';
import {
  DEMO_EVENT_SOURCE,
  DEMO_EVENT_TYPE,
  DEMO_SCENARIO_TENANT_SLUG,
  DEMO_SCENARIOS,
  DEMO_TRIGGER_PREFIX,
  findDemoScenario,
} from './scenarios.js';

/** The tenant that scenario runs always appear in. */
export interface DemoTenantRef {
  id: string;
  slug: string;
  name: string;
}

export interface DemoOverview {
  llm: {
    mode: 'simulated' | 'claude-code';
    model: string | null;
    dailyBudgetUsd: number;
    spentTodayUsd: number;
    remainingUsd: number;
  };
  rateLimit: { runs: number; windowSeconds: number };
  /** Scenario runs are created in this tenant only, regardless of the acting tenant. */
  tenant: DemoTenantRef;
  scenarios: { id: string; title: string; description: string; agent: string }[];
}

export class DemoRateLimited extends HttpError {
  constructor(
    code: string,
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(429, code, message);
  }
}

const ACTIVE = ['queued', 'running', 'awaiting_approval'];

/** Visitor key: a salted hash of the client address (the address itself is never stored). */
export function visitorKey(ip: string, secret: string): string {
  return createHash('sha256').update(`${secret}|${ip}`).digest('hex').slice(0, 16);
}

/**
 * Starts fixed demo scenarios with per-visitor and global limits. In `claude-code` mode a daily
 * budget cap (including reservations for runs in flight) and a single concurrent run apply.
 */
export class DemoScenarioService {
  constructor(
    private readonly ctx: AppContext,
    private readonly services: Pick<Services, 'runs'>,
  ) {}

  private get demo() {
    return this.ctx.config.demo;
  }

  private startOfDay(): Date {
    const d = this.ctx.now();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }

  private async spentTodayMicros(): Promise<number> {
    const [r] = await this.ctx.db
      .select({ total: sql<number>`coalesce(sum(${runs.costMicros}), 0)::bigint` })
      .from(runs)
      .where(
        and(
          like(runs.triggeredBy, `${DEMO_TRIGGER_PREFIX}%`),
          gte(runs.createdAt, this.startOfDay()),
        ),
      );
    return Number(r?.total ?? 0);
  }

  private async scenarioTenant(): Promise<DemoTenantRef> {
    const [row] = await this.ctx.db
      .select({ id: tenants.id, slug: tenants.slug, name: tenants.name })
      .from(tenants)
      .where(eq(tenants.slug, DEMO_SCENARIO_TENANT_SLUG));
    if (!row) throw notFound('demo tenant');
    return row;
  }

  async overview(): Promise<DemoOverview> {
    if (!this.demo.enabled) throw notFound('demo');
    const tenant = await this.scenarioTenant();
    const spent = (await this.spentTodayMicros()) / 1e6;
    return {
      llm: {
        mode: this.demo.llm,
        model: this.demo.llm === 'claude-code' ? this.demo.llmModel : null,
        dailyBudgetUsd: this.demo.dailyBudgetUsd,
        spentTodayUsd: spent,
        remainingUsd: Math.max(0, this.demo.dailyBudgetUsd - spent),
      },
      rateLimit: { runs: this.demo.rate.runs, windowSeconds: this.demo.rate.windowSeconds },
      tenant,
      scenarios: DEMO_SCENARIOS.map(({ id, title, description, agent }) => ({
        id,
        title,
        description,
        agent,
      })),
    };
  }

  /** Queues a scenario run. `clientIp` identifies the visitor for rate limiting. */
  async start(
    scenarioId: string,
    clientIp: string,
  ): Promise<{ runId: string; tenant: DemoTenantRef }> {
    if (!this.demo.enabled) throw notFound('demo');
    const scenario = findDemoScenario(scenarioId);
    if (!scenario) throw notFound('scenario');
    const visitor = visitorKey(clientIp, this.ctx.config.runToken.secret);
    const trigger = `${DEMO_TRIGGER_PREFIX}${visitor}`;
    const now = this.ctx.now();

    const since = new Date(now.getTime() - this.demo.rate.windowSeconds * 1000);
    const mine = await this.ctx.db
      .select({ createdAt: runs.createdAt })
      .from(runs)
      .where(and(eq(runs.triggeredBy, trigger), gte(runs.createdAt, since)));
    if (mine.length >= this.demo.rate.runs) {
      const oldest = Math.min(...mine.map((r) => r.createdAt.getTime()));
      const wait = Math.max(
        1,
        Math.ceil((oldest + this.demo.rate.windowSeconds * 1000 - now.getTime()) / 1000),
      );
      throw new DemoRateLimited(
        'rate_limited',
        `at most ${this.demo.rate.runs} scenario runs per ${Math.round(this.demo.rate.windowSeconds / 60)} minutes per visitor`,
        wait,
      );
    }

    const [{ n: today = 0 } = {}] = await this.ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(runs)
      .where(
        and(
          like(runs.triggeredBy, `${DEMO_TRIGGER_PREFIX}%`),
          gte(runs.createdAt, this.startOfDay()),
        ),
      );
    if (Number(today) >= this.demo.dailyRuns)
      throw new DemoRateLimited('demo_daily_limit', 'the daily demo run limit is reached', 3600);

    if (this.demo.llm === 'claude-code') {
      const [{ n: active = 0 } = {}] = await this.ctx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(runs)
        .where(
          and(like(runs.triggeredBy, `${DEMO_TRIGGER_PREFIX}%`), inArray(runs.status, ACTIVE)),
        );
      if (Number(active) > 0)
        throw new DemoRateLimited(
          'demo_busy',
          'another demo run is in progress, try again shortly',
          15,
        );
      const spent = (await this.spentTodayMicros()) / 1e6;
      if (spent + this.demo.runBudgetUsd > this.demo.dailyBudgetUsd)
        throw new DemoRateLimited(
          'demo_budget_exhausted',
          'the daily budget for live model runs is used up; scenarios run again tomorrow',
          3600,
        );
    }

    // The agent is resolved inside the scenario tenant only (never from the principal).
    const tenant = await this.scenarioTenant();
    const [agent] = await this.ctx.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.name, scenario.agent), eq(agents.tenantId, tenant.id)));
    if (!agent) throw notFound('demo agent');
    const run = await this.services.runs.enqueue({
      agentId: agent.id,
      event: createEvent({
        source: DEMO_EVENT_SOURCE,
        type: DEMO_EVENT_TYPE,
        subject: scenario.id,
        data: scenario.data,
      }),
      triggeredBy: trigger,
    });
    return { runId: run.id, tenant };
  }
}
