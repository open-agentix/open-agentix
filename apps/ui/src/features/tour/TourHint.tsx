import { useState } from 'react';
import { useI18n } from '../../i18n/i18n';
import { requestTour } from './storage';

/** Build-time switch of the demo image (docker-compose.demo.yml); the sign-in page has no API data. */
export function isDemoBuild(): boolean {
  return (import.meta.env.VITE_OAX_DEMO as string | undefined) === 'true';
}

export const DEMO_LOGIN = { username: 'admin@example.org', password: 'demo-password-2026' };

/** Login page, demo only: the shared fake credentials, the nightly reset and the tour link. */
export function TourHint({ onFill }: { onFill: (username: string, password: string) => void }) {
  const { t } = useI18n();
  const [requested, setRequested] = useState(false);
  return (
    <aside className="notice notice-info tour-hint" aria-labelledby="tour-hint-title">
      <p id="tour-hint-title" className="strong">
        {t('tour.hint.title')}
      </p>
      <p>
        {t('tour.hint.credentials')} <code>{DEMO_LOGIN.username}</code> /{' '}
        <code>{DEMO_LOGIN.password}</code>
      </p>
      <p className="muted">{t('tour.hint.reset')}</p>
      <div className="cluster">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => onFill(DEMO_LOGIN.username, DEMO_LOGIN.password)}
        >
          {t('tour.hint.fill')}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            requestTour();
            setRequested(true);
          }}
        >
          {t('tour.launch')}
        </button>
      </div>
      {requested ? (
        <p role="status" className="muted">
          {t('tour.hint.afterSignIn')}
        </p>
      ) : null}
    </aside>
  );
}
