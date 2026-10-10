import { randomUUID } from 'node:crypto';
import {
  PolicyBundleSchema,
  hasTenantPrefix,
  type AccessCatalog,
  evaluateToolCall,
  expandProfiles,
  loadAgentDefinition,
  type PolicyBundle,
  type PolicyDecision,
  type Principal,
  type TenantActor,
  type ToolCallRequest,
} from '@openagentix/core';
import {
  McpServerConfigSchema,
  checkStdioConfig,
  isTenantScope,
  stdioError,
  type McpServerConfig,
} from '@openagentix/mcp';
import { findStdioViolations, inlineStdioSteps, stdioIsolationMessage } from '../stdio.js';
import { assertConnectionAllowed, stdioAirgapContext, stdioAirgapProblem } from '../airgap.js';
import {
  CATALOG_PROVIDER_FOR,
  ProviderSettingsSchema,
  proposeModels,
  secretRefsOf,
  type ModelEntry,
} from '@openagentix/providers';
import { and, asc, eq, or } from 'drizzle-orm';
import { cached } from '../cache.js';
import type { AppContext } from '../context.js';
import { DEFAULT_TENANT_ID, agents, connections, policies, teams, tenants } from '../db/schema.js';
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
export type ConnectionKind = 'mcp' | 'model';
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
  async connectionsForRun(
    kind: string,
    scope: RunScope,
    opts: { fresh?: boolean } = {},
  ): Promise<ConnectionRow[]> {
    // `fresh` (the model proxy) bypasses the 30 s cache so a removed or changed connection takes
    // effect on the next call.
    const load = async () =>
      (
        await this.ctx.db
          .select()
          .from(connections)
          .where(and(eq(connections.kind, kind), this.visible(scope.tenantId)))
      ).map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      }));
    const rows = opts.fresh
      ? await load()
      : await cached(this.ctx.cache, `connections:${kind}:${scope.tenantId}`, 30_000, load);
    return resolveConnections(
      rows.map((r) => ({
        ...r,
        createdAt: new Date(r.createdAt),
        updatedAt: new Date(r.updatedAt),
      })),
      scope,
    );
  }

  /** Names of the MCP servers of a run that come from PLATFORM-scope connections. */
  async platformMcpNames(scope: RunScope): Promise<Set<string>> {
    return new Set(
      (await this.connectionsForRun('mcp', scope))
        .filter((c) => c.scope === 'platform')
        .map((c) => c.name),
    );
  }

  /** MCP server configs for a run (secrets stay references). */
  async mcpConfigs(scope: RunScope): Promise<McpServerConfig[]> {
    return (await this.connectionsForRun('mcp', scope)).map((c) =>
      McpServerConfigSchema.parse(c.config),
    );
  }

  /**
   * Tool classification and profiles of the MCP connections that apply to an agent (most specific
   * scope wins per name). Connections that do not parse are left out, so they are unknown to
   * expansion (fail closed).
   */
  async accessCatalog(scope: RunScope): Promise<AccessCatalog> {
    const out: Record<string, AccessCatalog[string]> = {};
    for (const c of await this.connectionsForRun('mcp', scope)) {
      const parsed = McpServerConfigSchema.safeParse(c.config);
      if (!parsed.success) continue;
      out[c.name] = {
        tools: Object.fromEntries(Object.entries(parsed.data.tools).map(([n, v]) => [n, v.access])),
        profiles: parsed.data.profiles,
        version: c.updatedAt.toISOString(),
      };
    }
    return out;
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

  /**
   * Validates a connection config by kind and returns what is stored. Model connections get
   * proposed prices from the pinned catalog for every listed model without a price; explicit
   * prices are kept as overrides. Secret references of tenant-owned connections must live in the
   * tenant's own namespace (`<tenant-slug>.<name>`) so that one tenant cannot spend another's keys.
   */
  async prepareConfig(
    actor: Principal,
    kind: ConnectionKind,
    name: string,
    scope: ConnectionScope,
    config: unknown,
  ): Promise<Record<string, unknown>> {
    let stored: Record<string, unknown>;
    let refs: string[];
    if (kind === 'mcp') {
      const parsed = McpServerConfigSchema.parse({ ...(config as object), name });
      stored = parsed;
      refs = [
        ...Object.values((parsed as { envSecrets?: Record<string, string> }).envSecrets ?? {}),
        ...Object.values(
          (parsed as { headerSecrets?: Record<string, string> }).headerSecrets ?? {},
        ),
      ];
    } else {
      const parsed = ProviderSettingsSchema.parse(config);
      const { name: _ignored, ...settings } = parsed;
      const catalogProvider = settings.catalogProvider ?? CATALOG_PROVIDER_FOR[settings.kind];
      const models = (settings.models ?? []).map((m): ModelEntry => {
        const [proposal] = proposeModels(this.ctx.modelCatalog, catalogProvider, [m]);
        const explicit = m.inputPerMTok !== undefined && m.outputPerMTok !== undefined;
        if (explicit)
          return {
            ...m,
            priceSource:
              proposal!.inputPerMTok === m.inputPerMTok &&
              proposal!.outputPerMTok === m.outputPerMTok
                ? proposal!.priceSource
                : 'override',
          };
        return {
          ...m,
          ...(proposal!.inputPerMTok !== null && proposal!.outputPerMTok !== null
            ? { inputPerMTok: proposal!.inputPerMTok, outputPerMTok: proposal!.outputPerMTok }
            : {}),
          priceSource: proposal!.priceSource,
        };
      });
      stored = { ...settings, ...(settings.models ? { models } : {}) } as Record<string, unknown>;
      refs = secretRefsOf(parsed);
    }
    if (scope !== 'platform' && actor.tenantId !== DEFAULT_TENANT_ID && refs.length) {
      const [t] = await this.ctx.db.select().from(tenants).where(eq(tenants.id, actor.tenantId));
      const prefix = `${t?.slug ?? actor.tenantId}.`;
      // Canonical comparison: the resolver maps `a.b-c` and `a-b.c` to the same secret.
      const foreign = refs.filter((r) => !hasTenantPrefix(t?.slug ?? actor.tenantId, r));
      if (foreign.length)
        throw new HttpError(
          400,
          'validation_failed',
          `secret references of tenant connections must start with "${prefix}" (got: ${foreign.join(', ')})`,
        );
    }
    // Air-gapped mode: the endpoint must be on the allowlist before the connection is stored.
    assertConnectionAllowed(kind, name, stored);
    if (kind === 'mcp') this.assertStdioAllowed(name, scope, stored);
    return stored;
  }

  /**
   * ADR 0016 S0: a tenant-defined stdio connection needs an allowlisted absolute command, no
   * always-refused program and no loader or interpreter hook in its environment; in air-gapped
   * mode the stdio air-gap rules apply to every scope. Platform connections are operator
   * configuration and skip the command rules.
   */
  private assertStdioAllowed(name: string, scope: ConnectionScope, stored: unknown): void {
    const cfg = stored as McpServerConfig;
    if (cfg.transport !== 'stdio') return;
    const airgap = this.ctx.config.airgap.enabled
      ? stdioAirgapProblem(name, scope, cfg, stdioAirgapContext(this.ctx.config))
      : null;
    if (airgap) throw new HttpError(422, 'airgap_violation', airgap);
    if (!isTenantScope(scope)) return;
    const issues = checkStdioConfig(cfg, {
      allowlist: this.ctx.config.mcp.stdioCommands,
      realpath: 'if-exists',
    });
    if (issues.length > 0) {
      const e = stdioError(name, issues);
      throw new HttpError(400, e.code, e.message, issues);
    }
  }

  /** Stdio rule issues of one stored connection, for the console (`[]` when it is fine). */
  stdioIssues(row: ConnectionRow): string[] {
    return findStdioViolations([row], this.ctx.config.mcp.stdioCommands).flatMap((v) =>
      v.issues.map((i) => i.message),
    );
  }

  /** Tenant stdio connections of the actor's tenant that break the rules (migration report). */
  async stdioViolations(
    actor: TenantActor,
  ): Promise<
    { connection: ConnectionRow; issues: { code: string; path: string; message: string }[] }[]
  > {
    const rows = await this.ctx.db
      .select()
      .from(connections)
      .where(and(eq(connections.tenantId, actor.tenantId), eq(connections.kind, 'mcp')))
      .orderBy(asc(connections.name));
    return findStdioViolations(rows, this.ctx.config.mcp.stdioCommands);
  }

  /** Resolved MCP connections of a run scope that a tenant defined with the stdio transport. */
  async tenantStdioConnections(scope: RunScope): Promise<ConnectionRow[]> {
    return (await this.connectionsForRun('mcp', scope, { fresh: true })).filter(
      (c) =>
        isTenantScope(c.scope) &&
        (c.config as { transport?: string } | null)?.transport === 'stdio',
    );
  }

  /**
   * Steps of a definition that would start a tenant stdio server inside the worker (`[]` = fine).
   * Used at publish and by the worker before it builds the gateway (second wall).
   */
  async stdioIsolationIssues(
    def: Parameters<typeof inlineStdioSteps>[0],
    scope: RunScope,
  ): Promise<{ path: string; message: string; step: string; server: string }[]> {
    const names = new Set((await this.tenantStdioConnections(scope)).map((c) => c.name));
    if (names.size === 0) return [];
    return inlineStdioSteps(def, names).map((v) => ({
      path: v.path,
      message: stdioIsolationMessage(v),
      step: v.step,
      server: v.server,
    }));
  }

  /**
   * Run-time check (defence in depth): the tenant stdio connections among `servers` must still
   * satisfy the command rules. A stored connection that does not (created before the rules, or the
   * allowlist shrank) is refused with an audit entry and an error the console shows with the run.
   */
  async assertStdioRunnable(
    scope: RunScope,
    servers: ReadonlySet<string>,
    where: { runId: string; actor: string; step?: string },
  ): Promise<string[]> {
    const names: string[] = [];
    for (const c of await this.tenantStdioConnections(scope)) {
      if (!servers.has(c.name)) continue;
      names.push(c.name);
      const bad = findStdioViolations([c], this.ctx.config.mcp.stdioCommands)[0];
      if (!bad) continue;
      const err = stdioError(c.name, bad.issues);
      this.ctx.metrics.mcpStdioRefused.inc({ code: err.code });
      await this.audit.append({
        actor: where.actor,
        tenantId: scope.tenantId,
        action: 'mcp.stdio.refused',
        target: c.id,
        runId: where.runId,
        payload: {
          connection: c.name,
          scope: c.scope,
          ...(where.step ? { step: where.step } : {}),
          code: err.code,
          issues: bad.issues.map((i) => ({ code: i.code, path: i.path, message: i.message })),
        },
      });
      throw new HttpError(422, err.code, err.message, bad.issues);
    }
    return names;
  }

  async createConnection(
    actor: Principal,
    input: {
      name: string;
      kind: ConnectionKind;
      config: unknown;
      scope?: ConnectionScope | undefined;
      scopeId?: string | null | undefined;
    },
  ): Promise<ConnectionRow> {
    const scope = input.scope ?? 'tenant';
    const scopeId = input.scopeId ?? null;
    await this.assertScope(actor, scope, scopeId);
    const config = await this.prepareConfig(actor, input.kind, input.name, scope, input.config);
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
    const parsed = await this.prepareConfig(
      actor,
      current.kind as ConnectionKind,
      current.name,
      current.scope as ConnectionScope,
      config,
    );
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
    const { definition, errors } = expandProfiles(
      def,
      await this.accessCatalog({ tenantId, teamId: null, agentId: '' }),
    );
    if (errors.length)
      throw new HttpError(400, 'validation_failed', 'tool grants are not allowed', errors);
    return evaluateToolCall(call, {
      definition,
      agent: definition.agents.find((a) => a.id === agentId) ?? agent,
      toolAccess: definition.toolAccess,
      bundles: [...(await this.enabledBundles(tenantId)), ...extraBundles],
    });
  }
}
