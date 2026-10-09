import { useQuery } from '@tanstack/react-query';
import { meQuery } from '../auth/auth';
import { useT } from '../i18n/i18n';
import { tenantColorIndex, tenantInitials } from '../lib/tenant';

export interface TenantRef {
  id: string;
  slug: string;
  name: string;
}

/**
 * The acting tenant from `GET /v1/me`. Shown while the API reports it; once the installation mode
 * exists (issue #156) single-tenant installs can hide all tenant UI here, in one place.
 */
export function useActiveTenant(): TenantRef | null {
  const { data } = useQuery(meQuery);
  return data?.tenant ?? null;
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

/** Active tenant in the shell (top bar on phones, sidebar header on desktop). */
export function TenantBadge({ placement }: { placement: 'top' | 'side' }) {
  const t = useT();
  const tenant = useActiveTenant();
  if (!tenant) return null;
  return (
    <span
      className={`tenant-badge tenant-badge-${placement}`}
      role="group"
      aria-label={t('tenancy.active')}
      title={`${t('tenancy.active')}: ${tenant.name}`}
    >
      <TenantTile tenant={tenant} />
      <span className="tenant-name">{tenant.name}</span>
    </span>
  );
}
