import { Link, Navigate } from '@tanstack/react-router';
import { session } from '../auth/session';
import { EmptyState } from '../components/ui';
import { useT } from '../i18n/i18n';

export function NotFound() {
  const t = useT();
  // Signed-out visitors must not learn anything about the app's routes: send them to the login
  // page. No redirect target is kept, because an unknown path would only lead back to this page.
  if (!session.token()) {
    return <Navigate to="/login" search={{ redirect: undefined, expired: undefined }} replace />;
  }
  return (
    <div className="page">
      <EmptyState
        icon="search"
        title={t('errors.pageNotFound')}
        action={<Link to="/">{t('errors.backHome')}</Link>}
      >
        {t('errors.pageNotFoundText')}
      </EmptyState>
    </div>
  );
}
