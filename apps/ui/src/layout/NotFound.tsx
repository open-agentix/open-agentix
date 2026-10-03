import { Link } from '@tanstack/react-router';
import { EmptyState } from '../components/ui';
import { useT } from '../i18n/i18n';

export function NotFound() {
  const t = useT();
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
