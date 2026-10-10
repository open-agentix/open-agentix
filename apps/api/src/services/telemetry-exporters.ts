import { and, eq } from 'drizzle-orm';
import { hasTenantPrefix } from '@openagentix/core';
import type { AppContext } from '../context.js';
import { DEFAULT_TENANT_ID, connections, tenants } from '../db/schema.js';
import { parseHeaderList } from '../telemetry-config.js';
import {
  TelemetryConnectionConfigSchema,
  telemetryEndpointProblem,
  telemetryTracesUrl,
} from '../telemetry-connection.js';
import type { TenantExporterSource, TenantExporterSpec } from '../telemetry-tenant.js';

/**
 * The tenant-owned exporters of a tenant, resolved from its `telemetry` connections for the span
 * router (ADR 0015 7.3, slice S10). Only connections of the tenant itself, only `scope = tenant`,
 * only enabled ones that still pass every rule; anything else is left out (fail closed), never
 * "repaired". The header secret is read here, per refresh, and only for a reference that lives in
 * the tenant's own namespace.
 */
export function createTenantExporterSource(ctx: AppContext): TenantExporterSource {
  const warn = (reason: string) =>
    ctx.logger.warn({ reason }, 'a tenant telemetry exporter was left out');
  return async (tenantId): Promise<TenantExporterSpec[]> => {
    if (ctx.config.otel.tenantExporters !== 'allow') return [];
    const rows = await ctx.db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.kind, 'telemetry'),
          eq(connections.tenantId, tenantId),
          eq(connections.scope, 'tenant'),
        ),
      );
    if (rows.length === 0) return [];
    const [tenant] = await ctx.db.select().from(tenants).where(eq(tenants.id, tenantId));
    const out: TenantExporterSpec[] = [];
    for (const row of rows) {
      const parsed = TelemetryConnectionConfigSchema.safeParse(row.config);
      if (!parsed.success) {
        warn('invalid_config');
        continue;
      }
      const c = parsed.data;
      if (!c.enabled) continue;
      if (telemetryEndpointProblem(c.endpoint)) {
        warn('invalid_endpoint');
        continue;
      }
      let headers: Record<string, string> | undefined;
      if (c.headersSecret) {
        // Same rule as when the connection was stored: the reference must be the tenant's own.
        if (
          tenantId !== DEFAULT_TENANT_ID &&
          !hasTenantPrefix(tenant?.slug ?? tenantId, c.headersSecret)
        ) {
          warn('foreign_secret_reference');
          continue;
        }
        try {
          headers = parseHeaderList(await ctx.secrets.resolve(c.headersSecret));
        } catch {
          warn('headers_unavailable');
          continue;
        }
      }
      out.push({
        connectionId: row.id,
        tenantId,
        url: telemetryTracesUrl(c.endpoint),
        protocol: c.protocol,
        headers,
        region: c.region,
        clearance: c.clearance,
        content: c.content === 'redacted',
      });
    }
    return out;
  };
}
