import { TenantTile, useActiveTenant } from '../../components/Tenant';
import { useT } from '../../i18n/i18n';
import { TenantSwitcher } from './TenantSwitcher';
import { useSwitchableTenants } from './useSwitchableTenants';

/**
 * Active tenant in the shell (top bar on phones, sidebar header on desktop). With two or more
 * tenants to act in it is the tenant switcher; with one it stays the static tile.
 */
export function TenantBadge({ placement }: { placement: 'top' | 'side' }) {
  const t = useT();
  const tenant = useActiveTenant();
  const switchable = useSwitchableTenants();
  if (!tenant) return null;
  if (switchable.length > 1) return <TenantSwitcher placement={placement} tenant={tenant} />;
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
