import { type Principal } from '@openagentix/core';
import {
  McpServerConfigSchema,
  isTestableMcpConfig,
  probeMcpServer,
  type McpTestResult,
  type McpTool,
} from '@openagentix/mcp';
import { createOutboundDispatcher } from '@openagentix/providers';
import { getNetworkSettings } from '../airgap.js';
import type { AppContext } from '../context.js';
import { HttpError, notFound } from '../errors.js';
import type { AuditService } from './audit.js';
import type { CatalogService, ConnectionRow } from './catalog.js';
import type { RunNodesService } from './run-nodes.js';

/** Tests per user and window: the test dials a destination that a tenant chose. */
const LIMIT = 10;
const WINDOW_MS = 60_000;
/** Response cap of a test: a `tools/list` page is small, a tenant server could send 64 MiB. */
const TEST_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

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
    if (recent.length >= (this.ctx.mcpProbeLimit ?? LIMIT)) {
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
    const { result, ran } = await this.probe(actor, id, 'test');
    // A stored config that does not parse is answered without a connection attempt: not audited.
    if (!ran) return result;
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

  /**
   * Connects to a stored HTTP MCP connection like a run does and lists its tools. The result is a
   * category; `tools` (untrusted server text) and `secrets` (the values resolved for the
   * connection, so that the caller can refuse a snapshot that contains one) are for the snapshot
   * refresh and must never reach a response or an audit entry. Shares the rate limit of the test.
   */
  async probe(
    actor: Principal,
    id: string,
    purpose: 'test' | 'refresh',
  ): Promise<{
    row: ConnectionRow;
    result: McpTestResult;
    /** False when the stored config was unusable and no connection was attempted. */
    ran: boolean;
    tools?: McpTool[];
    secrets: string[];
  }> {
    const row = await this.catalog.getConnection(actor, id);
    if (row.kind !== 'mcp') throw notFound('MCP connection');
    if (row.scope === 'platform' && !actor.platformAdmin)
      throw new HttpError(403, 'forbidden', 'platform connections need platform operator access');
    const parsed = McpServerConfigSchema.safeParse(row.config);
    // A stored config that no longer parses is reported like any other unusable connection.
    if (!parsed.success)
      return {
        row,
        result: { ok: false, category: 'config_invalid', latency: '<100ms' },
        ran: false,
        secrets: [],
      };
    const cfg = parsed.data;
    if (!isTestableMcpConfig(cfg))
      throw new HttpError(
        400,
        purpose === 'test' ? 'mcp_test_unsupported' : 'mcp_refresh_unsupported',
        purpose === 'test'
          ? 'only streamable-http connections can be tested (a stdio test would start a process)'
          : 'only streamable-http connections can be refreshed (a stdio refresh would start a process)',
      );
    this.limit(actor.userId);
    const settings = getNetworkSettings();
    const outbound =
      this.ctx.mcpOutbound ??
      createOutboundDispatcher({
        ...(settings ? { network: settings.net } : {}),
        allowPlainHttpForPlatform: true,
        limits: { maxResponseBytes: TEST_MAX_RESPONSE_BYTES },
      });
    const platform = row.scope === 'platform';
    const base = platform ? this.ctx.secrets : await this.runNodes.resolverFor(actor.tenantId);
    const secrets: string[] = [];
    let probed: Awaited<ReturnType<typeof probeMcpServer>>;
    try {
      probed = await probeMcpServer(cfg, {
        secrets: {
          resolve: async (ref) => {
            const value = await base.resolve(ref);
            secrets.push(value);
            return value;
          },
        },
        outbound,
        originFor: () => (platform ? 'platform' : 'tenant'),
        ...(this.ctx.hostLookup ? { lookup: this.ctx.hostLookup } : {}),
      });
    } finally {
      if (!this.ctx.mcpOutbound) await outbound.close().catch(() => undefined);
    }
    const { tools, ...result } = probed;
    return { row, result, ran: true, ...(tools ? { tools } : {}), secrets };
  }
}
