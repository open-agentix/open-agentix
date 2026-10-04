import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { version as uiVersion } from '../../package.json';
import { approvalsQuery } from '../api/queries';
import { logout, meQuery, useCan, versionQuery } from '../auth/auth';
import { session } from '../auth/session';
import { Icon } from '../components/Icon';
import { useI18n } from '../i18n/i18n';
import { TourLauncher } from '../features/tour/TourHost';
import { PreferencesControls } from './PreferencesControls';
import { NAV } from './nav';

export function AppShell() {
  const { t } = useI18n();
  const can = useCan();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data: me } = useQuery(meQuery);
  const { data: apiVersion } = useQuery(versionQuery);
  const { data: pending } = useQuery({ ...approvalsQuery('pending'), enabled: can('runs:read') });
  const pendingCount = pending?.items.length ?? 0;

  useEffect(() => setOpen(false), [pathname]);

  useEffect(
    () =>
      session.subscribe((reason) => {
        if (reason === 'expired') {
          queryClient.clear();
          void navigate({ to: '/login', search: { expired: true, redirect: undefined } });
        }
      }),
    [navigate, queryClient],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const onLogout = async () => {
    await logout(queryClient);
    await navigate({ to: '/login', search: { redirect: undefined, expired: undefined } });
  };

  return (
    <div className={open ? 'shell nav-open' : 'shell'}>
      <a className="skip-link" href="#main">
        {t('nav.skip')}
      </a>
      <header className="topbar">
        <button
          type="button"
          className="icon-btn"
          aria-expanded={open}
          aria-controls="sidebar"
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? t('nav.closeMenu') : t('nav.openMenu')}
        >
          <Icon name={open ? 'close' : 'menu'} />
        </button>
        <Link to="/" className="brand">
          <Logo />
          <span>open-agentix</span>
        </Link>
      </header>
      <aside id="sidebar" className="sidebar">
        <Link to="/" className="brand brand-side">
          <Logo />
          <span>open-agentix</span>
        </Link>
        <nav aria-label={t('nav.main')} className="nav">
          {NAV.map((group) => {
            const items = group.items.filter((i) => !i.perm || can(i.perm));
            if (!items.length) return null;
            return (
              <div key={group.label} className="nav-group">
                <p className="nav-heading">{t(group.label)}</p>
                <ul>
                  {items.map((item) => (
                    <li key={item.to}>
                      <Link
                        to={item.to}
                        data-tour={`nav-${item.to}`}
                        className="nav-link"
                        activeOptions={{ exact: item.to === '/' }}
                        activeProps={{ className: 'nav-link active', 'aria-current': 'page' }}
                      >
                        <Icon name={item.icon} />
                        <span>{t(item.label)}</span>
                        {item.to === '/runs' && pendingCount > 0 ? (
                          <span
                            className="nav-count"
                            aria-label={t('nav.pendingApprovals', { count: pendingCount })}
                          >
                            {pendingCount}
                          </span>
                        ) : null}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <TourLauncher />
          <PreferencesControls />
          {me ? (
            <div className="whoami" data-tour="whoami">
              <span className="avatar" aria-hidden="true">
                {me.user.displayName.slice(0, 1).toUpperCase()}
              </span>
              <span className="whoami-text">
                <span className="whoami-name">{me.user.displayName}</span>
                <span className="whoami-roles">{me.bindings.map((b) => b.role).join(', ')}</span>
              </span>
              <button
                type="button"
                className="icon-btn"
                onClick={onLogout}
                aria-label={t('nav.logout')}
                title={t('nav.logout')}
              >
                <Icon name="logout" />
              </button>
            </div>
          ) : null}
          <p className="version">
            {t('nav.version', { ui: uiVersion, api: apiVersion?.version ?? '…' })}
          </p>
        </div>
      </aside>
      <div className="scrim" aria-hidden="true" onClick={() => setOpen(false)} />
      <main id="main" className="main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}

export function Logo() {
  return (
    <svg width="24" height="24" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="var(--accent-bg)" />
      <path
        d="M9 21l7-12 7 12M12 17h8"
        stroke="var(--accent-fg)"
        strokeWidth="2.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
