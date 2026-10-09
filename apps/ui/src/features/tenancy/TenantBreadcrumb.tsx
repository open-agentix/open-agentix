import { useQuery } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { meQuery } from '../../auth/auth';
import { useActiveTenant } from '../../components/Tenant';
import { useI18n } from '../../i18n/i18n';
import { NAV } from '../../layout/nav';
import { tenantColorIndex } from '../../lib/tenant';
import { useTenantPath } from './paths';
import { useSwitchableTenants } from './useSwitchableTenants';

/**
 * Tenant path above the page: ancestors (plain text, never links: the API lists no ancestor the
 * user may act in), the acting tenant, then the page. Shown only where tenants can be switched.
 * When the acting tenant is not the home tenant, the row carries the tenant colour as a top
 * border and the label "Acting in …" (colour is never the only signal).
 */
export function TenantBreadcrumb() {
  const { t } = useI18n();
  const tenant = useActiveTenant();
  const switchable = useSwitchableTenants();
  const { data: me } = useQuery(meQuery);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const known = useTenantPath(tenant?.id);
  if (!tenant || switchable.length < 2) return null;

  // Ancestors come from a slug path learned from the API; it must end in this tenant's slug.
  const ancestors = known && known[known.length - 1] === tenant.slug ? known.slice(0, -1) : [];
  const page = NAV.flatMap((g) => g.items)
    .filter((i) =>
      i.to === '/' ? pathname === '/' : pathname === i.to || pathname.startsWith(`${i.to}/`),
    )
    .sort((a, b) => b.to.length - a.to.length)[0];
  const acting = !!me && me.user.tenantId !== tenant.id;
  const color = tenantColorIndex(tenant.id || tenant.slug);

  return (
    <nav
      aria-label={t('tenancy.breadcrumb')}
      className="tenant-crumbs"
      data-acting={acting ? 'true' : undefined}
      style={acting ? { borderTopColor: `var(--tenant-${color}-bg)` } : undefined}
    >
      <ol>
        {ancestors.map((slug) => (
          <li key={slug}>{slug}</li>
        ))}
        <li aria-current={page ? undefined : 'page'}>{tenant.name}</li>
        {page ? <li aria-current="page">{t(page.label)}</li> : null}
      </ol>
      {acting ? (
        <span className="tenant-crumbs-acting">
          {t('tenancy.actingIn', { tenant: tenant.name })}
        </span>
      ) : null}
    </nav>
  );
}
