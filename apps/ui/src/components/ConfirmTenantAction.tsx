import type { ComponentProps } from 'react';
import { useI18n } from '../i18n/i18n';
import { ConfirmDialog } from './ConfirmDialog';
import { TenantTile, useActiveTenant, type TenantRef } from './Tenant';

/**
 * Confirmation for a consequential write (publish, revoke, delete, cancel, approve, run) that
 * names the tenant it acts in, so a platform admin who switched tenants never confirms in the
 * wrong one. Use it instead of `ConfirmDialog` for every write confirmation. `tenant` defaults to
 * the acting tenant; pass the row's tenant when a list shows rows of several tenants.
 */
export function ConfirmTenantAction({
  tenant,
  children,
  ...rest
}: ComponentProps<typeof ConfirmDialog> & { tenant?: TenantRef | null }) {
  const { t } = useI18n();
  const acting = useActiveTenant();
  const target = tenant ?? acting;
  return (
    <ConfirmDialog {...rest}>
      {target ? (
        <p className="confirm-target" data-testid="confirm-target">
          <TenantTile tenant={target} small />
          <span>
            <span className="muted">{t('tenancy.confirmTargetLabel')}: </span>
            <strong>{target.name}</strong>
          </span>
          <span className="sr-only">{t('tenancy.confirmTarget', { tenant: target.name })}</span>
        </p>
      ) : null}
      {children}
    </ConfirmDialog>
  );
}
