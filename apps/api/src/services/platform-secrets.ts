import { canonicalSecretRef, hasTenantPrefix, secretRefAllowed } from '@openagentix/core';
import { secretRefsOf } from '@openagentix/providers';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { getNetworkSettings } from '../airgap.js';
import { connections, eventSources, tenants } from '../db/schema.js';

/**
 * Secret references that belong to the PLATFORM and are never handed to a tenant-controlled
 * destination or a run node, whatever a tenant allowlist says: provider keys (environment providers
 * and every model connection), event source secrets, the secrets of platform connections, and (since
 * ADR 0015 S10) the operator's exporter header secret and the secrets of the network configuration
 * (proxy authentication, trust bundles, client certificates and keys). Canonical form.
 */
export async function platformSecretRefs(ctx: AppContext): Promise<Set<string>> {
  const out = new Set<string>();
  const walk = (v: unknown, secretish: boolean): void => {
    if (typeof v === 'string') {
      if (secretish && v) out.add(canonicalSecretRef(v));
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, secretish));
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) walk(x, secretish || /secret/i.test(k));
  };
  for (const p of ctx.config.providers) {
    walk(p, false);
    try {
      for (const r of secretRefsOf(p as never)) out.add(canonicalSecretRef(r));
    } catch {
      // unusual provider shape: the walk above already covered the *Secret fields
    }
  }
  for (const c of await ctx.db
    .select({ kind: connections.kind, scope: connections.scope, config: connections.config })
    .from(connections))
    if (c.kind === 'model' || c.scope === 'platform') walk(c.config, false);
  for (const e of await ctx.db
    .select({ refs: eventSources.secretRefs, config: eventSources.config })
    .from(eventSources)) {
    e.refs.forEach((r) => out.add(canonicalSecretRef(r)));
    walk(e.config, false);
  }
  // The operator's own exporter credentials and the network configuration's secrets.
  const headers = ctx.config.otel.headersSecret;
  if (headers) out.add(canonicalSecretRef(headers));
  const net = getNetworkSettings()?.net.config;
  if (net) {
    for (const p of net.proxies) if (p.authSecret) out.add(canonicalSecretRef(p.authSecret));
    for (const b of net.trust.bundles) if (b.secret) out.add(canonicalSecretRef(b.secret));
    for (const c of net.clientCertificates) {
      if (c.certSecret) out.add(canonicalSecretRef(c.certSecret));
      if (c.keySecret) out.add(canonicalSecretRef(c.keySecret));
    }
  }
  return out;
}

/**
 * Why a tenant may not use `ref` as the header secret of a `telemetry` connection, or `null`. It
 * is stricter than the rule for other connections: the value is sent to a destination the tenant
 * chose, so the reference must (1) not be a platform secret, (2) be in the tenant's own namespace
 * (`<slug>.`) and (3) be opened by the tenant's `secret_refs` allowlist. These apply to every
 * tenant, the default (home) tenant included; its allowlist is empty by default (migration 0009), so the
 * operator opens its namespace; the platform denylist holds either way.
 */
export async function telemetryHeaderSecretProblem(
  ctx: AppContext,
  tenantId: string,
  ref: string,
): Promise<string | null> {
  const [t] = await ctx.db
    .select({ slug: tenants.slug, refs: tenants.secretRefs })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!t) return 'the tenant does not exist';
  if ((await platformSecretRefs(ctx)).has(canonicalSecretRef(ref)))
    return 'the secret is reserved for the platform';
  if (!hasTenantPrefix(t.slug, ref)) return `the secret reference must start with "${t.slug}."`;
  if (!secretRefAllowed(t.refs, ref)) return 'the secret is not opened by the tenant secret_refs';
  return null;
}
