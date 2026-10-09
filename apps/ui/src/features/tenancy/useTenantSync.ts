import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useToast } from '../../components/toast';
import { useI18n } from '../../i18n/i18n';
import { activeTenant } from '../../lib/activeTenant';
import { forgetTenantPaths } from './paths';

/**
 * Keeps cached data and the acting tenant in step (mounted once, in the app shell).
 *
 * On a switch (or when the API refused a stale choice and the client fell back to the home
 * tenant) every in-flight request is cancelled, so a late answer of the previous tenant is never
 * stored, and every cached query is reset to its initial state: no row of the previous tenant
 * stays in memory or on screen, and mounted queries load again under the new `X-OAX-Tenant`.
 * Only the list of switchable tenants survives; it belongs to the user, not to a tenant.
 */
export function useTenantSync(): void {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { t } = useI18n();
  useEffect(() => {
    // The fallback can happen while the app loads, before this hook is mounted.
    if (activeTenant.takeStaleNotice()) toast.error(t('tenancy.switcher.stale'));
    return activeTenant.subscribe((reason) => {
      if (reason === 'reset') {
        forgetTenantPaths();
        return;
      }
      void (async () => {
        await queryClient.cancelQueries();
        await queryClient.resetQueries({ predicate: (q) => q.queryKey[0] !== 'tenants' });
      })();
      if (reason === 'stale' && activeTenant.takeStaleNotice())
        toast.error(t('tenancy.switcher.stale'));
    });
  }, [queryClient, toast, t]);
}
