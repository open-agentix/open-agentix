import { randomUUID } from 'node:crypto';
import {
  checkPublish,
  expandProfiles,
  hasPermission,
  loadAgentDefinition,
  validateAgentSource,
  visibleAgents,
  visibleTeams,
  type AgentDefinition,
  type Principal,
  type ValidationResult,
} from '@openagentix/core';
import { and, desc, eq, ilike, inArray, lt, or, sql } from 'drizzle-orm';
import { cached } from '../cache.js';
import type { AppContext } from '../context.js';
import { agentVersions, agents, teams } from '../db/schema.js';
import { HttpError, conflict, forbidden, notFound } from '../errors.js';
import { decodeTimeCursor, encodeTimeCursor, page } from '../pagination.js';
import type { AuditService } from './audit.js';
import type { CatalogService } from './catalog.js';

export type AgentRow = typeof agents.$inferSelect;
export type AgentVersionRow = typeof agentVersions.$inferSelect;

export interface VersionSummary {
  id: string;
  agentId: string;
  version: string;
  digest: string;
  publishedBy: string | null;
  publishedAt: Date;
}

const summary = (v: AgentVersionRow): VersionSummary => ({
  id: v.id,
  agentId: v.agentId,
  version: v.version,
  digest: v.digest,
  publishedBy: v.publishedBy,
  publishedAt: v.publishedAt,
});

const IMMUTABLE_TTL = 3_600_000;

/** Agent registry: drafts, validation, immutable published versions. */
export class AgentsService {
  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
    private readonly catalog: CatalogService,
  ) {}

  async teamIdForOwner(tenantId: string, owner: string): Promise<string | null> {
    const [t] = await this.ctx.db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.slug, owner), eq(teams.tenantId, tenantId)));
    return t?.id ?? null;
  }

  /**
   * Resource-level check incl. agent-scoped bindings. Principals that cannot even read the agent
   * get 404 (existence is not revealed) and the denial is audited.
   */
  async assertAccess(
    principal: Principal,
    agent: AgentRow,
    permission: 'agents:read' | 'agents:write' | 'agents:publish' | 'runs:execute',
  ): Promise<void> {
    // Tenant boundary first: another tenant's agent does not exist for this principal.
    if (agent.tenantId === principal.tenantId) {
      if (hasPermission(principal, permission, agent.teamId, agent.id)) return;
    }
    if (
      agent.tenantId !== principal.tenantId ||
      !hasPermission(principal, 'agents:read', agent.teamId, agent.id)
    ) {
      await this.audit.append({
        actor: principal.userId,
        tenantId: principal.tenantId,
        action: 'access.denied',
        target: agent.id,
        payload: { permission, resource: 'agent' },
      });
      throw notFound('agent');
    }
    throw forbidden();
  }

  validate(source: string): ValidationResult {
    return validateAgentSource(source);
  }

  /**
   * Like {@link validate}, plus the checks that need the connection catalog: unknown connections
   * and profiles, and write tools for `access: read-only` steps (the same checks publish makes).
   */
  async validateFor(principal: Principal, source: string): Promise<ValidationResult> {
    const result = validateAgentSource(source);
    if (!result.definition) return result;
    const catalog = await this.catalog.accessCatalog({
      tenantId: principal.tenantId,
      teamId: await this.teamIdForOwner(principal.tenantId, result.definition.owner),
      agentId: '',
    });
    const { errors } = expandProfiles(result.definition, catalog);
    if (errors.length === 0) return result;
    return { ...result, valid: false, definition: null, errors: [...result.errors, ...errors] };
  }

  async create(principal: Principal, source: string): Promise<AgentRow> {
    const def = loadAgentDefinition(source);
    const teamId = await this.teamIdForOwner(principal.tenantId, def.owner);
    if (!hasPermission(principal, 'agents:write', teamId))
      throw forbidden(`no write access for team "${def.owner}"`);
    const [exists] = await this.ctx.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.name, def.name), eq(agents.tenantId, principal.tenantId)));
    if (exists) throw conflict(`agent "${def.name}" already exists`);
    const [row] = await this.ctx.db
      .insert(agents)
      .values({
        id: randomUUID(),
        tenantId: principal.tenantId,
        name: def.name,
        teamId,
        description: def.description ?? null,
        draftSource: source,
        createdBy: principal.userId,
      })
      .returning();
    await this.audit.append({
      actor: principal.userId,
      tenantId: principal.tenantId,
      action: 'agent.created',
      target: row!.id,
      payload: { name: def.name, version: def.version, digest: def.digest },
    });
    return row!;
  }

  /**
   * Loads an agent. Pass the caller's tenant for every request-facing lookup: an agent of another
   * tenant is then "not found" (and the attempt is audited in the caller's tenant). Only trusted
   * internal callers (worker, scheduler) omit it.
   */
  async get(
    id: string,
    tenant?: Pick<Principal, 'tenantId' | 'userId'> | string,
  ): Promise<AgentRow> {
    const [row] = await this.ctx.db.select().from(agents).where(eq(agents.id, id));
    const tenantId = typeof tenant === 'string' ? tenant : tenant?.tenantId;
    if (!row) throw notFound('agent');
    if (tenantId && row.tenantId !== tenantId) {
      await this.audit.append({
        actor: typeof tenant === 'object' ? tenant.userId : 'unknown',
        tenantId,
        action: 'access.denied',
        target: id,
        payload: { permission: 'agents:read', resource: 'agent' },
      });
      throw notFound('agent');
    }
    return row;
  }

  async list(principal: Principal, limit: number, cursor?: string, q?: string) {
    const c = decodeTimeCursor(cursor);
    const teamsVisible = visibleTeams(principal, 'agents:read');
    const agentsVisible = visibleAgents(principal, 'agents:read');
    if (Array.isArray(teamsVisible) && teamsVisible.length === 0 && agentsVisible.length === 0)
      return { items: [], nextCursor: null };
    const rows = await this.ctx.db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.tenantId, principal.tenantId),
          teamsVisible === 'all'
            ? undefined
            : or(
                teamsVisible.length ? inArray(agents.teamId, teamsVisible) : undefined,
                agentsVisible.length ? inArray(agents.id, agentsVisible) : undefined,
              ),
          q ? ilike(agents.name, `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`) : undefined,
          c
            ? or(lt(agents.createdAt, c.t), and(eq(agents.createdAt, c.t), lt(agents.id, c.id)))
            : undefined,
        ),
      )
      .orderBy(desc(agents.createdAt), desc(agents.id))
      .limit(limit + 1);
    return page(rows, limit, (r) => encodeTimeCursor(r.createdAt, r.id));
  }

  async updateDraft(principal: Principal, id: string, source: string): Promise<AgentRow> {
    const agent = await this.get(id, principal);
    await this.assertAccess(principal, agent, 'agents:write');
    const def = loadAgentDefinition(source);
    if (def.name !== agent.name)
      throw new HttpError(400, 'validation_failed', `name must stay "${agent.name}"`);
    const [row] = await this.ctx.db
      .update(agents)
      .set({
        draftSource: source,
        draftUpdatedAt: this.ctx.now(),
        description: def.description ?? null,
      })
      .where(eq(agents.id, id))
      .returning();
    await this.audit.append({
      actor: principal.userId,
      tenantId: principal.tenantId,
      action: 'agent.draft.updated',
      target: id,
      payload: { version: def.version, digest: def.digest },
    });
    return row!;
  }

  /** Platform constraints on `runtime`: enabled runners and the toolbox allowlist. */
  checkRuntime(def: AgentDefinition): void {
    const issues: { path: string; message: string }[] = [];
    const { runners, toolboxes } = this.ctx.config;
    if (!runners.enabled.includes(def.runtime.runner)) {
      issues.push({
        path: 'runtime.runner',
        message: `runner "${def.runtime.runner}" is not enabled (OAX_RUNNERS_ENABLED=${runners.enabled.join(',')})`,
      });
    }
    if (toolboxes.allowlist.length > 0) {
      const used = [def.runtime.toolbox, ...def.agents.map((a) => a.toolbox)].filter(
        (t): t is string => !!t,
      );
      for (const t of new Set(used)) {
        if (!toolboxes.allowlist.includes(t))
          issues.push({
            path: 'runtime.toolbox',
            message: `toolbox "${t}" is not in OAX_TOOLBOX_ALLOWLIST`,
          });
      }
    }
    if (issues.length)
      throw new HttpError(
        400,
        'validation_failed',
        'agent runtime is not allowed on this platform',
        issues,
      );
  }

  /** Publishes the current draft as an immutable version (idempotent for identical content). */
  async publish(
    principal: Principal,
    id: string,
  ): Promise<{ version: VersionSummary; created: boolean }> {
    const agent = await this.get(id, principal);
    await this.assertAccess(principal, agent, 'agents:publish');
    const def = loadAgentDefinition(agent.draftSource);
    this.checkRuntime(def);
    const published = await this.ctx.db
      .select()
      .from(agentVersions)
      .where(eq(agentVersions.agentId, id));
    const outcome = checkPublish(published, def);
    if (outcome === 'unchanged') {
      return {
        version: summary(published.find((p) => p.version === def.version)!),
        created: false,
      };
    }
    // Profile grants become concrete grants now and are stored with the version: a later change
    // of a profile never widens it. Read-only steps never receive a write tool.
    const { definition, errors } = expandProfiles(
      def,
      await this.catalog.accessCatalog({
        tenantId: principal.tenantId,
        teamId: agent.teamId,
        agentId: id,
      }),
    );
    if (errors.length > 0) {
      await this.audit.append({
        actor: principal.userId,
        tenantId: principal.tenantId,
        action: 'agent.publish.denied',
        target: id,
        payload: { version: def.version, digest: def.digest, errors },
      });
      throw new HttpError(
        400,
        'validation_failed',
        'tool grants are not allowed on this platform',
        errors,
      );
    }
    const row = await this.ctx.db.transaction(async (tx) => {
      const [v] = await tx
        .insert(agentVersions)
        .values({
          id: randomUUID(),
          agentId: id,
          version: def.version,
          digest: def.digest,
          source: agent.draftSource,
          definition: definition as unknown as object,
          publishedBy: principal.userId,
        })
        .returning();
      await tx
        .update(agents)
        .set({ latestVersionId: v!.id, latestVersion: v!.version })
        .where(eq(agents.id, id));
      return v!;
    });
    await this.ctx.cache.del(`agent-latest:${id}`);
    await this.audit.append({
      actor: principal.userId,
      tenantId: principal.tenantId,
      action: 'agent.published',
      target: id,
      payload: { version: row.version, digest: row.digest },
    });
    if (definition.expansion?.length) {
      await this.audit.append({
        actor: principal.userId,
        tenantId: principal.tenantId,
        action: 'agent.profiles.expanded',
        target: id,
        payload: {
          version: row.version,
          expansionDigest: definition.expansionDigest,
          expansion: definition.expansion,
        },
      });
    }
    return { version: summary(row), created: true };
  }

  async versions(id: string): Promise<VersionSummary[]> {
    const rows = await this.ctx.db
      .select()
      .from(agentVersions)
      .where(eq(agentVersions.agentId, id))
      .orderBy(desc(agentVersions.publishedAt));
    return rows.map(summary);
  }

  async getVersion(agentId: string, version: string): Promise<AgentVersionRow> {
    const [row] = await this.ctx.db
      .select()
      .from(agentVersions)
      .where(and(eq(agentVersions.agentId, agentId), eq(agentVersions.version, version)));
    if (!row) throw notFound('agent version');
    return row;
  }

  /** Published versions are immutable, so the parsed definition can be cached for a long time. */
  async definitionOf(
    versionId: string,
  ): Promise<{ id: string; agentId: string; version: string; definition: AgentDefinition }> {
    const v = await cached(
      this.ctx.cache,
      `agent-version:${versionId}`,
      IMMUTABLE_TTL,
      async () => {
        const [row] = await this.ctx.db
          .select()
          .from(agentVersions)
          .where(eq(agentVersions.id, versionId));
        return row
          ? {
              id: row.id,
              agentId: row.agentId,
              version: row.version,
              definition: row.definition as AgentDefinition,
            }
          : null;
      },
    );
    if (!v) throw notFound('agent version');
    return v;
  }

  async latestVersionId(
    agentId: string,
  ): Promise<{ versionId: string | null; teamId: string | null; tenantId: string }> {
    return cached(this.ctx.cache, `agent-latest:${agentId}`, 60_000, async () => {
      const [a] = await this.ctx.db
        .select({ v: agents.latestVersionId, t: agents.teamId, tenantId: agents.tenantId })
        .from(agents)
        .where(eq(agents.id, agentId));
      if (!a) throw notFound('agent');
      return { versionId: a.v, teamId: a.t, tenantId: a.tenantId };
    });
  }

  /** Published agents with cron triggers (used by the scheduler). */
  async cronAgents(): Promise<
    { agentId: string; versionId: string; schedule: string; timezone?: string }[]
  > {
    const rows = await this.ctx.db
      .select({ agentId: agents.id, versionId: agents.latestVersionId })
      .from(agents)
      .where(sql`${agents.latestVersionId} is not null`);
    const out: { agentId: string; versionId: string; schedule: string; timezone?: string }[] = [];
    for (const r of rows) {
      const { definition } = await this.definitionOf(r.versionId!);
      for (const t of definition.triggers) {
        if (t.type === 'cron')
          out.push({
            agentId: r.agentId,
            versionId: r.versionId!,
            schedule: t.schedule,
            ...(t.timezone ? { timezone: t.timezone } : {}),
          });
      }
    }
    return out;
  }
}
