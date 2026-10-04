import { randomUUID } from 'node:crypto';
import {
  PolicyBundleSchema,
  evaluateToolCall,
  loadAgentDefinition,
  type PolicyBundle,
  type PolicyDecision,
  type Principal,
  type TenantActor,
  type ToolCallRequest,
} from '@openagentix/core';
import { assertConnectionAllowed } from '../airgap.js';
import { McpServerConfigSchema, type McpServerConfig } from '@openagentix/mcp';
import { and, asc, eq, or } from 'drizzle-orm';
import { cached } from '../cache.js';
import type { AppContext } from '../context.js';
import { agents, connections, policies, teams } from '../db/schema.js';
import { HttpError, conflict, forbidden, notFound } from '../errors.js';
import type { AuditService } from './audit.js';

export type ConnectionRow = typeof connections.$inferSelect;
export type PolicyRow = typeof policies.$inferSelect;

function assertRegexes(bundle: PolicyBundle): void {
  for (const f of bundle.forbiddenArgPatterns) {
    try {
      new RegExp(f.pattern, 'iu');
    } catch (e) {
      throw new HttpError(
        400,
        'validation_failed',
        `invalid pattern ${f.pattern}: ${(e as Error).message}`,
      );
    }
  }
}

/** Where a run executes: connections resolve most specific first (agent, team, tenant, platform). */
export interface RunScope {
  tenantId: string;
  teamId: string | null;
  agentId: string;
}

export type ConnectionScope = 'platform' | 'tenant' | 'team' | 'agent';
const SCOPE_RANK: Record<string, number> = { platform: 0, tenant: 1, team: 2, agent: 3 };

/** Picks, per name, the most specific connection that applies to the run scope. */
export function resolveConnections<T extends ConnectionRow>(
  rows: readonly T[],
  scope: RunScope,
): T[] {
  const applies = (c: ConnectionRow) =>
    c.scope === 'platform' ||
    (c.tenantId === scope.tenantId &&
      (c.scope === 'tenant' ||
        (c.scope === 'team' && c.scopeId === scope.teamId) ||
        (c.scope === 'agent' && c.scopeId === scope.agentId)));
  const best = new Map<string, T>();
  for (const c of rows.filter(applies)) {
    const cur = best.get(c.name);
    if (!cur || (SCOPE_RANK[c.scope] ?? 0) > (SCOPE_RANK[cur.scope] ?? 0)) best.set(c.name, c);
  }
  return [...best.values()];
}

/** Connections (MCP servers with secret references) and policy bundles, tenant-scoped. */
export class CatalogService {
  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
  ) {}

  // ---------- connections ----------

  private visible(tenantId: string) {
    return or(eq(connections.tenantId, tenantId), eq(connections.scope, 'platform'));
  }

  async listConnections(actor: TenantActor): Promise<ConnectionRow[]> {
    return this.ctx.db
      .select()
      .from(connections)
      .where(this.visible(actor.tenantId))
      .orderBy(asc(connections.name));
  }

  async getConnection(actor: TenantActor, id: string): Promise<ConnectionRow> {
    const [row] = await this.ctx.db
      .select()
      .from(connections)
      .where(and(eq(connections.id, id), this.visible(actor.tenantId)));
    if (!row) throw notFound('connection');
    return row;
  }

  /** Connections of a kind that apply to a run (most specific scope wins per name). */
  async connectionsForRun(kind: string, scope: RunScope): Promise<ConnectionRow[]> {
    const rows = await cached(
      this.ctx.cache,
      `connections:${kind}:${scope.tenantId}`,
      30_000,
      async () =>
        (
          await this.ctx.db
            .select()
            .from(connections)
            .where(and(eq(connections.kind, kind), this.visible(scope.tenantId)))
        ).map((r) => ({
          ...r,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        })),
    );
    return resolveConnections(
      rows.map((r) => ({
        ...r,
        createdAt: new Date(r.createdAt),
        updatedAt: new Date(r.updatedAt),
      })),
      scope,
    );
  }

  /** MCP server configs for a run (secrets stay references). */
  async mcpConfigs(scope: RunScope): Promise<McpServerConfig[]> {
    return (await this.connectionsForRun('mcp', scope)).map((c) =>
      McpServerConfigSchema.parse(c.config),
    );
  }

  /** Validates scope/scopeId against the actor's tenant (404 for foreign teams/agents). */
  async assertScope(
    actor: Principal,
    scope: ConnectionScope,
    scopeId: string | null,
  ): Promise<void> {
    if (scope === 'platform') {
      if (!actor.platformAdmin)
        throw forbidden('platform connections need platform operator access');
      return;
    }
    if (scope === 'tenant') {
      if (scopeId !== null)
        throw new HttpError(400, 'validation_failed', 'tenant scope takes no scopeId');
      return;
    }
    if (!scopeId) throw new HttpError(400, 'validation_failed', `${scope} scope needs a scopeId`);
    const [owned] =
      scope === 'team'
        ? await this.ctx.db
            .select({ id: teams.id })
            .from(teams)
            .where(and(eq(teams.id, scopeId), eq(teams.tenantId, actor.tenantId)))
        : await this.ctx.db
            .select({ id: agents.id })
            .from(agents)
            .where(and(eq(agents.id, scopeId), eq(agents.tenantId, actor.tenantId)));
    if (!owned) throw notFound(scope);
  }

  async createConnection(
    actor: Principal,
    input: {
      name: string;
      kind: 'mcp';
      config: unknown;
      scope?: ConnectionScope | undefined;
      scopeId?: string | null | undefined;
    },
  ): Promise<ConnectionRow> {
    const scope = input.scope ?? 'tenant';
    const scopeId = input.scopeId ?? null;
    await this.assertScope(actor, scope, scopeId);
    const config = McpServerConfigSchema.parse({ ...(input.config as object), name: input.name });
    assertConnectionAllowed(config);
    const [exists] = await this.ctx.db
      .select({ id: connections.id })
      .from(connections)
      .where(and(eq(connections.name, input.name), eq(connections.tenantId, actor.tenantId)));
    if (exists) throw conflict(`connection "${input.name}" already exists`);
    const [row] = await this.ctx.db
      .insert(connections)
      .values({
        id: randomUUID(),
        tenantId: actor.tenantId,
        scope,
        scopeId,
        name: input.name,
        kind: input.kind,
        config,
        createdBy: actor.userId,
      })
      .returning();
    await this.invalidateConnections();
    await this.audit.append({
      actor: actor.userId,
      tenantId: actor.tenantId,
      action: 'connection.created',
      target: row!.id,
      payload: { name: input.name, kind: input.kind, scope, scopeId, config },
    });
    return row!;
  }

  /** Own rows only: platform connections of another tenant are read-only here. */
  private async getOwnConnection(actor: Principal, id: string): Promise<ConnectionRow> {
    const row = await this.getConnection(actor, id);
    if (row.tenantId !== actor.tenantId)
      throw forbidden('platform connections are managed by the platform operator');
    return row;
  }

  private async invalidateConnections(): Promise<void> {
    await this.ctx.cache.delPrefix('connections:');
  }

  async updateConnection(actor: Principal, id: string, config: unknown): Promise<ConnectionRow> {
    const current = await this.getOwnConnection(actor, id);
    const parsed = McpServerConfigSchema.parse({ ...(config as object), name: current.name });
    assertConnectionAllowed(parsed);
    const [row] = await this.ctx.db
      .update(connections)
      .set({ config: parsed, updatedAt: this.ctx.now() })
      .where(and(eq(connections.id, id), eq(connections.tenantId, actor.tenantId)))
      .returning();
    await this.invalidateConnections();
    await this.audit.append({
      actor: actor.userId,
      tenantId: actor.tenantId,
      action: 'connection.updated',
      target: id,
      payload: { config: parsed },
    });
    return row!;
  }

  async deleteConnection(actor: Principal, id: string): Promise<void> {
    await this.getOwnConnection(actor, id);
    await this.ctx.db
      .delete(connections)
      .where(and(eq(connections.id, id), eq(connections.tenantId, actor.tenantId)));
    await this.invalidateConnections();
    await this.audit.append({
      actor: actor.userId,
      tenantId: actor.tenantId,
      action: 'connection.deleted',
      target: id,
    });
  }

  // ---------- policies ----------

  private visiblePolicies(tenantId: string) {
    return or(eq(policies.tenantId, tenantId), eq(policies.scope, 'platform'));
  }

  async listPolicies(actor: TenantActor): Promise<PolicyRow[]> {
    return this.ctx.db
      .select()
      .from(policies)
      .where(this.visiblePolicies(actor.tenantId))
      .orderBy(asc(policies.name));
  }

  async getPolicy(actor: TenantActor, id: string): Promise<PolicyRow> {
    const [row] = await this.ctx.db
      .select()
      .from(policies)
      .where(and(eq(policies.id, id), this.visiblePolicies(actor.tenantId)));
    if (!row) throw notFound('policy');
    return row;
  }

  /** Enabled bundles that apply to a tenant: platform bundles plus its own (stricter only). */
  async enabledBundles(tenantId: string): Promise<PolicyBundle[]> {
    return cached(this.ctx.cache, `policies:${tenantId}`, 30_000, async () =>
      (
        await this.ctx.db
          .select()
          .from(policies)
          .where(and(eq(policies.enabled, true), this.visiblePolicies(tenantId)))
      ).map((p) => PolicyBundleSchema.parse(p.bundle)),
    );
  }

  async createPolicy(
    actor: Principal,
    input: {
      name: string;
      description?: string | undefined;
      bundle: unknown;
      enabled: boolean;
      scope?: 'platform' | 'tenant' | undefined;
    },
  ): Promise<PolicyRow> {
    const scope = input.scope ?? 'tenant';
    if (scope === 'platform' && !actor.platformAdmin)
      throw forbidden('platform policies need platform operator access');
    const bundle = PolicyBundleSchema.parse(input.bundle);
    assertRegexes(bundle);
    const [exists] = await this.ctx.db
      .select({ id: policies.id })
      .from(policies)
      .where(and(eq(policies.name, input.name), eq(policies.tenantId, actor.tenantId)));
    if (exists) throw conflict(`policy "${input.name}" already exists`);
    const [row] = await this.ctx.db
      .insert(policies)
      .values({
        id: randomUUID(),
        tenantId: actor.tenantId,
        scope,
        name: input.name,
        description: input.description ?? null,
        bundle,
        enabled: input.enabled,
        updatedBy: actor.userId,
      })
      .returning();
    await this.ctx.cache.delPrefix('policies:');
    await this.audit.append({
      actor: actor.userId,
      tenantId: actor.tenantId,
      action: 'policy.created',
      target: row!.id,
      payload: { name: input.name, scope, bundle, enabled: input.enabled },
    });
    return row!;
  }

  async updatePolicy(
    actor: Principal,
    id: string,
    input: { description?: string | undefined; bundle?: unknown; enabled?: boolean | undefined },
  ): Promise<PolicyRow> {
    const current = await this.getPolicy(actor, id);
    if (current.tenantId !== actor.tenantId)
      throw forbidden('platform policies are managed by the platform operator');
    const bundle =
      input.bundle === undefined
        ? PolicyBundleSchema.parse(current.bundle)
        : PolicyBundleSchema.parse(input.bundle);
    assertRegexes(bundle);
    const [row] = await this.ctx.db
      .update(policies)
      .set({
        bundle,
        description: input.description ?? current.description,
        enabled: input.enabled ?? current.enabled,
        version: current.version + 1,
        updatedAt: this.ctx.now(),
        updatedBy: actor.userId,
      })
      .where(and(eq(policies.id, id), eq(policies.tenantId, actor.tenantId)))
      .returning();
    await this.ctx.cache.delPrefix('policies:');
    await this.audit.append({
      actor: actor.userId,
      tenantId: actor.tenantId,
      action: 'policy.updated',
      target: id,
      payload: { version: row!.version, bundle, enabled: row!.enabled },
    });
    return row!;
  }

  /** Dry-run of the policy gate for a tool call against an agents.md source. */
  async evaluate(
    tenantId: string,
    source: string,
    agentId: string,
    call: ToolCallRequest,
    extraBundles: PolicyBundle[] = [],
  ): Promise<PolicyDecision> {
    const def = loadAgentDefinition(source);
    const agent = def.agents.find((a) => a.id === agentId);
    if (!agent)
      throw new HttpError(400, 'validation_failed', `agent "${agentId}" not found in definition`);
    return evaluateToolCall(call, {
      definition: def,
      agent,
      bundles: [...(await this.enabledBundles(tenantId)), ...extraBundles],
    });
  }
}
