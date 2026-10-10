import { randomUUID } from 'node:crypto';
import { assertWithinCeiling, parseEgressEntry } from '@openagentix/runners';
import {
  checkPublish,
  expandProfiles,
  hasPermission,
  loadAgentDefinition,
  stripInvisible,
  validateAgentSource,
  visibleAgents,
  visibleTeams,
  type AgentDefinition,
  type Principal,
  type ValidationResult,
} from '@openagentix/core';
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, type SQL } from 'drizzle-orm';
import { cached } from '../cache.js';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { agentVersions, agents, teams } from '../db/schema.js';
import { HttpError, conflict, forbidden, notFound } from '../errors.js';
import { decodeTimeCursor, encodeTimeCursor, page } from '../pagination.js';
import { statusFilter, textFilter, useCaseFilter, type AgentStatus } from './agent-filters.js';
import type { AuditService } from './audit.js';
import type { CatalogService } from './catalog.js';
import type { ResolvedScope } from './subtree-scope.js';

/** Longest reason accepted when an agent is disabled or enabled. */
export const MAX_DISABLE_REASON_LENGTH = 500;

/**
 * Normalises a free-text disable/enable reason before it is stored, audited and shown: invisible
 * and bidi Unicode and control characters are removed (they could hide or reorder text in the
 * console and the audit export, and NUL is rejected by PostgreSQL), and line breaks, tabs and runs
 * of whitespace become one space, so the reason stays a single line. Empty results become null.
 */
export function cleanReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return stripInvisible(reason).text.replace(/\s+/gu, ' ').trim() || null;
}

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

/** Filters of {@link AgentsService.list}; all of them narrow the principal's visible agents. */
export interface AgentListQuery {
  limit: number;
  cursor?: string | undefined;
  q?: string | undefined;
  teamId?: string | undefined;
  useCase?: string | undefined;
  status?: AgentStatus | undefined;
}

/**
 * The use case an agent is attributed to (cost attribution and budgets use the same label). An
 * empty label counts as none, as in the backfill of migration 0015.
 */
const useCaseOf = (def: AgentDefinition): string | null => def.labels.useCase || null;

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
    const stdio = await this.catalog.stdioIsolationIssues(result.definition, {
      tenantId: principal.tenantId,
      teamId: await this.teamIdForOwner(principal.tenantId, result.definition.owner),
      agentId: '',
    });
    const all = [...errors, ...stdio.map(({ path, message }) => ({ path, message }))];
    // ADR 0016 S2 lint: MCP hosts that a step still lists in runtime.egress (advisory).
    const unused = await this.catalog.egressUnused(result.definition, {
      tenantId: principal.tenantId,
      teamId: await this.teamIdForOwner(principal.tenantId, result.definition.owner),
      agentId: '',
    });
    const withLint =
      unused.length > 0 ? { ...result, warnings: [...result.warnings, ...unused] } : result;
    if (all.length === 0) return withLint;
    return {
      ...withLint,
      valid: false,
      definition: null,
      errors: [...result.errors, ...all],
    };
  }

  /** `opts.id` fixes the agent id (deterministic demo seed); random when omitted. */
  async create(
    principal: Principal,
    source: string,
    opts: { id?: string } = {},
  ): Promise<AgentRow> {
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
        id: opts.id ?? randomUUID(),
        tenantId: principal.tenantId,
        name: def.name,
        teamId,
        description: def.description ?? null,
        useCase: useCaseOf(def),
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

  /**
   * The row filter for the agents the principal may read: the acting tenant with team and
   * agent-scoped bindings applied, or, for `scope=subtree`, the resolved predicate over the visible
   * nodes. `undefined` when nothing is readable.
   */
  private visibility(principal: Principal, subtree: ResolvedScope | undefined): SQL | undefined {
    if (subtree)
      return subtree.isEmpty
        ? undefined
        : subtree.predicate({ tenantId: agents.tenantId, teamId: agents.teamId, agent: agents.id });
    const teamsVisible = visibleTeams(principal, 'agents:read');
    const agentsVisible = visibleAgents(principal, 'agents:read');
    if (Array.isArray(teamsVisible) && teamsVisible.length === 0 && agentsVisible.length === 0)
      return undefined;
    return and(
      eq(agents.tenantId, principal.tenantId),
      teamsVisible === 'all'
        ? undefined
        : or(
            teamsVisible.length ? inArray(agents.teamId, teamsVisible) : undefined,
            agentsVisible.length ? inArray(agents.id, agentsVisible) : undefined,
          ),
    );
  }

  /**
   * Agents visible to the principal (own tenant only, team and agent-scoped bindings applied),
   * newest first, keyset-paged. Every filter is ANDed with the visibility scope: a filter value
   * can only narrow the result, never reach an agent the principal cannot read.
   */
  async list(principal: Principal, query: AgentListQuery, subtree?: ResolvedScope) {
    const c = decodeTimeCursor(query.cursor);
    const visibility = this.visibility(principal, subtree);
    if (!visibility) return { items: [], nextCursor: null };
    const rows = await this.ctx.db
      .select({ agent: agents })
      .from(agents)
      .leftJoin(
        agentVersions,
        and(eq(agentVersions.id, agents.latestVersionId), eq(agentVersions.agentId, agents.id)),
      )
      .where(
        and(
          visibility,
          query.q ? textFilter(query.q) : undefined,
          query.teamId ? eq(agents.teamId, query.teamId) : undefined,
          query.useCase ? useCaseFilter(query.useCase) : undefined,
          query.status ? statusFilter(query.status) : undefined,
          c
            ? or(lt(agents.createdAt, c.t), and(eq(agents.createdAt, c.t), lt(agents.id, c.id)))
            : undefined,
        ),
      )
      .orderBy(desc(agents.createdAt), desc(agents.id))
      .limit(query.limit + 1);
    return page(
      rows.map((r) => r.agent),
      query.limit,
      (r) => encodeTimeCursor(r.createdAt, r.id),
    );
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
        // The published version keeps defining the use case until a newer one is published.
        ...(agent.latestVersionId ? {} : { useCase: useCaseOf(def) }),
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
    // Per-step runners (ADR 0008): a step may run elsewhere than the pipeline, never on a runner
    // that is not enabled.
    def.agents.forEach((a, i) => {
      const r = a.runtime?.runner;
      if (r && !runners.enabled.includes(r))
        issues.push({
          path: `agents.${i}.runtime.runner`,
          message: `runner "${r}" is not enabled (OAX_RUNNERS_ENABLED=${runners.enabled.join(',')})`,
        });
    });
    // Harness steps (ADR 0009 section 10): only harnesses the operator enabled, on an isolating
    // runner that is enabled too (the definition check already rejects in-process and local).
    def.agents.forEach((a, i) => {
      const h = a.runtime?.harness;
      if (h && !this.ctx.config.harnesses.enabled.includes(h))
        issues.push({
          path: `agents.${i}.runtime.harness`,
          message: `harness "${h}" is not enabled (OAX_HARNESSES_ENABLED=${this.ctx.config.harnesses.enabled.join(',')})`,
        });
      if (!h) {
        // A normal step never runs on a harness image (it carries a proprietary binary and the
        // harness's settings): neither its toolbox nor the default image may be one.
        const cfg = runners.container.config;
        const isContainer = (a.runtime?.runner ?? def.runtime.runner) === 'container';
        if (cfg && isContainer) {
          const harnessImages = Object.values(cfg.harnessImages);
          const toolbox = a.toolbox ?? def.runtime.toolbox;
          const image = toolbox ? cfg.toolboxImages[toolbox] : cfg.image;
          if (image && harnessImages.includes(image))
            issues.push({
              path: `agents.${i}.${a.toolbox ? 'toolbox' : 'runtime.runner'}`,
              message: `step "${a.id}" has no harness but would run on a harness image; harness images are reserved for steps with runtime.harness`,
            });
        }
        return;
      }
      if (a.toolbox)
        issues.push({
          path: `agents.${i}.toolbox`,
          message: `harness step "${a.id}" must not set a toolbox: it runs on the image of its harness`,
        });
      // "Control node only": a harness step holds a model token and runs untrusted tool output, so it
      // publishes without egress hosts unless the operator opened that explicitly (DOG-1).
      const egress = a.runtime?.egress ?? def.runtime.egress;
      if (egress.length > 0 && !this.ctx.config.harnesses.egressAllowed)
        issues.push({
          path: `agents.${i}.runtime.egress`,
          message: `harness step "${a.id}" must not declare egress (runtime.egress: []); set OAX_HARNESS_EGRESS_ALLOWED=true to allow it`,
        });
      // The image of the harness must exist: otherwise the step would only fail when it starts.
      const container = runners.container.config;
      if (
        (a.runtime?.runner ?? def.runtime.runner) === 'container' &&
        container &&
        !container.harnessImages[h]
      )
        issues.push({
          path: `agents.${i}.runtime.harness`,
          message: `no run node image is configured for harness "${h}" (OAX_CONTAINER_HARNESS_IMAGES)`,
        });
    });
    // Step egress of container steps must lie inside the operator ceiling (never a union with it).
    const ceiling = (runners.container.config?.egressAllow ?? []).map(parseEgressEntry);
    def.agents.forEach((a, i) => {
      if ((a.runtime?.runner ?? def.runtime.runner) !== 'container') return;
      try {
        assertWithinCeiling(a.runtime?.egress ?? def.runtime.egress, ceiling);
      } catch (e) {
        issues.push({ path: `agents.${i}.runtime.egress`, message: (e as Error).message });
      }
    });
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

  /**
   * Switches an agent off (UX slice A7). Needs `agents:publish` on the agent, like publishing.
   * A disabled agent accepts no new runs (`409 agent_disabled`, see `RunsService.enqueue` and the
   * worker's claim query); runs that already started finish unless someone cancels them, and its
   * published versions stay immutable and readable. Idempotent: disabling a disabled agent changes
   * nothing (the first actor, time and reason stay) and writes no second audit entry.
   */
  async disable(
    principal: Principal,
    id: string,
    reason?: string | null,
  ): Promise<{ agent: AgentRow; changed: boolean }> {
    const agent = await this.get(id, principal);
    await this.assertAccess(principal, agent, 'agents:publish');
    const text = cleanReason(reason);
    if (text && text.length > MAX_DISABLE_REASON_LENGTH)
      throw new HttpError(400, 'validation_failed', 'reason must not exceed 500 characters');
    return this.ctx.db.transaction(async (tx) => {
      const [row] = await tx
        .update(agents)
        .set({ disabledAt: this.ctx.now(), disabledBy: principal.userId, disabledReason: text })
        .where(
          and(
            eq(agents.id, id),
            eq(agents.tenantId, principal.tenantId),
            isNull(agents.disabledAt),
          ),
        )
        .returning();
      if (!row)
        return { agent: await this.reload(tx as unknown as Db, id, principal), changed: false };
      await this.audit.append(
        {
          actor: principal.userId,
          tenantId: principal.tenantId,
          action: 'agent.disabled',
          target: id,
          payload: { reason: text },
        },
        tx as unknown as Db,
      );
      return { agent: row, changed: true };
    });
  }

  /** Switches a disabled agent back on; runs, triggers and the scheduler pick it up again. */
  async enable(
    principal: Principal,
    id: string,
    reason?: string | null,
  ): Promise<{ agent: AgentRow; changed: boolean }> {
    const agent = await this.get(id, principal);
    await this.assertAccess(principal, agent, 'agents:publish');
    const text = cleanReason(reason);
    if (text && text.length > MAX_DISABLE_REASON_LENGTH)
      throw new HttpError(400, 'validation_failed', 'reason must not exceed 500 characters');
    return this.ctx.db.transaction(async (tx) => {
      const [row] = await tx
        .update(agents)
        .set({ disabledAt: null, disabledBy: null, disabledReason: null })
        .where(
          and(
            eq(agents.id, id),
            eq(agents.tenantId, principal.tenantId),
            isNotNull(agents.disabledAt),
          ),
        )
        .returning();
      if (!row)
        return { agent: await this.reload(tx as unknown as Db, id, principal), changed: false };
      await this.audit.append(
        {
          actor: principal.userId,
          tenantId: principal.tenantId,
          action: 'agent.enabled',
          target: id,
          payload: {
            reason: text,
            wasDisabledAt: agent.disabledAt?.toISOString() ?? null,
          },
        },
        tx as unknown as Db,
      );
      return { agent: row, changed: true };
    });
  }

  private async reload(db: Db, id: string, principal: Principal): Promise<AgentRow> {
    const [row] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.tenantId, principal.tenantId)));
    if (!row) throw notFound('agent');
    return row;
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
      // ADR 0016 S3: tool definitions that were never reviewed (or a tool the review does not list)
      // are a refusal of their own, so a client can send the user to the Tools tab.
      const pinCode = errors.find(
        (e) => e.code === 'mcp_tools_unreviewed' || e.code === 'mcp_tool_unknown',
      )?.code;
      throw new HttpError(
        400,
        pinCode ?? 'validation_failed',
        pinCode
          ? 'the tool definitions of an MCP connection are not approved for these grants'
          : 'tool grants are not allowed on this platform',
        errors,
      );
    }
    // ADR 0016 S0: a tenant-defined stdio server never starts in the worker process.
    const stdio = await this.catalog.stdioIsolationIssues(def, {
      tenantId: principal.tenantId,
      teamId: agent.teamId,
      agentId: id,
    });
    if (stdio.length > 0) {
      const errors = stdio.map(({ path, message }) => ({ path, message }));
      await this.audit.append({
        actor: principal.userId,
        tenantId: principal.tenantId,
        action: 'agent.publish.denied',
        target: id,
        payload: {
          version: def.version,
          digest: def.digest,
          code: 'mcp_stdio_requires_isolation',
          errors,
        },
      });
      throw new HttpError(
        400,
        'mcp_stdio_requires_isolation',
        'tenant stdio connections run only in run nodes',
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
        .set({ latestVersionId: v!.id, latestVersion: v!.version, useCase: useCaseOf(def) })
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

  /** The ids among `ids` whose agent is disabled (used by the scheduler for cron event sources). */
  async disabledAgentIds(ids: readonly string[]): Promise<Set<string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Set();
    const rows = await this.ctx.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(inArray(agents.id, unique), isNotNull(agents.disabledAt)));
    return new Set(rows.map((r) => r.id));
  }

  /** Enabled, published agents with cron triggers (used by the scheduler; disabled agents have none). */
  async cronAgents(): Promise<
    { agentId: string; versionId: string; schedule: string; timezone?: string }[]
  > {
    const rows = await this.ctx.db
      .select({ agentId: agents.id, versionId: agents.latestVersionId })
      .from(agents)
      .where(and(isNotNull(agents.latestVersionId), isNull(agents.disabledAt)));
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
