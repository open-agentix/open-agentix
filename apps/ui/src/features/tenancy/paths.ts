import { useSyncExternalStore } from 'react';

/**
 * Slug paths of tenants (`example-org/security`), learned from API responses that carry them.
 * `GET /v1/me` and `GET /v1/tenants` return no path or parent yet (tree scope arrives with the
 * A2/A3/A4 API slices), so today the only source is `tenant.slugPath` in the agent summaries.
 * The breadcrumb falls back to the tenant name alone for a tenant whose path is not known.
 */
const paths = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

export function rememberTenantPath(tenantId: string, slugPath: string): void {
  if (!tenantId || !slugPath || paths.get(tenantId) === slugPath) return;
  paths.set(tenantId, slugPath);
  version++;
  for (const l of listeners) l();
}

export function forgetTenantPaths(): void {
  paths.clear();
  version++;
  for (const l of listeners) l();
}

export function useTenantPath(tenantId: string | undefined): string[] | null {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
  const path = tenantId ? paths.get(tenantId) : undefined;
  return path ? path.split('/').filter(Boolean) : null;
}
