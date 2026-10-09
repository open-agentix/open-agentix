import { useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { meQuery } from '../auth/auth';
import { useT } from '../i18n/i18n';
import { activeTenant } from '../lib/activeTenant';
import { tenantColorIndex, tenantInitials } from '../lib/tenant';

export interface TenantRef {
  id: string;
  slug: string;
  name: string;
}

/**
 * The acting tenant. `GET /v1/me` reports the tenant the API really used (it echoes
 * `X-OAX-Tenant`); while that answer is pending after a switch the chosen tenant is shown, so the
 * chip never shows the tenant the user just left.
 */
export function useActiveTenant(): TenantRef | null {
  const { data } = useQuery(meQuery);
  const chosen = useSyncExternalStore(activeTenant.subscribe, activeTenant.snapshot);
  if (data && (!chosen || data.tenant.id === chosen.id)) return data.tenant;
  return chosen;
}

/** Coloured tile with two initials. Decorative: the tenant name is always rendered next to it. */
export function TenantTile({ tenant, small = false }: { tenant: TenantRef; small?: boolean }) {
  const color = tenantColorIndex(tenant.id || tenant.slug);
  return (
    <span
      className={`tenant-tile tc-${color}${small ? ' tenant-tile-sm' : ''}`}
      aria-hidden="true"
      data-tenant-color={color}
    >
      {tenantInitials(tenant.name || tenant.slug)}
    </span>
  );
}

/**
 * Scope chip: tile + tenant name. The full chip carries the "Scope" label (page headers); the
 * compact form is for rows and cards. Both expose one accessible name.
 */
export function ScopeChip({
  tenant,
  compact = false,
  path,
}: {
  tenant?: TenantRef | null;
  compact?: boolean;
  /** Slug path from the organisation root; shown as the tooltip (the name stays the label). */
  path?: string | undefined;
}) {
  const t = useT();
  const active = useActiveTenant();
  const value = tenant ?? active;
  if (!value) return null;
  const label = compact
    ? t('tenancy.tenantChip', { tenant: value.name })
    : t('tenancy.scopeChip', { tenant: value.name });
  return (
    <span
      className={compact ? 'scope-chip scope-chip-compact' : 'scope-chip'}
      role="group"
      aria-label={label}
      title={path ? `${label} (${path})` : label}
    >
      <TenantTile tenant={value} small={compact} />
      {compact ? null : (
        <span className="scope-label" aria-hidden="true">
          {t('tenancy.scope')}
        </span>
      )}
      <span className="scope-name" aria-hidden="true">
        {value.name}
      </span>
    </span>
  );
}
