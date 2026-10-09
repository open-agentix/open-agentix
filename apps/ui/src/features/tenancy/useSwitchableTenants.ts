import { useQuery } from '@tanstack/react-query';
import { tenantsQuery } from '../../api/queries';
import { meQuery } from '../../auth/auth';
import { session } from '../../auth/session';

export interface SwitchableTenant {
  id: string;
  slug: string;
  name: string;
}

/**
 * Tenants the principal may act in, as the API reports them (`GET /v1/tenants`). Empty while
 * loading or when signed out; the switcher appears only for two or more.
 */
export function useSwitchableTenants(): SwitchableTenant[] {
  const signedIn = !!session.token();
  const { data: me } = useQuery({ ...meQuery, enabled: signedIn });
  const { data } = useQuery({ ...tenantsQuery, enabled: signedIn && !!me });
  return (data?.items ?? []).map((t) => ({ id: t.id, slug: t.slug, name: t.name }));
}
