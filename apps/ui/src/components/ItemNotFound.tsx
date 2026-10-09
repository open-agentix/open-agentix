import { Link } from '@tanstack/react-router';
import { isDemoBuild } from '../features/tour/TourHint';
import { useT } from '../i18n/i18n';
import { EmptyState } from './ui';

/**
 * Friendly "gone" view for a run or agent link that no longer resolves. In the demo build it
 * explains the daily reset; in every build it offers the way back to the list.
 */
export function ItemNotFound({ kind }: { kind: 'run' | 'agent' }) {
  const t = useT();
  const demo = isDemoBuild();
  return (
    <div className="item-gone">
      <EmptyState
        icon="search"
        title={t(kind === 'run' ? 'errors.runNotFound' : 'errors.agentNotFound')}
        action={
          kind === 'run' ? (
            <Link to="/runs" search={{}} className="btn btn-primary btn-md">
              {t('errors.backToRuns')}
            </Link>
          ) : (
            <Link to="/agents" className="btn btn-primary btn-md">
              {t('errors.backToAgents')}
            </Link>
          )
        }
      >
        {demo
          ? t('errors.demoReset')
          : t(kind === 'run' ? 'errors.runNotFoundText' : 'errors.agentNotFoundText')}
      </EmptyState>
    </div>
  );
}
