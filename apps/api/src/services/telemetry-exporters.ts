import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { connections } from '../db/schema.js';
import { telemetryHeaderSecretProblem } from './platform-secrets.js';
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
        // The same rules as when the connection was stored, checked again for every refresh: the
        // allowlist or the platform's secrets may have changed since.
        if (await telemetryHeaderSecretProblem(ctx, tenantId, c.headersSecret)) {
          warn('secret_reference_not_allowed');
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
        headersSecret: c.headersSecret,
        region: c.region,
        clearance: c.clearance,
        content: c.content === 'redacted',
      });
    }
    return out;
  };
}
