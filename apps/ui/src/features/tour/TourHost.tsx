import { useQuery } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { settingsQuery } from '../../auth/auth';
import { Icon } from '../../components/Icon';
import { useI18n } from '../../i18n/i18n';
import { isDismissed, markAutoStarted, takeTourRequest, wasAutoStarted } from './storage';

// The tour itself is a separate chunk: the initial bundle only carries this small launcher.
const TourDialog = lazy(() => import('./TourDialog'));

/** True when the visitor should see the tour on their own (first landing, not dismissed). */
export function shouldAutoStart(opts: {
  demo: boolean;
  pathname: string;
  dismissed: boolean;
  alreadyStarted: boolean;
}): boolean {
  return opts.demo && opts.pathname === '/' && !opts.dismissed && !opts.alreadyStarted;
}

/**
 * Demo only: the persistent "Take the tour" entry, the auto-start after the first landing and
 * the (lazy) tour dialog. Renders nothing outside demo mode.
 */
export function TourLauncher() {
  const { t } = useI18n();
  const { data: settings } = useQuery(settingsQuery);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [active, setActive] = useState(false);
  const demo = settings?.demo === true;

  useEffect(() => {
    if (!demo) return;
    // Asked for on the login page: start right after sign-in, wherever the visitor lands.
    if (takeTourRequest()) {
      markAutoStarted();
      setActive(true);
      return;
    }
    if (
      shouldAutoStart({
        demo,
        pathname,
        dismissed: isDismissed(),
        alreadyStarted: wasAutoStarted(),
      })
    ) {
      markAutoStarted();
      setActive(true);
    }
  }, [demo, pathname]);

  const close = useCallback(() => setActive(false), []);

  if (!demo) return null;
  return (
    <>
      <button
        type="button"
        className="btn btn-secondary btn-sm btn-block"
        data-tour="tour-launcher"
        onClick={() => setActive(true)}
      >
        <Icon name="info" size={16} />
        {t('tour.launch')}
      </button>
      {active ? (
        <Suspense fallback={null}>
          <TourDialog onClose={close} />
        </Suspense>
      ) : null}
    </>
  );
}
