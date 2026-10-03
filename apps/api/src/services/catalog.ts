import { randomUUID } from 'node:crypto';
import {
  PolicyBundleSchema,
  evaluateToolCall,
  loadAgentDefinition,
  type PolicyBundle,
  type PolicyDecision,
  type ToolCallRequest,
} from '@openagentix/core';
import { McpServerConfigSchema, type McpServerConfig } from '@openagentix/mcp';
import { asc, eq } from 'drizzle-orm';
import { cached } from '../cache.js';
import type { AppContext } from '../context.js';
import { connections, policies } from '../db/schema.js';
import { HttpError, conflict, notFound } from '../errors.js';
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

/** Connections (MCP servers with secret references) and policy bundles. */
export class CatalogService {
  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
  ) {}

  // ---------- connections ----------

  async listConnections(): Promise<ConnectionRow[]> {
    return this.ctx.db.select().from(connections).orderBy(asc(connections.name));
  }

  async getConnection(id: string): Promise<ConnectionRow> {
    const [row] = await this.ctx.db.select().from(connections).where(eq(connections.id, id));
    if (!row) throw notFound('connection');
    return row;
  }

  /** MCP server configs for the worker (secrets stay references). */
  async mcpConfigs(): Promise<McpServerConfig[]> {
    return cached(this.ctx.cache, 'connections:mcp', 30_000, async () =>
      (await this.listConnections())
        .filter((c) => c.kind === 'mcp')
        .map((c) => McpServerConfigSchema.parse(c.config)),
    );
  }

  async createConnection(
    actor: string,
    input: { name: string; kind: 'mcp'; config: unknown },
  ): Promise<ConnectionRow> {
    const config = McpServerConfigSchema.parse({ ...(input.config as object), name: input.name });
    const [exists] = await this.ctx.db
      .select({ id: connections.id })
      .from(connections)
      .where(eq(connections.name, input.name));
    if (exists) throw conflict(`connection "${input.name}" already exists`);
    const [row] = await this.ctx.db
      .insert(connections)
      .values({ id: randomUUID(), name: input.name, kind: input.kind, config, createdBy: actor })
      .returning();
    await this.ctx.cache.del('connections:mcp');
    await this.audit.append({
      actor,
      action: 'connection.created',
      target: row!.id,
      payload: { name: input.name, kind: input.kind, config },
    });
    return row!;
  }

  async updateConnection(actor: string, id: string, config: unknown): Promise<ConnectionRow> {
    const current = await this.getConnection(id);
    const parsed = McpServerConfigSchema.parse({ ...(config as object), name: current.name });
    const [row] = await this.ctx.db
      .update(connections)
      .set({ config: parsed, updatedAt: this.ctx.now() })
      .where(eq(connections.id, id))
      .returning();
    await this.ctx.cache.del('connections:mcp');
    await this.audit.append({
      actor,
      action: 'connection.updated',
      target: id,
      payload: { config: parsed },
    });
    return row!;
  }

  async deleteConnection(actor: string, id: string): Promise<void> {
    const deleted = await this.ctx.db.delete(connections).where(eq(connections.id, id)).returning();
    if (deleted.length === 0) throw notFound('connection');
    await this.ctx.cache.del('connections:mcp');
    await this.audit.append({ actor, action: 'connection.deleted', target: id });
  }

  // ---------- policies ----------

  async listPolicies(): Promise<PolicyRow[]> {
    return this.ctx.db.select().from(policies).orderBy(asc(policies.name));
  }

  async getPolicy(id: string): Promise<PolicyRow> {
    const [row] = await this.ctx.db.select().from(policies).where(eq(policies.id, id));
    if (!row) throw notFound('policy');
    return row;
  }

  /** Enabled bundles, cached and invalidated on every change. */
  async enabledBundles(): Promise<PolicyBundle[]> {
    return cached(this.ctx.cache, 'policies:enabled', 30_000, async () =>
      (await this.ctx.db.select().from(policies).where(eq(policies.enabled, true))).map((p) =>
        PolicyBundleSchema.parse(p.bundle),
      ),
    );
  }

  async createPolicy(
    actor: string,
    input: { name: string; description?: string | undefined; bundle: unknown; enabled: boolean },
  ): Promise<PolicyRow> {
    const bundle = PolicyBundleSchema.parse(input.bundle);
    assertRegexes(bundle);
    const [exists] = await this.ctx.db
      .select({ id: policies.id })
      .from(policies)
      .where(eq(policies.name, input.name));
    if (exists) throw conflict(`policy "${input.name}" already exists`);
    const [row] = await this.ctx.db
      .insert(policies)
      .values({
        id: randomUUID(),
        name: input.name,
        description: input.description ?? null,
        bundle,
        enabled: input.enabled,
        updatedBy: actor,
      })
      .returning();
    await this.ctx.cache.del('policies:enabled');
    await this.audit.append({
      actor,
      action: 'policy.created',
      target: row!.id,
      payload: { name: input.name, bundle, enabled: input.enabled },
    });
    return row!;
  }

  async updatePolicy(
    actor: string,
    id: string,
    input: { description?: string | undefined; bundle?: unknown; enabled?: boolean | undefined },
  ): Promise<PolicyRow> {
    const current = await this.getPolicy(id);
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
        updatedBy: actor,
      })
      .where(eq(policies.id, id))
      .returning();
    await this.ctx.cache.del('policies:enabled');
    await this.audit.append({
      actor,
      action: 'policy.updated',
      target: id,
      payload: { version: row!.version, bundle, enabled: row!.enabled },
    });
    return row!;
  }

  /** Dry-run of the policy gate for a tool call against an agents.md source. */
  async evaluate(
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
      bundles: [...(await this.enabledBundles()), ...extraBundles],
    });
  }
}
