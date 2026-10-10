import { type Principal } from '@openagentix/core';
import {
  McpServerConfigSchema,
  isTestableMcpConfig,
  testMcpServer,
  type McpTestResult,
} from '@openagentix/mcp';
import { createOutboundDispatcher } from '@openagentix/providers';
import { getNetworkSettings } from '../airgap.js';
import type { AppContext } from '../context.js';
import { HttpError, notFound } from '../errors.js';
import type { AuditService } from './audit.js';
import type { CatalogService } from './catalog.js';
import type { RunNodesService } from './run-nodes.js';

/** Tests per user and window: the test dials a destination that a tenant chose. */
const LIMIT = 10;
const WINDOW_MS = 60_000;

/**
 * Connectivity test of a stored HTTP MCP connection (ADR 0016 section 4.3).
 *
 * No free URL: the caller names a connection that already passed the save-time rules. The call goes
 * through the same transport as a run (outbound dispatcher, destination checks, pinned DNS, no
 * redirects) and answers with a category, a latency bucket and a tool count. Rate limited per user
 * (per replica) and audited with the category only.
 */
export class McpTestService {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly ctx: AppContext,
    private readonly catalog: CatalogService,
    private readonly runNodes: RunNodesService,
    private readonly audit: AuditService,
  ) {}

  private limit(userId: string): void {
    const now = this.ctx.now().getTime();
    const recent = (this.hits.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= LIMIT) {
      this.hits.set(userId, recent);
      throw new HttpError(429, 'rate_limited', 'too many connection tests, try again in a minute');
    }
    recent.push(now);
    this.hits.set(userId, recent);
    // Keep the map from growing with one entry per user forever.
    if (this.hits.size > 1000)
      for (const [k, v] of this.hits) if (v.every((t) => now - t >= WINDOW_MS)) this.hits.delete(k);
  }

  async test(actor: Principal, id: string): Promise<McpTestResult> {
    const row = await this.catalog.getConnection(actor, id);
    if (row.kind !== 'mcp') throw notFound('MCP connection');
    if (row.scope === 'platform' && !actor.platformAdmin)
      throw new HttpError(403, 'forbidden', 'platform connections need platform operator access');
    const parsed = McpServerConfigSchema.safeParse(row.config);
    // A stored config that no longer parses is reported like any other unusable connection.
    if (!parsed.success) return { ok: false, category: 'config_invalid', latency: '<100ms' };
    const cfg = parsed.data;
    if (!isTestableMcpConfig(cfg))
      throw new HttpError(
        400,
        'mcp_test_unsupported',
        'only streamable-http connections can be tested (a stdio test would start a process)',
      );
    this.limit(actor.userId);
    const settings = getNetworkSettings();
    const outbound =
      this.ctx.mcpOutbound ??
      createOutboundDispatcher({
        ...(settings ? { network: settings.net } : {}),
        allowPlainHttpForPlatform: true,
      });
    const platform = row.scope === 'platform';
    let result: McpTestResult;
    try {
      result = await testMcpServer(cfg, {
        secrets: platform ? this.ctx.secrets : await this.runNodes.resolverFor(actor.tenantId),
        outbound,
        originFor: () => (platform ? 'platform' : 'tenant'),
        ...(this.ctx.hostLookup ? { lookup: this.ctx.hostLookup } : {}),
      });
    } finally {
      if (!this.ctx.mcpOutbound) await outbound.close().catch(() => undefined);
    }
    await this.audit.append({
      actor: actor.userId,
      tenantId: actor.tenantId,
      action: 'connection.tested',
      target: id,
      payload: {
        kind: 'mcp',
        category: result.category,
        ...(result.httpClass ? { httpClass: result.httpClass } : {}),
        latency: result.latency,
      },
    });
    return result;
  }
}
